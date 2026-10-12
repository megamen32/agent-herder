import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { registerSessionTools } from '../src/mcp/session-tools.js';
import { HerderEventBus } from '../src/herder-events.js';
import { HerderJobRegistry } from '../src/herder-jobs.js';
import { deferredMessages } from '../src/deferred-messages.js';
import { coordinationNotes } from '../src/coordination-notes.js';
import { previousCoordinationReceipt } from '../src/coordination-active-delivery.js';
import type { AgentSession, HarnessAdapter } from '../src/types/index.js';
// Focused integration: actual registered MCP handler, isolated native adapter.
// Expected <1s/max5s; no production MCP/model/session operations.
afterEach(()=>vi.restoreAllMocks());
async function registered(status:AgentSession['status']) {
 const workspace=await mkdtemp(join(tmpdir(),'idle-mcp-'));
 let current:AgentSession={id:'target',harness:'codex',title:'completed task',cwd:workspace,status,lastActivity:new Date().toISOString(),needsPermission:false,meta:{nativeStateObserved:true,activeTurnId:status==='running'?'turn-1':undefined}};
 const send=vi.fn(async()=>({ok:true,admitted:true,turnId:'receipt-turn'}));
 const queued=vi.spyOn(deferredMessages,'add');
 vi.spyOn(deferredMessages,'list').mockResolvedValue([]);
 vi.spyOn(coordinationNotes,'inject').mockImplementation(async(_s,m)=>m);
 const adapter:HarnessAdapter={type:'codex',name:'isolated',async init(){},async listSessions(){return[current]},async getSession(){return {...current}},sendMessage:send,async stopSession(){return{ok:true}},async respondPermission(){return{ok:true}},async setPermissions(){return{ok:true}}};
 (adapter as any).sendActiveMessage=async(_id:string,options:any)=>current.status==='running'?send():{ok:false,notSubmitted:true,error:'inactive'};
 const events=new HerderEventBus(),server=new McpServer({name:'idle-admission',version:'1'}),client=new Client({name:'peer',version:'1'});
 registerSessionTools(server,{adapters:new Map([['codex',adapter]]),events,jobs:new HerderJobRegistry(events)});
 const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 return {send,queued,client,adapter,workspace,unknown:()=>{current={...current,meta:{nativeStateObserved:false}}},finish:()=>{current={...current,status:'idle',meta:{...current.meta,activeTurnId:undefined}}},close:async()=>{await client.close();await server.close();await rm(workspace,{recursive:true,force:true})}};
}
describe('ordinary coordination is not a new task',()=>{
 it.each(['idle','stopped','error','needs_input'] as const)('does not dispatch or defer send_message to %s',async status=>{
  const r=await registered(status);try{
   const result=await r.client.callTool({name:'send_message',arguments:{sessionId:'target',harness:'codex',mode:'queue',fromHarness:'codex',fromSessionId:'peer',message:'Finished report.',inputId:'report-once'}});
   expect(result.content[0]).toMatchObject({type:'text',text:expect.stringContaining('skipped_inactive')});expect(r.send).not.toHaveBeenCalled();expect(r.queued).not.toHaveBeenCalled();
  }finally{await r.close()}
 });
 it('default deliver cannot bypass the inactive gate',async()=>{
  const r=await registered('idle');try{const result=await r.client.callTool({name:'deliver',arguments:{sessionId:'target',harness:'codex',message:'Finished report.',inputId:'deliver-once'}});expect(result.content[0]).toMatchObject({type:'text',text:expect.stringContaining('skipped_inactive')});expect(r.send).not.toHaveBeenCalled();expect(r.queued).not.toHaveBeenCalled();}finally{await r.close()}
 });
 it('rechecks after awaited context work without creating deferred debt',async()=>{
  const r=await registered('running');try{vi.spyOn(coordinationNotes,'inject').mockImplementation(async(_s,m)=>{r.finish();return m});await r.client.callTool({name:'send_message',arguments:{sessionId:'target',harness:'codex',mode:'queue',message:'Late report.',inputId:'late-once'}});expect(r.send).not.toHaveBeenCalled();expect(r.queued).not.toHaveBeenCalled();}finally{await r.close()}
 });
 it.each(['admitted','unknown'] as const)('reconciles %s receipts without resend or queue even when idle',async state=>{
  const r=await registered('idle');try{r.adapter.getCoordinationMessageAdmission=vi.fn(async()=>({state,error:state==='unknown'?'earlier accepted receipt uncertain':undefined}));const result=await r.client.callTool({name:'send_message',arguments:{sessionId:'target',harness:'codex',message:'same report',inputId:'accepted-before-restart'}});expect(result.content[0]).toMatchObject({text:expect.stringContaining(state==='admitted'?'previously_admitted':'admission_unknown')});expect(r.send).not.toHaveBeenCalled();expect(r.queued).not.toHaveBeenCalled();}finally{await r.close()}
 });
 it('never invokes a legacy admission reader which can resume an inactive unsupported target',async()=>{
  const r=await registered('idle');try{const sideEffect=vi.fn(async()=>({state:'unknown' as const,error:'would resume inactive session'}));const unsupported={...r.adapter,type:'zcode' as const,getMessageAdmission:sideEffect};expect(await previousCoordinationReceipt(unsupported,'target','old-input')).toBeUndefined();expect(sideEffect).not.toHaveBeenCalled();expect(r.send).not.toHaveBeenCalled();expect(r.queued).not.toHaveBeenCalled();}finally{await r.close()}
 });
 it('refuses unknown native observations without calling them inactive',async()=>{
  const r=await registered('running');try{r.unknown();const result=await r.client.callTool({name:'send_message',arguments:{sessionId:'target',harness:'codex',message:'report',inputId:'unknown-state'}});expect(result.content[0]).toMatchObject({text:expect.stringContaining('not_attempted')});expect(r.send).not.toHaveBeenCalled();}finally{await r.close()}
 });
 it('a disappearing fresh target is unknown, not a proven inactive target',async()=>{
  const r=await registered('running');try{r.adapter.getSession=vi.fn().mockResolvedValueOnce({id:'target',harness:'codex',status:'running',needsPermission:false,cwd:r.workspace}).mockResolvedValue(null);const result=await r.client.callTool({name:'deliver',arguments:{sessionId:'target',harness:'codex',message:'report',inputId:'disappeared'}});expect(result.content[0]).toMatchObject({text:expect.stringContaining('not_attempted')});expect(r.send).not.toHaveBeenCalled();}finally{await r.close()}
 });
 it('named native unknown state is refused without reporting inactive',async()=>{
  const r=await registered('running');try{r.unknown();const result=await r.client.callTool({name:'deliver',arguments:{harness:'codex',name:'completed task',cwd:r.workspace,message:'report',create:'never',inputId:'named-unknown'}});expect(result.content[0]).toMatchObject({text:expect.stringContaining('not_attempted')});expect(r.send).not.toHaveBeenCalled();}finally{await r.close()}
 });
 it('existing named targets default to inactive skip while a missing name gets its initial task',async()=>{
  const r=await registered('idle');try{r.adapter.createSession=vi.fn(async opts=>({id:'new',title:opts.name,harness:'codex',cwd:r.workspace,status:'idle',lastActivity:new Date().toISOString(),needsPermission:false}));const existing=await r.client.callTool({name:'deliver',arguments:{harness:'codex',name:'completed task',cwd:r.workspace,message:'report',create:'never'}});expect(existing.content[0]).toMatchObject({text:expect.stringContaining('skipped_inactive')});r.adapter.getSession=vi.fn(async()=>({id:'new',title:'new task',harness:'codex',cwd:r.workspace,status:'idle',lastActivity:new Date().toISOString(),needsPermission:false}));const created=await r.client.callTool({name:'deliver',arguments:{harness:'codex',name:'new task',cwd:r.workspace,message:'explicit initial work'}});expect(created.content[0]).toMatchObject({text:expect.stringContaining('accepted')});expect(r.send).toHaveBeenCalledOnce();expect(r.queued).not.toHaveBeenCalled();}finally{await r.close()}
 });
 it('keeps active coordination and explicit human new tasks working',async()=>{
  const r=await registered('running');try{await r.client.callTool({name:'send_message',arguments:{sessionId:'target',harness:'codex',mode:'queue',message:'Current-turn decision.',inputId:'active-once'}});expect(r.send).toHaveBeenCalledTimes(1);r.finish();await r.client.callTool({name:'send_message',arguments:{sessionId:'target',harness:'codex',mode:'queue',message:'Explicit new task.',inputId:'human-once',humanRequested:true}});expect(r.send).toHaveBeenCalledTimes(2);expect(r.queued).not.toHaveBeenCalled();}finally{await r.close()}
 });
});
