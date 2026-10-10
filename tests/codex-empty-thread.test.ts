import {describe,it,expect,vi} from 'vitest';
import {CodexAppServerAdapter} from '../src/adapters/codex-app-server.js';
// Fast unit: native metadata / absent-rollout discrimination, expected1s/max120s.
// These local boundaries do not prove deployment; same-ID88 native readback is the release gate.
const missing=()=>Object.assign(new Error('rollout not created'),{code:'ENOENT'});
function fixture(thread:Record<string,unknown>|undefined={id:'empty',cwd:'/workspace',name:'Empty',status:{type:'idle'},turns:[]}){
 const adapter=new CodexAppServerAdapter({socketPath:'/not-connected-unit-socket'});
 const internals=adapter as any;
 vi.spyOn(internals,'ensureReady').mockResolvedValue(undefined);
 vi.spyOn(internals,'request').mockImplementation(async(method:unknown)=>method==='thread/turns/list'?{data:[]}:{thread});
 vi.spyOn(internals.rawTranscriptAdapter,'getSessionObservation').mockRejectedValue(missing());
 vi.spyOn(internals.rawTranscriptAdapter,'getSession').mockRejectedValue(missing());
 vi.spyOn(internals.rawTranscriptAdapter,'getSessionMessages').mockRejectedValue(missing());
 return {adapter,internals};
}
describe('empty native Codex threads',()=>{
 it('retains freshly verified native session when rollout has not been created',async()=>{
  const {adapter}=fixture();const result=await adapter.getSession('empty',{includeMetrics:true});
  expect(result).toMatchObject({id:'empty',harness:'codex',cwd:'/workspace',title:'Empty',status:'idle'});
 });
 it('does not fabricate a missing native session from an absent rollout',async()=>{
  const {adapter,internals}=fixture();internals.request.mockResolvedValue({});
  await expect(adapter.getSession('empty')).rejects.toMatchObject({code:'ENOENT'});
 });
 it('preserves actual permission errors even with native metadata',async()=>{
  const {adapter,internals}=fixture();internals.rawTranscriptAdapter.getSessionObservation.mockRejectedValue(Object.assign(new Error('denied'),{code:'EACCES'}));
  await expect(adapter.getSession('empty')).rejects.toMatchObject({code:'EACCES'});
 });
 it('returns an empty history only after exact native thread reports zero turns',async()=>{
  const {adapter,internals}=fixture();await expect(adapter.getSessionMessages('empty')).resolves.toEqual([]);
  expect(internals.request).toHaveBeenCalledWith('thread/read',{threadId:'empty',includeTurns:true});
 });
 it('does not hide missing history of a thread that has turns',async()=>{
  const {adapter}=fixture({id:'empty',cwd:'/workspace',status:{type:'idle'},turns:[{id:'old'}]});
  await expect(adapter.getSessionMessages('empty')).rejects.toMatchObject({code:'ENOENT'});
 });
 it('rejects wrong native identity for an empty-history fallback',async()=>{
  const {adapter}=fixture({id:'other',turns:[]});await expect(adapter.getSessionMessages('empty')).rejects.toMatchObject({code:'ENOENT'});
 });
});
