import {describe,expect,it} from 'vitest';
import {isFleetSessionLink,localSessionReadKey,resolveSessionDeepLink,sessionKeyFromHash} from '../src/web-ui/session-list.js';

const local={hostId:'100',harness:'codex',nativeSessionId:'native-id'};
const remote={...local,hostId:'44'};
describe('exact native session deep links',()=>{
 it('keeps ordinary local links independent of fleet inventory, while LHC and typed addresses opt in',()=>{
  expect(isFleetSessionLink('','codex:native-id')).toBe(false);
  expect(isFleetSessionLink('?page=chat','codex:native-id')).toBe(false);
  expect(isFleetSessionLink('?from=lhc','codex:native-id')).toBe(true);
  expect(isFleetSessionLink('',`mesh:${JSON.stringify(['44','codex','native-id'])}`)).toBe(true);
 });
 it('resolves a unique remote UUID after the complete inventory, preserving host',()=>{
  expect(resolveSessionDeepLink('codex:native-id',[remote],'100',true)).toEqual({kind:'remote',address:remote});
 });
 it('uses an observed exact remote match even with another host offline, but never guesses missing or ambiguous identities',()=>{
  expect(resolveSessionDeepLink('codex:native-id',[remote],'100',false)).toEqual({kind:'remote',address:remote});
  expect(resolveSessionDeepLink('codex:native-id',[local,remote],'100',true).kind).toBe('ambiguous');
  expect(resolveSessionDeepLink('codex:native-id',[],'100',false).kind).toBe('pending');
 });
 it('keeps exact local sessions and permits an exact local detail probe after inventory completion',()=>{
  expect(resolveSessionDeepLink('codex:native-id',[local],'100',false)).toEqual({kind:'local',key:'codex:native-id'});
  expect(resolveSessionDeepLink('codex:historical',[],'100',true)).toEqual({kind:'local',key:'codex:historical'});
 });
 it('uses confirmed local API rows without waiting for a partial fleet inventory',()=>{
  const localRows=[{id:'native-id',harness:'codex',remote:false}];
  expect(resolveSessionDeepLink('codex:native-id',[],'100',false,localRows)).toEqual({kind:'local',key:'codex:native-id'});
  expect(resolveSessionDeepLink('codex:native-id',[local],'100',false,localRows)).toEqual({kind:'local',key:'codex:native-id'});
  expect(resolveSessionDeepLink('codex:native-id',[],'100',false,[{...localRows[0],remote:true}]).kind).toBe('pending');
  expect(resolveSessionDeepLink('codex:native-id',[],'100',false,[{...localRows[0],hostId:'44'}]).kind).toBe('pending');
  expect(resolveSessionDeepLink('codex:other-id',[],'100',false,localRows).kind).toBe('pending');
 });
 it('probes an exact local native endpoint when every list is missing the session, then accepts verified details',()=>{
  const pending=resolveSessionDeepLink('codex:native-id',[],'100',false);
  expect(localSessionReadKey('codex:native-id',pending)).toBe('codex:native-id');
  const verifiedDetails={id:'native-id',harness:'codex'};
  expect(resolveSessionDeepLink('codex:native-id',[],'100',false,[verifiedDetails])).toEqual({kind:'local',key:'codex:native-id'});
  expect(localSessionReadKey('mesh:["44","codex","native-id"]',{kind:'pending'})).toBeUndefined();
  expect(localSessionReadKey('codex:native-id',{kind:'remote',address:remote})).toBeUndefined();
  expect(localSessionReadKey('codex:native-id',{kind:'ambiguous'})).toBeUndefined();
 });
 it('round trips an explicitly addressed mesh link without a list click',()=>{
  const key=`mesh:${JSON.stringify(['44','codex','native-id'])}`;
  const decoded=sessionKeyFromHash(`#/session/${encodeURIComponent(key)}`)!;
  expect(resolveSessionDeepLink(decoded,[],'100',false)).toEqual({kind:'remote',address:remote});
  expect(resolveSessionDeepLink(`mesh:${JSON.stringify(['100','codex','native-id'])}`,[],'100',false)).toEqual({kind:'local',key:'codex:native-id'});
 });
 it('rejects malformed mesh addresses and unsupported remote harnesses',()=>{
  for(const key of ['mesh:bad','mesh:[]',`mesh:${JSON.stringify(['44','unsupported','native-id'])}`,`mesh:${JSON.stringify(['44','codex','bad\n'])}`]){
   expect(resolveSessionDeepLink(key,[],'100',true).kind).toBe('invalid');
  }
 });
});
