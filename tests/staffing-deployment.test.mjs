import { describe, expect, it } from 'vitest';
import { environmentUpdate } from '../scripts/prepare-staffing-poller-update.mjs';
const previous={SUPABASE_URL:'https://db.example',SUPABASE_SECRET_KEY:'existing-private-key',TOKEN:'pos-access',REFRESH_TOKEN:'pos-refresh',TELEGRAM_BOT_TOKEN:'100:pos-bot',CUSTOM_SETTING:'keep-me'};
const current={FunctionName:'spark-kaspin-pos-poller',Handler:'worker.handler',Runtime:'nodejs22.x',State:'Active',LastUpdateStatus:'Successful',RevisionId:'original-revision',Environment:{Variables:previous}};
const local={SUPABASE_URL:'https://db.example',STAFFING_TELEGRAM_BOT_TOKEN:'200:staff-bot'};
describe('prepare a local update of the existing manual POS Lambda',()=>{
 it('preserves every existing setting and the revision guard, adding only the Staffing token',()=>{
  const result=environmentUpdate(current,local,current.FunctionName);
  expect(result.Environment.Variables).toEqual({...previous,STAFFING_TELEGRAM_BOT_TOKEN:'200:staff-bot'});expect(result.RevisionId).toBe('original-revision');expect(previous).not.toHaveProperty('STAFFING_TELEGRAM_BOT_TOKEN');
  expect(Object.keys(result).sort()).toEqual(['Environment','FunctionName','RevisionId']);
 });
 it('refuses a different function, handler, runtime or database',()=>{
  for(const change of[{FunctionName:'other'},{Handler:'index.handler'},{Runtime:'nodejs20.x'},{Environment:{Variables:{...previous,SUPABASE_URL:'https://other.example'}}}])expect(()=>environmentUpdate({...current,...change},local,current.FunctionName)).toThrow();
 });
 it('refuses concurrent updates and reused bot identities',()=>{
  expect(()=>environmentUpdate({...current,LastUpdateStatus:'InProgress'},local,current.FunctionName)).toThrow();
  expect(()=>environmentUpdate(current,{...local,STAFFING_TELEGRAM_BOT_TOKEN:'100:rotated-pos-bot'},current.FunctionName)).toThrow();
 });
});
