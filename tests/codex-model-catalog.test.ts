import {describe,it,expect,vi} from 'vitest';
import {CodexAppServerAdapter} from '../src/adapters/codex-app-server.js';

describe('native Codex model discovery',()=>{
 function fake(pages:unknown[]){
  const adapter=new CodexAppServerAdapter();
  const ready=vi.spyOn(adapter as any,'ensureReady').mockResolvedValue(undefined);
  const request=vi.spyOn(adapter as any,'request');
  for(const p of pages)request.mockResolvedValueOnce(p);
  return {adapter,ready,request};
 }
 it('reads the native current catalog instead of legacy o4-mini constants',async()=>{
  const f=fake([{data:[{id:'luna-ui',model:'gpt-6-luna',isDefault:false},{id:'sol-ui',model:'gpt-6.1-sol',isDefault:true},{model:'hidden',hidden:true}],nextCursor:null}]);
  expect(await f.adapter.listModels()).toEqual(['gpt-6.1-sol','gpt-6-luna']);
  expect(f.request).toHaveBeenCalledWith('model/list',{limit:100,includeHidden:false});
 });
 it('follows opaque cursors and removes duplicates',async()=>{
  const f=fake([{data:[{model:'luna'}],nextCursor:'p2'},{data:[{model:'luna'},{model:'sol',isDefault:true}],nextCursor:null}]);
  expect(await f.adapter.listModels()).toEqual(['sol','luna']);
  expect(f.request).toHaveBeenLastCalledWith('model/list',{limit:100,includeHidden:false,cursor:'p2'});
 });
 it('does not mask malformed or failed discovery as the obsolete catalog',async()=>{
  const f=fake([{data:null}]);await expect(f.adapter.listModels()).rejects.toThrow(/catalog/i);
  const g=fake([]);g.request.mockRejectedValueOnce(new Error('transport unavailable'));
  await expect(g.adapter.listModels()).rejects.toThrow('transport unavailable');
 });
 it('bounds a repeated pagination cursor',async()=>{
  const f=fake([{data:[],nextCursor:'repeat'},{data:[],nextCursor:'repeat'}]);
  await expect(f.adapter.listModels()).rejects.toThrow(/cursor/i);
 });
 it('retains an explicit configured model override for existing callers',async()=>{
  const adapter=new CodexAppServerAdapter({modelIds:['gpt-test','gpt-test-2']});
  expect(await adapter.listModels()).toEqual(['gpt-test','gpt-test-2']);
 });
});

describe('model actually submitted to native Codex inference',()=>{
 it('does not overwrite a selected model with the prior archive model at preflight',async()=>{
  const adapter=new CodexAppServerAdapter();
  vi.spyOn(adapter as any,'ensureReady').mockResolvedValue(undefined);
  vi.spyOn(adapter,'getSession').mockResolvedValue({id:'turn-model-proof',harness:'codex',title:'read-only test',cwd:process.cwd(),status:'idle',lastActivity:new Date().toISOString(),needsPermission:false,model:'prior-luna'});
  vi.spyOn(adapter,'resumeSession').mockResolvedValue({ok:true});
  const request=vi.spyOn(adapter as any,'request').mockResolvedValue({turn:{id:'new-turn',status:'inProgress'}});
  const result=await adapter.sendMessage('turn-model-proof',{message:'test only',model:'selected-sol',origin:'human',queue:true} as any);
  expect(result.ok).toBe(true);
  expect(request).toHaveBeenCalledWith('turn/start',expect.objectContaining({model:'selected-sol'}));
 });
});
