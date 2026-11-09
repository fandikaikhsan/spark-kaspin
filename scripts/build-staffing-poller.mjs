// Build the existing manually deployed worker.handler only. No cloud calls.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, '.aws-sam/staffing-poller'), code = resolve(out, 'code');
rmSync(out, { recursive: true, force: true }); mkdirSync(code, { recursive: true });
const outfile = resolve(code, 'worker.js');
const result = await build({ absWorkingDir: root, entryPoints: ['aws/lambda/worker.ts'], outfile, bundle: true, platform: 'node', target: 'node22', format: 'cjs', minify: true, sourcemap: false, metafile: true });
for (const input of Object.keys(result.metafile.inputs)) if (/^\.env(?:\.|$)/.test(basename(input)) || /^(api\.json|samconfig.*\.toml|credentials)$/.test(basename(input))) throw Error('Private configuration must not be an artifact input.');
const zip = resolve(out, 'worker.zip'); execFileSync('zip', ['-q', '-j', zip, outfile]);
const manifest = { handler: 'worker.handler', runtime: 'nodejs22.x', files: ['worker.js'], codeSha256: createHash('sha256').update(readFileSync(zip)).digest('base64'), bytes: readFileSync(zip).length, lockfileSha256: createHash('sha256').update(readFileSync(resolve(root, 'pnpm-lock.yaml'))).digest('hex'), networkCalls: false };
writeFileSync(resolve(out, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ artifact: zip, ...manifest }, null, 2));
