import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { loadNoticePlaceSecretReferences, createNoticePlaceCompletionRegistrar, createNoticePlaceRustAutopilotPort, createNoticePlaceSessionReadAdapter, noticePlaceSnapshot } from '../src/automation/v1-noticeplace-runtime.js';
import { composeNoticePlaceOwnerRead, noticePlaceOwnerNodeStatus } from '../src/automation/v1-noticeplace-owner-state.js';

const row = {
  session_ref: 'opaque-rust-ref', address: { native_session_id: 'native-session' },
  native: { id: 'native-session', harness: 'opencode', cwd: '/srv/noticeplace', status: 'idle', lastActivity: '2026-11-08T10:00:00Z', model: 'minimax-coding-plan/MiniMax-M3.1-Flash' },
  human_stop: { held: false },
};
const messages = { page: { messages: [
  { id: 'u1', role: 'user', turnId: 'turn-exact', text: 'incident' },
  { id: 'a1', role: 'assistant', turnId: 'turn-exact', text: 'done' },
] } };

describe('NoticePlace runtime Rust snapshot contract', () => {
  it('derives terminal turn from native messages and a stable revision from row plus messages', () => {
    const snapshot = noticePlaceSnapshot(row, messages);
    expect(snapshot).toMatchObject({ sessionRef: 'opaque-rust-ref', nativeSessionId: 'native-session', humanStopHeld: false, turnId: 'turn-exact', model: row.native.model });
    const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
    expect(snapshot.revision).toBe(createHash('sha256').update(JSON.stringify(canonical({ row, messages: messages.page.messages }))).digest('hex'));
    expect(noticePlaceSnapshot({ ...row, native: Object.fromEntries(Object.entries(row.native).reverse()) }, messages).revision).toBe(snapshot.revision);
  });

  it('fails closed when the authoritative HumanStop row is absent or malformed', () => {
    expect(() => noticePlaceSnapshot({ ...row, human_stop: undefined }, messages)).toThrow('rust_authoritative_snapshot_contract_unavailable');
    expect(() => noticePlaceSnapshot({ ...row, human_stop: { held: 'false' } }, messages)).toThrow('rust_authoritative_snapshot_contract_unavailable');
  });

  it('keeps a running session with no assistant turn armable without inventing a turn ID', () => {
    const snapshot=noticePlaceSnapshot({...row,native:{...row.native,status:'running'}},{page:{messages:[{role:'user',id:'user-message'}]}});
    expect(snapshot.status).toBe('running');
    expect(snapshot.turnId).toBe('');
    expect(snapshot.revision).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe('NoticePlace fleet disarm preflight', () => {
  it('does not let a local running state mask a remote 44 STOP', () => {
    const local={disarmed:false,records:[{scope:'*',forbidden:false}]};
    const nodes=[{hostId:'server-100',status:'confirmed'},{hostId:'server-44',status:noticePlaceOwnerNodeStatus({disarmed:true,records:[{scope:'*',forbidden:true}]} )},{hostId:'server-88',status:'confirmed'}];
    expect(nodes[1]?.status).toBe('stopped');
    expect(composeNoticePlaceOwnerRead(local,nodes)).toMatchObject({ok:false});
  });
});

describe('NoticePlace runtime composition ports', () => {
  it('constructs the session reader with the shared Rust port, exact instance and cwd', async () => {
    const port={call:vi.fn(async()=>({}))};
    const factory=vi.fn((input:{port:typeof port;instanceRef:string;cwd:string})=>({read:async(sessionRef:string,kind:'progress'|'details')=>({sessionRef,kind,instanceRef:input.instanceRef,cwd:input.cwd,samePort:input.port===port,from:'legacy-reader'})}));
    const sessionRead=createNoticePlaceSessionReadAdapter(factory,port,'opencode-noticeplace-local','/srv/noticeplace');
    expect(factory).toHaveBeenCalledWith({port,instanceRef:'opencode-noticeplace-local',cwd:'/srv/noticeplace'});
    expect(await sessionRead.read('opaque-core-ref','details')).toEqual({sessionRef:'opaque-core-ref',kind:'details',instanceRef:'opencode-noticeplace-local',cwd:'/srv/noticeplace',samePort:true,from:'legacy-reader'});
    expect(port.call).not.toHaveBeenCalled();
  });

  it('waits for actual OpenCode connection, propagates disconnect, and unsubscribes', async () => {
    let listener:((event:any)=>void)|undefined;
    const unsubscribe=vi.fn();
    const registrar=createNoticePlaceCompletionRegistrar({subscribeEvents:callback=>{listener=callback;return unsubscribe;}},async()=>[{session_ref:'opaque-rust-ref',address:{native_session_id:'native-session'}}],500);
    const callback=vi.fn(async()=>undefined);
    let settled=false;
    const registering=registrar('opaque-rust-ref',callback).then(value=>{settled=true;return value;});
    await Promise.resolve();
    expect(settled).toBe(false);
    listener!({kind:'process.connected'});
    const registration=await registering;
    expect(registration.isActive()).toBe(true);
    listener!({kind:'turn.completed',sessionId:'native-session',data:{turnId:'turn-from-native'}});
    await vi.waitFor(()=>expect(callback).toHaveBeenCalledWith({sessionRef:'opaque-rust-ref',nativeSessionId:'native-session',turnId:'turn-from-native'}));
    listener!({kind:'process.disconnected'});
    expect(registration.isActive()).toBe(false);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes when the stream disconnects synchronously during registration', async () => {
    const unsubscribe=vi.fn();
    const registrar=createNoticePlaceCompletionRegistrar({subscribeEvents:listener=>{listener({kind:'process.disconnected'});return unsubscribe;}},async()=>[],500);
    await expect(registrar('opaque-rust-ref',async()=>undefined)).rejects.toThrow('opencode_event_stream_disconnected');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('rechecks row+messages before exact Rust Deliver::Session and does not send on stale revision', async () => {
    const calls:Array<{tool:string;args:Record<string,unknown>;key?:string}>=[];
    let currentMessages=messages;
    const port={async call(tool:string,args:Record<string,unknown>,key?:string){
      calls.push({tool,args,...(key?{key}:{})});
      if(tool==='sessions')return {sessions:[row]};
      if(tool==='session')return {page:currentMessages.page};
      if(tool==='deliver')return {task_ref:'delivery-task'};
      throw new Error('unexpected_tool');
    }};
    const rust=createNoticePlaceRustAutopilotPort(port,'opencode-noticeplace-local');
    const snapshot=await rust.snapshot('opaque-rust-ref');
    const input={sessionRef:'opaque-rust-ref',nativeSessionId:'native-session',message:'continue',requestKey:'stable-key',model:row.native.model,expectedRevision:snapshot.revision,turnId:snapshot.turnId};
    currentMessages={page:{messages:[...messages.page.messages,{role:'assistant',turnId:'later-turn',text:'changed'}]}};
    await expect(rust.deliver(input)).rejects.toThrow('noticeplace_snapshot_changed');
    expect(calls.filter(call=>call.tool==='deliver')).toHaveLength(0);
    currentMessages=messages;
    await rust.deliver(input);
    const delivery=calls.find(call=>call.tool==='deliver')!;
    expect(delivery.args).toEqual({action:'session',session_ref:'opaque-rust-ref',message:'continue',mode:'current',request_key:'stable-key'});
    expect(delivery.key).toBe('stable-key');
  });
});


describe('NoticePlace existing secret references', () => {
  it('resolves a marker through the existing store without changing credentials', async () => {
    const root=await mkdtemp(join(tmpdir(),'noticeplace-secret-'));
    const path=join(root,'secrets.json');
    const bytes=JSON.stringify({version:1,secrets:{NOTICEPLACE_HEALTH_LAUNCH_TOKEN:'test-existing-credential'}});
    try {
      await writeFile(path,bytes,{mode:0o600});
      const env={NOTICEPLACE_HEALTH_LAUNCH_TOKEN:'sha256:0123456789abcdef'};
      await loadNoticePlaceSecretReferences(path,Object.keys(env),env);
      expect(env.NOTICEPLACE_HEALTH_LAUNCH_TOKEN).toBe('test-existing-credential');
      expect(await readFile(path,'utf8')).toBe(bytes);
    } finally {await rm(root,{recursive:true,force:true});}
  });
  it('keeps an explicitly injected real value and rejects unresolved markers', async () => {
    const env={NOTICEPLACE_HEALTH_LAUNCH_TOKEN:'explicit-test-value'};
    await loadNoticePlaceSecretReferences('/does-not-exist',Object.keys(env),env);
    expect(env.NOTICEPLACE_HEALTH_LAUNCH_TOKEN).toBe('explicit-test-value');
    await expect(loadNoticePlaceSecretReferences('/does-not-exist',['TOKEN'],{TOKEN:'sha256:0123456789abcdef'})).rejects.toThrow();
  });
});
