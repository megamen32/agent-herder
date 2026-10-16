import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { createWebServer } from '../src/web/server.js';
import { OpenCodeAdapter } from '../src/adapters/opencode.js';
import { deferredMessages } from '../src/deferred-messages.js';
import { getHumanStopStore } from '../src/human-stop-store.js';

// Focused integration: real ESM physical paths + existing HTTP/store/native read adapter.
// Expected 2s/max 10s; fake read-only native server, no provider/model or installed writes.
async function listen(server: Server) { await new Promise<void>(r=>server.listen(0,'127.0.0.1',r)); return `http://127.0.0.1:${(server.address() as {port:number}).port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); }

async function fixture() {
  const directory=await mkdtemp(join(tmpdir(),'opencode-global-')),id='native-'+randomUUID();
  let root='user-'+randomUUID(),busy=true;const mutations:string[]=[];
  const native=createServer((req,res)=>{
    if(req.method!=='GET')mutations.push(req.url||'');
    const path=new URL(req.url||'','http://local').pathname;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(path==='/session/status'?{[id]:{type:busy?'busy':'idle'}}:path.endsWith('/message')?[{info:{id:root,sessionID:id,role:'user'},parts:[{type:'text',text:'initial'}]}]:{id,directory}));
  });
  const adapter=new OpenCodeAdapter({baseUrl:await listen(native), protocol: "v1"});
  const server=createWebServer({adapters:new Map([['opencode',adapter]]),converter:{} as any,supervisor:{isAutomationHeld:async()=>false} as any});
  const endpoint=await listen(server);
  const physical=join(directory,'agent-herder-current-context-'+randomUUID()+'.mjs');
  await writeFile(physical,await readFile(new URL('../integrations/opencode/agent-herder-current-context.js',import.meta.url)));
  const module=await import(pathToFileURL(physical).href);
  const priorEndpoint=process.env.AGENT_HERDER_URL;process.env.AGENT_HERDER_URL=endpoint;
  const hooks=await module.default({directory});
  const output=()=>({messages:[{info:{id:root,sessionID:id,role:'user'},parts:[{type:'text',text:'initial'}]}]});
  return {directory,id,adapter,hooks,module,output,mutations,endpoint,
    changeUser(){root='next-'+randomUUID();},idle(){busy=false;},
    async done(){if(priorEndpoint===undefined)delete process.env.AGENT_HERDER_URL;else process.env.AGENT_HERDER_URL=priorEndpoint;await getHumanStopStore().release('opencode',id);await close(server);await close(native);await rm(directory,{recursive:true,force:true});}};
}

it('fresh physical messages-only bridge coexists with a cached passive plugin and offers once',async()=>{
  const f=await fixture();try{
    // Real module caching, in a private directory. This models a passive cached
    // legacy factory; it does not claim that live cached bytes were inspected.
    const legacy=join(f.directory,'canonical-old.mjs'),url=pathToFileURL(legacy).href;
    await writeFile(legacy,'export default async function(){return {config(c){c.command={autopilot:{}}},"experimental.chat.system.transform"(_i,o){o.system.push("legacy passive")}}}');
    const old=await import(url);await writeFile(legacy,'throw Error("same filename cannot refresh a cached factory")');
    expect((await import(url)).default).toBe(old.default);
    const oldHooks=await old.default({directory:f.directory});
    const config:any={};await oldHooks.config(config);expect(config.command.autopilot).toBeDefined();
    const nonce='ACTIVE-'+randomUUID();await f.adapter.sendActiveMessage(f.id,{message:nonce,inputId:'once'});
    const output=f.output();await oldHooks['experimental.chat.messages.transform']?.({},output);
    await f.hooks['experimental.chat.messages.transform']?.({},output);
    expect(JSON.stringify(output)).toContain(nonce);
    expect((await deferredMessages.activeReceipt('opencode',f.id,'once'))?.activeTurn?.state).toBe('hook_returned');
    await f.hooks['experimental.chat.messages.transform']?.({},output);
    expect(output.messages[0].parts[0].text.split(nonce)).toHaveLength(2);
    expect(Object.values(f.module)).toHaveLength(1);
    expect(Object.keys(f.hooks)).toEqual(['experimental.chat.messages.transform']);
    expect(f.mutations).toEqual([]);
  }finally{await f.done();}
});

it.each(['stop','idle','new-user'] as const)('global bridge refuses %s and never transfers debt into a later task',async boundary=>{
  const f=await fixture();try{
    const prior=await deferredMessages.add(f.id,'explicit older task');
    await f.adapter.sendActiveMessage(f.id,{message:'forbidden context',inputId:'once',retainedInboxIds:[prior.id]});
    if(boundary==='stop')await getHumanStopStore().hold({id:f.id,harness:'opencode',cwd:f.directory,status:'running'} as any,{id:'hold',at:new Date().toISOString(),reason:'human Stop'});
    if(boundary==='idle')f.idle();if(boundary==='new-user')f.changeUser();
    const output=f.output();await f.hooks['experimental.chat.messages.transform']?.({},output);
    expect(JSON.stringify(output)).not.toContain('forbidden context');
    expect((await deferredMessages.list(f.id)).map(m=>m.id)).toEqual([prior.id]);
    f.changeUser();await getHumanStopStore().release('opencode',f.id);
    const next=f.output();await f.hooks['experimental.chat.messages.transform']?.({},next);
    expect(JSON.stringify(next)).not.toContain('forbidden context');expect(f.mutations).toEqual([]);
  }finally{await f.done();}
});

it('two current bridge factories share the existing durable once-offer instead of duplicating context',async()=>{
  const f=await fixture();try{
    const second=await f.module.default({directory:f.directory});
    const nonce='ACTIVE-'+randomUUID();await f.adapter.sendActiveMessage(f.id,{message:nonce,inputId:'once'});
    const output=f.output();await Promise.all([f.hooks['experimental.chat.messages.transform']?.({},output),second['experimental.chat.messages.transform']?.({},output)]);
    expect(output.messages[0].parts[0].text.split(nonce)).toHaveLength(2);
    expect((await deferredMessages.activeReceipt('opencode',f.id,'once'))?.activeTurn?.state).toBe('hook_returned');
    expect(f.mutations).toEqual([]);
  }finally{await f.done();}
});

it('an offered context with a lost ACK is receipt-only, never fetched again as a retry',async()=>{
  const f=await fixture(),originalFetch=globalThis.fetch;
  const fetching=vi.spyOn(globalThis,'fetch').mockImplementation((input,init)=>{
    if(new URL(String(input)).pathname==='/api/coordination/inbox-ack')return Promise.reject(new Error('simulated lost ACK'));
    return originalFetch(input,init);
  });
  try{
    const nonce='ACTIVE-'+randomUUID();await f.adapter.sendActiveMessage(f.id,{message:nonce,inputId:'once'});
    const output=f.output();await f.hooks['experimental.chat.messages.transform']({},output);
    expect(JSON.stringify(output)).toContain(nonce);
    expect((await deferredMessages.activeReceipt('opencode',f.id,'once'))?.activeTurn?.state).toBe('offered');
    const next=f.output();await f.hooks['experimental.chat.messages.transform']({},next);
    expect(JSON.stringify(next)).not.toContain(nonce);expect(f.mutations).toEqual([]);
  }finally{fetching.mockRestore();await f.done();}
});

it('a changed output root during the context await refuses the old offer without replay',async()=>{
  const f=await fixture(),output=f.output(),originalFetch=globalThis.fetch;
  const fetching=vi.spyOn(globalThis,'fetch').mockImplementation(async(input,init)=>{
    const response=await originalFetch(input,init);
    if(new URL(String(input)).pathname==='/api/coordination/context'){
      f.changeUser();output.messages.push(f.output().messages[0]);
    }
    return response;
  });
  try{
    const nonce='ACTIVE-'+randomUUID();await f.adapter.sendActiveMessage(f.id,{message:nonce,inputId:'once'});
    await f.hooks['experimental.chat.messages.transform']({},output);
    expect(JSON.stringify(output)).not.toContain(nonce);
    expect((await deferredMessages.activeReceipt('opencode',f.id,'once'))?.activeTurn?.state).toBe('offered');
    fetching.mockRestore();const next=f.output();await f.hooks['experimental.chat.messages.transform']({},next);
    expect(JSON.stringify(next)).not.toContain(nonce);expect(f.mutations).toEqual([]);
  }finally{fetching.mockRestore();await f.done();}
});
