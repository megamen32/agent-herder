import {describe,it,expect,vi} from 'vitest';
import {FleetBrowserIntent} from '../src/web-ui/fleet/intent.js';
describe('browser fleet creation no replay (fast unit; expected 1s, maximum 10s)',()=>{
 const request={hostId:'88',harness:'codex' as const,name:'n',cwd:'/work',inputId:'stable'};
 function storage(){const map=new Map<string,string>();return {getItem:(k:string)=>map.get(k)??null,setItem:(k:string,v:string)=>{map.set(k,v);},removeItem:(k:string)=>{map.delete(k);}};}
 it('pending intent survives unmount/reload, blocks a new ID and cannot be cleared by a foreign receipt',()=>{
  const s=storage();new FleetBrowserIntent(s,'a'.repeat(64)).begin(request);
  const reloaded=new FleetBrowserIntent(s,'a'.repeat(64));expect(reloaded.load()?.request).toEqual(request);
  expect(()=>reloaded.begin({...request,inputId:'new'})).toThrow();expect(()=>reloaded.finish({state:'created',inputId:'other',retryable:false})).toThrow();
  expect(reloaded.load()?.receipt.state).toBe('unknown');
 });
 it('another authenticated scope does not inherit pending state; confirmed creation clears ONLY its own scope',()=>{
  const s=storage(),first=new FleetBrowserIntent(s,'a'.repeat(64)),second=new FleetBrowserIntent(s,'b'.repeat(64));first.begin(request);expect(second.load()).toBeNull();second.begin(request);first.finish({state:'created',inputId:'stable',retryable:false});expect(first.load()).toBeNull();expect(second.load()).not.toBeNull();
 });
 it('storage failure rejects begin before the caller can submit a mutation',()=>{
  const store=new FleetBrowserIntent({...storage(),setItem:vi.fn(()=>{throw new Error('quota');})},'a'.repeat(64));expect(()=>store.begin(request)).toThrow('quota');
 });
});
