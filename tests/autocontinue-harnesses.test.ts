import {describe,expect,it} from 'vitest';
import {loadAutocontinueHarnesses,saveAutocontinueHarness,AUTOCONTINUE_HARNESS_IDS} from '../src/web-ui/autocontinue-harnesses.js';

// Fast unit expected <1s/max3s: actual settings requests, no native input or live policy writes.
describe('independent recovery settings for every supported harness',()=>{
 it('loads all eight existing API settings without substituting another harness',async()=>{
  const calls:string[]=[];
  const result=await loadAutocontinueHarnesses(async(path)=>{
   calls.push(path);const harness=path.split('/').at(-1)!;
   return {harness,enabled:harness==='hermes',source:'harness'} as any;
  });
  expect(calls).toHaveLength(8);
  expect(Object.keys(result.settings)).toEqual([...AUTOCONTINUE_HARNESS_IDS]);
  expect(result.settings.hermes?.enabled).toBe(true);
  expect(result.settings.opencode?.enabled).toBe(false);
  expect(result.failed).toEqual([]);
 });
 it('keeps seven real responses when one settings endpoint fails',async()=>{
  const result=await loadAutocontinueHarnesses(async(path)=>{
   const harness=path.split('/').at(-1)!;
   if(harness==='qoder')throw new Error('unavailable');
   return {harness,enabled:true,source:'global'} as any;
  });
  expect(Object.keys(result.settings)).toHaveLength(7);
  expect(result.settings.qoder).toBeUndefined();
  expect(result.failed).toEqual(['qoder']);
 });
 it('changes only the selected harness using its existing PUT',async()=>{
  const calls:any[]=[];
  const saved=await saveAutocontinueHarness(async(path,init)=>{
   calls.push({path,...init});return {harness:'hermes',enabled:false,source:'harness'} as any;
  },'hermes',false);
  expect(calls).toEqual([{path:'/api/session-autostart/harnesses/hermes',method:'PUT',body:'{"enabled":false}'}]);
  expect(saved.harness).toBe('hermes');
 });
 it('does not apply a response belonging to another harness',async()=>{
  await expect(saveAutocontinueHarness(async()=>({harness:'codex',enabled:false,source:'harness'} as any),'hermes',false)).rejects.toThrow('среды');
 });
});
