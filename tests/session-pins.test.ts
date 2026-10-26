import {describe, it, expect} from 'vitest';
import {readSessionPins, readSessionPinState, sessionPinStorage, toggleSessionPin, sessionPinKey, sidebarEntries, sidebarContext, projectLocalSessionHost} from '../src/web-ui/session-pins.js';
import type {SessionListSession} from '../src/web-ui/session-list.js';
import {directorySession} from '../src/web-ui/fleet/session-directory.js';

const row = (id:string, extra:Partial<SessionListSession> = {}):SessionListSession => ({id, harness:'codex', hostId:'roomhacker-server-100', title:id, cwd:'/project', status:'idle', lastActivity:'2026-10-13T12:00:00Z', ...extra});
const settings = {hostId:'', cwd:'', project:'', harness:'', sort:'activity' as const, showAll:true};
const storage = () => {const values = new Map<string,string>();return {getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};};

describe('personal session pins (fast unit; expected2s/max20s)', () => {
 it('preserves native local host identity while the fleet directory is empty or disagrees', () => {
  const native = row('native-session',{hostId:'roomhacker-server-100',hostLabel:'Сервер 100'});
  const waiting = projectLocalSessionHost(native,'',[ ]);
  expect(waiting.hostId).toBe('roomhacker-server-100');
  expect(waiting.hostLabel).toBe('Сервер 100');
  expect(sessionPinKey(waiting)).toBeDefined();

  const matched = projectLocalSessionHost(row('fallback',{hostId:undefined}), 'server-100', [
   {hostId:'server-100',label:'Сервер 100'},
   {hostId:'MacBook-Pro-User.local',label:'Mac M1'},
  ]);
  expect(matched.hostId).toBe('server-100');
  expect(matched.hostLabel).toBe('Сервер 100');

  const conflicting = projectLocalSessionHost(row('remote-native',{hostId:'MacBook-Pro-User.local',hostLabel:'Mac M1',remote:true}), 'server-100', [
   {hostId:'server-100',label:'Сервер 100'},
   {hostId:'MacBook-Pro-User.local',label:'Mac M1'},
  ]);
  expect(conflicting.hostId).toBe('MacBook-Pro-User.local');
  expect(conflicting.hostLabel).toBe('Mac M1');

  const unknown = projectLocalSessionHost(row('unknown',{hostId:undefined}), undefined, []);
  expect(unknown.hostId).toBeUndefined();
  expect(sessionPinKey(unknown)).toBeUndefined();
 });
 it('persists through reload and does not cross account scopes', () => {
  const s=storage(),key=sessionPinKey(row('one'))!;
  expect(toggleSessionPin(s,'owner-A',key)).toEqual([key]);
  expect(readSessionPins(s,'owner-A')).toEqual([key]);
  expect(readSessionPins(s,'owner-B')).toEqual([]);
  expect(toggleSessionPin(s,'owner-B',sessionPinKey(row('two'))!)).toHaveLength(1);
  expect(readSessionPins(s,'owner-A')).toEqual([key]);
  expect(toggleSessionPin(s,'owner-A',key)).toEqual([]);
 });
 it('uses actual native IDs and separates hosts/harnesses without directory identity', () => {
  const one=row('local-alias',{meta:{nativeSessionId:'same'}});
  expect(sessionPinKey(one)).toBe(sessionPinKey(row('same')));
  expect(sessionPinKey(row('same',{hostId:'mac-m1',remote:true}))).not.toBe(sessionPinKey(one));
  expect(sessionPinKey(row('same',{harness:'zcode'}))).not.toBe(sessionPinKey(one));
  expect(sessionPinKey({...one,cwd:'/other',title:'renamed'})).toBe(sessionPinKey(one));
  expect(sessionPinKey(row('one',{hostId:undefined}))).toBeUndefined();
 });
 it('refuses missing scope and reports storage failure without altering existing pins', () => {
  const s=storage(), key=sessionPinKey(row('one'))!;
  expect(toggleSessionPin(s,'',key)).toBeNull();
  toggleSessionPin(s,'A',key);
  expect(toggleSessionPin({...s,setItem:()=>{throw new Error('quota')}},'A',key)).toBeNull();
  expect(readSessionPins(s,'A')).toEqual([key]);
  expect(readSessionPins({getItem:()=>'{bad',setItem:()=>{}},'A')).toEqual([]);
 });
 it('promotes a pinned child from a folded parent once; unpin restores the tree', () => {
  const parent=row('parent'), child=row('child',{meta:{parentSessionKey:'codex:parent'}}), other=row('other');
  const pins=[sessionPinKey(child)!];
  const result=sidebarEntries([parent,child,other],settings,new Set(['codex:parent']),new Set(),' ',pins);
  expect(result[0].session.id).toBe('child');
  expect(result.filter(x=>x.session.id==='child')).toHaveLength(1);
  expect(result[0].depth).toBe(0);
  expect(sidebarEntries([parent,child],settings,new Set(['codex:parent']),new Set(),'',[]).map(x=>x.session.id)).toEqual(['parent']);
 });
 it('respects host, harness, completion and search filters before promotion', () => {
  // Обе сессии завершены: живой фильтр не должен возвращать их даже ради закрепления.
  const local=row('same',{status:'stopped'}), remote=row('same',{hostId:'mac-m1',remote:true,title:'remote',harness:'zcode',status:'stopped'});
  const pins=[sessionPinKey(remote)!,sessionPinKey(local)!];
  expect(sidebarEntries([local,remote],settings,new Set(),new Set(),'remote',pins).map(x=>x.session.hostId)).toEqual(['mac-m1']);
  expect(sidebarEntries([local,remote],{...settings,hostId:local.hostId},new Set(),new Set(),'',pins).map(x=>x.session.hostId)).toEqual([local.hostId]);
  expect(sidebarEntries([local,remote],{...settings,showAll:false},new Set(),new Set(),'',pins)).toEqual([]);
 });
 it('keeps a pinned folded parent expandable', () => {
  const parent=row('parent'), child=row('child',{meta:{parentSessionKey:'codex:parent'}}), pins=[sessionPinKey(parent)!];
  const folded=sidebarEntries([parent,child],settings,new Set(['codex:parent']),new Set(),'',pins);
  expect(folded[0].hasChildren).toBe(true);
  expect(sidebarEntries([parent,child],settings,new Set(),new Set(),'',pins).map(x=>x.session.id)).toEqual(['parent','child']);
 });
 it('does not overwrite saved pins when reading storage fails but writing would work', () => {
  const s=storage(), first=sessionPinKey(row('one'))!;toggleSessionPin(s,'A',first);
  const uncertain={...s,getItem:()=>{throw new Error('read unavailable')}};
  expect(toggleSessionPin(uncertain,'A',sessionPinKey(row('two'))!)).toBeNull();
  expect(readSessionPins(s,'A')).toEqual([first]);
 });
 it('catches the browser storage property getter before read or click paths', () => {
  const blocked=sessionPinStorage(()=>{throw new Error('SecurityError')});
  expect(readSessionPinState(blocked,'A')).toEqual({keys:[],failed:true});
  expect(toggleSessionPin(blocked,'A',sessionPinKey(row('one'))!)).toBeNull();
  expect(readSessionPinState(blocked,'')).toEqual({keys:[],failed:false});
 });
 it('labels launch versus current CWD honestly, including unconfirmed metadata', () => {
  const launch=sidebarContext(row('one',{model:undefined}));
  expect(launch.currentCwd).toBeUndefined();expect(launch.launchCwd).toBe('/project');expect(launch.model).toBe('Не указана');
  const moved=sidebarContext(row('one',{cwd:'/launch',meta:{activeCwd:'/current',projectSource:'coordination_activity'}}));
  expect(moved.currentCwd).toBe('/current');expect(moved.launchCwd).toBe('/launch');
  const unknown=sidebarContext(row('one',{cwd:'',hostId:undefined,lastActivity:'bad',status:'unexpected'}));
  expect(unknown.host).toBe('Машина не подтверждена');expect(unknown.updated).toBe('Не подтверждено');expect(unknown.status).toBe('Статус не подтверждён');
 });
 it('keeps the exact remote project observation for the tooltip', () => {
  const remote=directorySession({address:{hostId:'mac-m1',harness:'zcode',nativeSessionId:'same'},project:{launchCwd:'/launch',currentCwd:'/actual',source:'coordination_activity'},title:'task',status:'running',lastActivity:'2026-10-13T12:00:00Z',model:'actual-model'}, {hostId:'mac-m1',label:'Mac M1'} as any,'roomhacker-server-100');
  const c=sidebarContext(remote);expect(c.currentCwd).toBe('/actual');expect(c.launchCwd).toBe('/launch');expect(c.subtitle).toBe('ZCode · M1');expect(c.model).toBe('actual-model');
 });
});
