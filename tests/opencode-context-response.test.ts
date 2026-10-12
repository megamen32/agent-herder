import { randomUUID } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { DeferredMessageStore, deferredMessages } from '../src/deferred-messages.js';
import { OpenCodeAdapter } from '../src/adapters/opencode.js';
import { createWebServer } from '../src/web/server.js';
import plugin from '../integrations/opencode/agent-herder-autopilot.js';
import { getHumanStopStore } from '../src/human-stop-store.js';

// Focused integration: real store, HTTP, adapter and plugin; simulated read-only native API.
// Expected 3s/max 15s. No native task, provider, control or installed plugin calls.
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function listen(server: Server) { await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(server.address() as {port:number}).port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }

it('native guard wait does not reserve the shared inbox chain', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-chain-')), entered = gate(), release = gate();
  const store = new DeferredMessageStore(join(dir, 'inbox.json'));
  await store.addActive('opencode', 'active', 'user', 'once', 'context');
  const offering = store.offerActive('opencode', 'active', 'user', async () => { entered.resolve(); await release.promise; return true; });
  let writing: Promise<unknown> | undefined;
  try {
    await entered.promise;
    writing = store.add('other', 'independent explicit task').then(() => 'written');
    const result = await Promise.race([writing, new Promise(r => setTimeout(() => r('blocked'), 100))]);
    expect(result).toBe('written');
  } finally { release.resolve(); await offering; await writing; await rm(dir, {recursive:true, force:true}); }
});

it('a Stop during the final store read is checked after the wait, before transfer', async () => {
  const dir=await mkdtemp(join(tmpdir(),'context-final-stop-')),id='opencode-'+randomUUID(),stops=getHumanStopStore();
  const store=new DeferredMessageStore(join(dir,'inbox.json')),entered=gate(),release=gate();
  const prior=await store.add(id,'explicit task');
  await store.addActive('opencode',id,'user','once','context',[prior.id]);
  const reading=(store as any).read.bind(store);let reads=0;
  const delayed=vi.spyOn(store as any,'read').mockImplementation(async()=>{const value=await reading();if(++reads===2){entered.resolve();await release.promise;}return value;});
  const offering=store.offerActive('opencode',id,'user',async()=>true,async()=>!await stops.isHeld('opencode',id));
  try {
    await entered.promise;
    await stops.hold({id,harness:'opencode',cwd:dir,status:'running'} as any,{id:'stop',at:new Date().toISOString(),reason:'human Stop'});
    release.resolve();expect(await offering).toEqual([]);
    expect((await store.activeReceipt('opencode',id,'once'))?.activeTurn?.state).toBe('pending');
    expect((await store.list(id)).map(m=>m.id)).toEqual([prior.id]);
  } finally {release.resolve();await offering;delayed.mockRestore();await stops.release('opencode',id);await rm(dir,{recursive:true,force:true});}
});

it('three delayed native reads fit the unchanged 1200ms plugin body deadline', async () => {
  const id = 'opencode-' + randomUUID(), root = 'native-user', mutations: string[] = [];
  let delay = 0;
  const native = createServer((req, res) => {
    if (req.method !== 'GET') mutations.push(req.url || '');
    const path = new URL(req.url || '', 'http://local').pathname;
    const body = path === '/session/status' ? {[id]:{type:'busy'}} : path.endsWith('/message') ? [{info:{id:root, sessionID:id, role:'user'}, parts:[{type:'text', text:'initial'}]}] : {id, directory:'/workspace'};
    setTimeout(() => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(body)); }, delay);
  });
  const adapter = new OpenCodeAdapter({baseUrl:await listen(native)});
  await adapter.getSession(id); // Existing admission warms the exact native directory.
  const server = createWebServer({adapters:new Map([['opencode',adapter]]), converter:{} as any, supervisor:{isAutomationHeld:async()=>false} as any});
  const endpoint = await listen(server), old = process.env.AGENT_HERDER_URL;
  process.env.AGENT_HERDER_URL = endpoint;
  const nativeFetch = globalThis.fetch;
  const fetching = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = new URL(String(input));
    return nativeFetch(url.pathname.startsWith('/api/coordination/') ? endpoint + url.pathname + url.search : input, init);
  });
  try {
    await deferredMessages.addActive('opencode', id, root, 'once', 'ACTIVE-body-must-be-read');
    delay = 450;
    const hooks = await plugin({directory:'/workspace'} as any);
    const output = {messages:[{info:{id:root,sessionID:id,role:'user'},parts:[{type:'text',text:'initial'}]}]};
    await hooks['experimental.chat.messages.transform']({}, output);
    expect(JSON.stringify(output)).toContain('ACTIVE-body-must-be-read');
    expect((await deferredMessages.activeReceipt('opencode',id,'once'))?.activeTurn?.state).toBe('hook_returned');
    expect(mutations).toEqual([]);
  } finally {
    fetching.mockRestore();
    if (old === undefined) delete process.env.AGENT_HERDER_URL; else process.env.AGENT_HERDER_URL = old;
    await close(server); await close(native);
  }
});

it('client disconnect during native read refuses the durable offer', async () => {
  const id = 'opencode-' + randomUUID(), entered = gate(), release = gate(), finished = gate();
  const adapter = {type:'opencode', getCoordinationActiveTurnId:async()=>{entered.resolve(); await release.promise; finished.resolve(); return 'user';}} as any;
  const server = createWebServer({adapters:new Map([['opencode',adapter]]), converter:{} as any, supervisor:{isAutomationHeld:async()=>false} as any});
  const endpoint = await listen(server);
  await deferredMessages.addActive('opencode', id, 'user', 'once', 'must remain unoffered');
  const url = `${endpoint}/api/coordination/context?${new URLSearchParams({harness:'opencode',sessionId:id,cwd:'/workspace',activeTurnId:'user',consumeActive:'1'})}`;
  const client = request(url); client.on('error',()=>{}); client.end();
  try {
    await entered.promise;
    const closed = new Promise<void>(r => client.once('close',()=>r())); client.destroy(); await closed;
    await new Promise(r => setTimeout(r, 20)); release.resolve(); await finished.promise;
    // Let the response handler complete its existing serialized persistence.
    await new Promise(r => setTimeout(r, 40));
    expect((await deferredMessages.activeReceipt('opencode',id,'once'))?.activeTurn?.state).toBe('pending');
  } finally { release.resolve(); await close(server); }
});

it('a persisted Stop arriving during native read drops pending context and retains explicit inbox', async () => {
  const id = 'opencode-' + randomUUID(), stops = getHumanStopStore();
  const adapter = {type:'opencode',getCoordinationActiveTurnId:async()=>{
    await stops.hold({id,harness:'opencode',cwd:'/workspace',status:'running'} as any,{id:'human-stop',at:new Date().toISOString(),reason:'human Stop'});
    return 'user';
  }} as any;
  const server = createWebServer({adapters:new Map([['opencode',adapter]]),converter:{} as any,supervisor:{isAutomationHeld:async()=>false} as any});
  const endpoint = await listen(server);
  const prior = await deferredMessages.add(id,'explicit task');
  await deferredMessages.addActive('opencode',id,'user','once','never after Stop',[prior.id]);
  try {
    const response = await fetch(`${endpoint}/api/coordination/context?${new URLSearchParams({harness:'opencode',sessionId:id,cwd:'/workspace',activeTurnId:'user',consumeActive:'1'})}`);
    expect(await response.json()).toMatchObject({humanStopHeld:true,activeInboxIds:[],activeInboxContext:null});
    expect((await deferredMessages.activeReceipt('opencode',id,'once'))?.activeTurn?.state).toBe('expired');
    expect((await deferredMessages.list(id)).map(m=>m.id)).toEqual([prior.id]);
  } finally { await stops.release('opencode',id); await close(server); }
});

it.each(['foreign-session','foreign-user-session','missing-user-identity','permission','directory-rebound'])('native active identity refuses %s',async mismatch=>{
  const id = 'opencode-'+randomUUID(); let changed = false;
  const native = createServer((req,res)=>{
    const path = new URL(req.url||'','http://local').pathname;
    const body = path === '/session/status' ? {[id]:{type:'busy',needsPermission:changed&&mismatch==='permission'}}
      : path.endsWith('/message') ? [{info:{id:changed&&mismatch==='missing-user-identity'?undefined:'user',sessionID:changed&&mismatch==='foreign-user-session'?'other':id,role:'user'}}]
      : {id:changed&&mismatch==='foreign-session'?'other':id,directory:changed&&mismatch==='directory-rebound'?'/other':'/workspace'};
    res.setHeader('content-type','application/json');res.end(JSON.stringify(body));
  });
  const adapter = new OpenCodeAdapter({baseUrl:await listen(native)});
  try { expect(await adapter.getCoordinationActiveTurnId(id)).toBe('user'); changed=true; expect(await adapter.getCoordinationActiveTurnId(id)).toBeNull(); }
  finally { await close(native); }
});
