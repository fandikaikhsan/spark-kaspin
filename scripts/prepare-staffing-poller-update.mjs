// Read AWS configuration, prepare a local review/rollback package. Never deploys.
import { readFileSync, writeFileSync, mkdtempSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export function environmentUpdate(current, local, expectedName) {
  const previous = current.Environment?.Variables;
  const token = local.STAFFING_TELEGRAM_BOT_TOKEN?.trim();
  if (current.FunctionName !== expectedName || current.Handler !== 'worker.handler' || current.Runtime !== 'nodejs22.x') throw Error('Function identity, handler or runtime differs from the reviewed POS target.');
  if (current.State !== 'Active' || current.LastUpdateStatus !== 'Successful' || !current.RevisionId) throw Error('Wait for the current Lambda update to complete before preparing another update.');
  if (!previous || !previous.SUPABASE_URL || previous.SUPABASE_URL.replace(/\/$/,'') !== local.SUPABASE_URL?.trim().replace(/\/$/,'')) throw Error('The Lambda database does not match the configured dashboard database.');
  if (!(previous.SUPABASE_SECRET_KEY || previous.SUPABASE_SERVICE_ROLE_KEY)) throw Error('Existing Lambda database credentials are incomplete.');
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw Error('A valid Staffing bot token is required in the local environment.');
  if (previous.TELEGRAM_BOT_TOKEN && previous.TELEGRAM_BOT_TOKEN.split(':')[0] === token.split(':')[0]) throw Error('Staffing and POS must use different bot identities.');
  return { FunctionName: expectedName, RevisionId: current.RevisionId, Environment: { Variables: { ...previous, STAFFING_TELEGRAM_BOT_TOKEN: token } } };
}
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const hash = bytes => createHash('sha256').update(bytes).digest('base64');

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const args = process.argv.slice(2); let name, region, profile = 'default', prepare = false, envFile = resolve(root, '.env');
    for (let i=0;i<args.length;i++) {
      if(args[i]==='--function')name=args[++i];else if(args[i]==='--region')region=args[++i];else if(args[i]==='--profile')profile=args[++i];else if(args[i]==='--env')envFile=resolve(args[++i]);else if(args[i]==='--prepare')prepare=true;else throw Error('Unknown argument.');
    }
    if(!name||!region||!profile||!/^[-A-Za-z0-9_]+$/.test(name)||!/^[-a-z0-9]+$/.test(region))throw Error('Provide the reviewed --function and --region (optionally --profile, --env, --prepare).');
    const common=['--region',region,'--profile',profile,'--no-cli-pager','--cli-connect-timeout','5','--cli-read-timeout','15'];
    function aws(command){const r=spawnSync('aws',[...command,...common,'--output','json'],{encoding:'utf8',timeout:30000,env:{...process.env,AWS_MAX_ATTEMPTS:'1'}});if(r.status!==0)throw Error('AWS read failed. Verify login, profile, region and access; no AWS resources were changed.');return r.stdout.trim()?JSON.parse(r.stdout):{};}
    const current=aws(['lambda','get-function-configuration','--function-name',name]);
    const local=parseEnv(readFileSync(envFile,'utf8'));
    const patch=environmentUpdate(current,local,name);
    const artifact=resolve(root,'.aws-sam/staffing-poller/worker.zip'),bytes=readFileSync(artifact);
    const manifest=JSON.parse(readFileSync(resolve(root,'.aws-sam/staffing-poller/build-manifest.json'),'utf8'));
    if(manifest.handler!=='worker.handler'||manifest.codeSha256!==hash(bytes))throw Error('Rebuild and verify the poller artifact before preparing deployment.');
    const review={function:name,region,profile,handler:current.Handler,runtime:current.Runtime,memory:current.MemorySize,architecture:current.Architectures,existingEnvironmentPreserved:true,updatedEnvironmentKeys:['STAFFING_TELEGRAM_BOT_TOKEN'],oldCodeSha256:current.CodeSha256,newCodeSha256:hash(bytes),artifact,cloudChanges:false};
    if(prepare){
      const original=aws(['lambda','get-function','--function-name',name]);
      if(original.Configuration?.RevisionId!==current.RevisionId)throw Error('The function changed while preparing the backup. Recheck before continuing.');
      let response;try{response=await fetch(original.Code.Location,{redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw Error('Could not download the private rollback artifact. No AWS resources were changed.');}
      if(!response.ok)throw Error('Rollback artifact download failed.');
      const backup=Buffer.from(await response.arrayBuffer());if(hash(backup)!==current.CodeSha256)throw Error('Rollback artifact hash does not match the reviewed function.');
      const directory=mkdtempSync(join(tmpdir(),'spark-staffing-update-'));chmodSync(directory,0o700);
      const save=(file,data)=>writeFileSync(join(directory,file),data,{mode:0o600});
      save('environment-update.json',JSON.stringify(patch));save('environment-before.json',JSON.stringify({FunctionName:name,Environment:{Variables:current.Environment.Variables}}));
      save('worker-before.zip',backup);save('worker-after.zip',bytes);
      const base=['aws','lambda'];const cli=(command)=>[...base,...command,...common].map(quote).join(' ');
      const updateEnv=cli(['update-function-configuration','--cli-input-json','file://'+join(directory,'environment-update.json'),'--query','{FunctionName:FunctionName,LastUpdateStatus:LastUpdateStatus}']);
      const wait=cli(['wait','function-updated-v2','--function-name',name]);
      const revision=cli(['get-function-configuration','--function-name',name,'--query','RevisionId','--output','text']);
      const updateCode=cli(['update-function-code','--function-name',name,'--zip-file','fileb://'+join(directory,'worker-after.zip'),'--query','{FunctionName:FunctionName,CodeSha256:CodeSha256}']);
      save('apply.sh',`#!/usr/bin/env bash\nset -euo pipefail\n${updateEnv}\n${wait}\nSTAFFING_POLLER_REVISION=$(${revision})\n${updateCode} --revision-id "$STAFFING_POLLER_REVISION"\n${wait}\n`);
      const restoreCode=cli(['update-function-code','--function-name',name,'--zip-file','fileb://'+join(directory,'worker-before.zip'),'--query','{FunctionName:FunctionName,CodeSha256:CodeSha256}']);
      const restoreEnv=cli(['update-function-configuration','--cli-input-json','file://'+join(directory,'environment-before.json'),'--query','{FunctionName:FunctionName,LastUpdateStatus:LastUpdateStatus}']);
      save('rollback.sh',`#!/usr/bin/env bash\nset -euo pipefail\nSTAFFING_POLLER_REVISION=$(${revision})\n${restoreCode} --revision-id "$STAFFING_POLLER_REVISION"\n${wait}\nSTAFFING_POLLER_REVISION=$(${revision})\n${restoreEnv} --revision-id "$STAFFING_POLLER_REVISION"\n${wait}\n`);
      review.privatePackage=directory;save('review.json',JSON.stringify(review,null,2)+'\n');
    }
    console.log(JSON.stringify(review,null,2));
  }catch(error){console.error(error instanceof Error?error.message:'Could not prepare the update.');process.exitCode=1;}
}
