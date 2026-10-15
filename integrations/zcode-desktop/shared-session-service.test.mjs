// Focused integration: expected2s/emergency20s. Two real Unix socket peers,
// native-service doubles only at the executor boundary; real native/Desktop
// acceptance remains separate. Catches duplicate loads and caller-owned turns.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {shareZcodeSessionService} from './shared-session-service.mjs';

function fixture(role) {
  const sessions = new Map(), loads = [], listeners = new Set();
  const service = {
    async readSession(params) {
      if (params.messageLimit !== undefined) assert.ok(params.messageLimit > 0, 'native messageLimit must be positive');
      if (!sessions.has(params.sessionId)) throw Object.assign(Error('Session not found: '+params.sessionId), {code:'proto.sessionNotFound'});
      return {session:{sessionId:params.sessionId},runtime:sessions.get(params.sessionId)};
    },
    async createSession() {const id=randomUUID();sessions.set(id,{});return {session:{sessionId:id}};},
    async loadSession(params) {loads.push(params.sessionId);sessions.set(params.sessionId,{});return this.readSession(params);},
    async sendPrompt(params) {
      sessions.get(params.sessionId).activeTurnId = params.inputId;
      for (const listener of listeners) listener({sessionId:params.sessionId,turnId:params.inputId});
      return {accepted:true,sessionId:params.sessionId};
    },
    async failUnknown() {throw Object.assign(Error('uncertain transport'),{code:'UNKNOWN'});},
    onDynamicSessionEvent: () => listener => {listeners.add(listener);return {dispose:()=>listeners.delete(listener)};},
    disposeAll() {},
  };
  return {role,service,sessions,loads};
}
function pair(t) {
  const directory=fs.mkdtempSync(join(os.tmpdir(),'herder-shared-'));
  // Runner lease paths exceed Unix sockaddr_un's 108-byte limit. Relative
  // names remain inside the same owned temporary directory.
  const previous=process.cwd();process.chdir(directory);
  const h=fixture('herder'),d=fixture('desktop');
  const scope=(base)=>({service:base,dispose:async()=>{}});
  for (const [own,other] of [[h,d],[d,h]]) own.shared=shareZcodeSessionService({service:own.service,role:own.role,
    socketPath:own.role+'.sock',peerPath:other.role+'.sock',net,fs,createScope:scope,randomUUID});
  t.after(()=>{h.service.disposeAll();d.service.disposeAll();process.chdir(previous);fs.rmSync(directory,{recursive:true,force:true});});
  return {h,d,params:id=>({workspacePath:'/repo',sessionId:id})};
}
test('Desktop attaches to existing Herder execution, forwards state/events, and never loads a second executor',async t=>{
  const {h,d,params}=pair(t);h.sessions.set('root',{activeTurnId:'original'});
  assert.equal((await d.service.readSession(params('root'))).runtime.activeTurnId,'original');
  await d.service.loadSession(params('root'));
  assert.deepEqual(d.loads,[]);assert.deepEqual(h.loads,['root']);
  const event=new Promise(resolve=>d.service.onDynamicSessionEvent(params('root'))(resolve));
  await new Promise(resolve=>setTimeout(resolve,20));
  await d.service.sendPrompt({...params('root'),inputId:'next'});
  assert.equal((await event).turnId,'next');assert.equal(d.sessions.has('root'),false);
});
test('new Desktop sessions are created once by Herder; legacy Desktop sessions retain their live owner',async t=>{
  const {h,d,params}=pair(t);d.sessions.set('legacy',{activeTurnId:'old-desktop'});
  assert.equal((await h.service.readSession(params('legacy'))).runtime.activeTurnId,'old-desktop');
  const created=await d.service.createSession({workspacePath:'/repo'});
  assert.equal(h.sessions.has(created.session.sessionId),true);assert.equal(d.sessions.has(created.session.sessionId),false);
});
test('unknown ownership errors refuse a load; peer absence never creates a Desktop executor',async t=>{
  const {h,d,params}=pair(t);
  h.shared.raw.readSession=async()=>{throw Object.assign(Error('bad observation'),{code:'UNKNOWN'});};
  await assert.rejects(d.service.loadSession(params('uncertain')),/bad observation/);
  assert.deepEqual(d.loads,[]);assert.deepEqual(h.loads,[]);
  h.service.disposeAll();
  await assert.rejects(d.service.loadSession(params('absent')));
  assert.deepEqual(d.loads,[]);
});
test('disconnecting a caller does not stop its admitted native turn',async t=>{
  const {h,d,params}=pair(t);h.sessions.set('root',{});
  await d.service.sendPrompt({...params('root'),inputId:'admitted'});
  // Desktop lifecycle drops only its connection. Shared executor still owns
  // the admitted command and never receives disposeWorkspace/disposeAll.
  d.service.disposeAll();
  assert.equal(h.sessions.get('root').activeTurnId,'admitted');
});
test('a live legacy Desktop owner wins over an idle Herder copy in both views',async t=>{
  const {h,d,params}=pair(t);h.sessions.set('root',{});d.sessions.set('root',{activeTurnId:'live-desktop'});
  assert.equal((await h.service.readSession(params('root'))).runtime.activeTurnId,'live-desktop');
  assert.equal((await d.service.readSession(params('root'))).runtime.activeTurnId,'live-desktop');
});
test('pre-existing two-active-owner conflict refuses another load or input',async t=>{
  const {h,d,params}=pair(t);h.sessions.set('root',{activeTurnId:'old'});d.sessions.set('root',{activeTurnId:'new'});
  await assert.rejects(h.service.loadSession(params('root')),error=>error.code==='ZCODE_EXECUTOR_CONFLICT');
  await assert.rejects(d.service.sendPrompt({...params('root'),inputId:'third'}),error=>error.code==='ZCODE_EXECUTOR_CONFLICT');
  assert.deepEqual(h.loads,[]);assert.deepEqual(d.loads,[]);
});
