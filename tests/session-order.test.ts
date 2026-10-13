import {describe,it,expect} from 'vitest';
import {filterAndArrangeSessions,sampleSessionActivity,sessionListRefreshDelay,sessionKey, type SessionListSession, type SessionListSettings} from '../src/web-ui/session-list.js';
import {sidebarEntries,sessionPinKey} from '../src/web-ui/session-pins.js';
import {compactSession} from '../src/mesh/protocol.js';
import {projectPeerSession} from '../src/mesh/gptadmin.js';
import {directorySession} from '../src/web-ui/fleet/session-directory.js';

const settings:SessionListSettings={cwd:'',project:'',harness:'',sort:'created',showAll:true};
const row=(id:string,createdAt?:string):SessionListSession=>({id,harness:'codex',hostId:'100',title:id,cwd:'/project',status:'idle',lastActivity:'2026-10-13T10:00:00Z',meta:{createdAt}});
const ids=(rows:SessionListSession[], sort:SessionListSettings['sort']='created',sample?:ReadonlyMap<string,string>)=>filterAndArrangeSessions(rows,{...settings,sort},new Set(),new Set(),sample).map(e=>e.session.id);

describe('stable sidebar order (fast unit; expected2s/emergency20s)',()=>{
 it('newest creation first, with no movement on agent progress or status changes',()=>{
  const old=row('old','2026-10-10T00:00:00Z'),fresh=row('fresh','2026-10-13T00:00:00Z');
  expect(ids([old,fresh])).toEqual(['fresh','old']);
  old.lastActivity='2026-10-14T00:00:00Z';old.status='running';
  expect(ids([old,fresh])).toEqual(['fresh','old']);
  expect(ids([old,fresh],'activity')).toEqual(['old','fresh']);
 });
 it('missing or malformed creation does not borrow mutable activity; ties use full native address',()=>{
  const unknown=row('unknown'),invalid=row('invalid','not-a-date'),known=row('known','2026-10-01T00:00:00Z');
  const before=ids([unknown,known,invalid]);unknown.lastActivity='2099-01-01T00:00:00Z';
  expect(ids([unknown,known,invalid])).toEqual(before);expect(before[0]).toBe('known');
  const one={...known,remote:true,hostId:'44'},two={...known,remote:true,hostId:'88'};
  expect(filterAndArrangeSessions([two,one],settings,new Set()).map(e=>sessionKey(e.session))).toEqual([sessionKey(one),sessionKey(two)]);
 });
 it('activity changes wait for a sample; a new session is visible immediately; deleted keys are released',()=>{
  const a=row('a'),b=row('b');b.lastActivity='2026-10-13T11:00:00Z';
  const first=sampleSessionActivity(new Map(),[a,b]);a.lastActivity='2026-10-13T12:00:00Z';
  expect(sampleSessionActivity(first,[a,b])).toBe(first);
  expect(ids([a,b],'activity',first)).toEqual(['b','a']);
  expect(ids([a,b],'activity',sampleSessionActivity(first,[a,b],true))).toEqual(['a','b']);
  const c=row('c');c.lastActivity='2026-10-13T13:00:00Z';
  expect(ids([a,b,c],'activity',sampleSessionActivity(first,[a,b,c]))).toEqual(['c','b','a']);
  expect(sampleSessionActivity(first,[a]).has(sessionKey(b))).toBe(false);
 });
 it('pins keep their own order and children remain under the parent',()=>{
  const parent=row('parent','2026-10-10T00:00:00Z'),child={...row('child','2026-10-13T00:00:00Z'),meta:{createdAt:'2026-10-13T00:00:00Z',parentSessionKey:'codex:parent'}},fresh=row('fresh','2026-10-12T00:00:00Z');
  expect(ids([parent,child,fresh])).toEqual(['fresh','parent','child']);
  expect(sidebarEntries([parent,child,fresh],settings,new Set(),new Set(),'', [sessionPinKey(parent)!]).map(e=>e.session.id)).toEqual(['parent','fresh','child']);
 });
 it('coalesces event reads until 30 seconds while explicit refresh can use the existing reader',()=>{
  expect(sessionListRefreshDelay(10_000,15_000)).toBe(25_000);
  expect(sessionListRefreshDelay(10_000,40_000)).toBe(0);
  expect(sessionListRefreshDelay(40_000,40_001)).toBe(29_999);
 });
 it('creation evidence survives the actual mesh projection and directory row without changing address',()=>{
  const session=row('one','2026-10-13T09:00:00Z');
  const projected=projectPeerSession(compactSession('44',session),'44')!;
  expect(projected.createdAt).toBe(session.meta!.createdAt);
  const directory=directorySession(projected,{hostId:'44',label:'44'} as any,'100');
  expect(directory.createdAt).toBe(session.meta!.createdAt);
  expect(sessionKey(directory)).toBe('mesh:["44","codex","one"]');
  expect(projectPeerSession({...projected,createdAt:'bad'},'44')!.createdAt).toBeUndefined();
 });
});
