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
 it('only explicit archiving releases the active intent and preserves its original UNKNOWN in the same scope',()=>{
  const s=storage(),store=new FleetBrowserIntent(s,'a'.repeat(64));store.begin(request);
  expect(()=>store.begin({...request,inputId:'new'})).toThrow();store.archiveUnknown();expect(store.load()).toBeNull();
  const history=JSON.parse(s.getItem('herder:fleet:create:'+'a'.repeat(64)+':unknown-history')!);
  expect(history).toEqual([{request,receipt:{state:'unknown',inputId:'stable',retryable:false}}]);
  expect(new FleetBrowserIntent(s,'a'.repeat(64)).archivedUnknown()).toEqual(history);
  expect(new FleetBrowserIntent(s,'b'.repeat(64)).archivedUnknown()).toEqual([]);
  const next={...request,hostId:'44',inputId:'new'};store.begin(next);expect(store.load()?.request).toEqual(next);
  expect(new FleetBrowserIntent(s,'b'.repeat(64)).load()).toBeNull();
 });
 it('an archived input cannot silently absorb a different active request with the same ID',()=>{
  const s=storage(),store=new FleetBrowserIntent(s,'a'.repeat(64));store.begin(request);store.archiveUnknown();
  store.begin({...request,hostId:'44'});expect(()=>store.archiveUnknown()).toThrow();
  expect(store.load()?.request.hostId).toBe('44');expect(store.archivedUnknown()[0]?.request.hostId).toBe('88');
 });
 it('failed archive write keeps the active UNKNOWN locked',()=>{
  const s=storage(),store=new FleetBrowserIntent(s,'a'.repeat(64));store.begin(request);
  s.setItem=vi.fn(()=>{throw new Error('quota');});expect(()=>store.archiveUnknown()).toThrow('quota');
  expect(store.load()?.request).toEqual(request);expect(()=>store.begin({...request,inputId:'new'})).toThrow();
 });
 it('failed removal keeps the active intent, and a later explicit archive never duplicates it',()=>{
  const s=storage(),remove=s.removeItem,store=new FleetBrowserIntent(s,'a'.repeat(64));store.begin(request);
  s.removeItem=vi.fn(()=>{throw new Error('remove failed');});expect(()=>store.archiveUnknown()).toThrow('remove failed');expect(store.load()?.receipt.state).toBe('unknown');
  s.removeItem=remove;store.archiveUnknown();expect(JSON.parse(s.getItem('herder:fleet:create:'+'a'.repeat(64)+':unknown-history')!).length).toBe(1);
 });
});
