import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerAdapter } from '../src/adapters/codex-app-server.js';
import { SessionAutostartStore, UnfinishedSessionStore, UnfinishedSessionLauncher } from '../src/autopilot/unfinished-session-launcher.js';
import { AutopilotPolicyStore } from '../src/autopilot/policy-store.js';
import { HumanStopStore } from '../src/human-stop-store.js';
import type { AgentSession, HarnessAdapter } from '../src/types/index.js';

// Fast unit; expected <2s/max10s. Reproduces the actual missed completion on
// reconnect to a surviving shared writer. No native transport/provider calls.
const native = () => ({ id:'thread',cwd:'/fixture',status:{type:'notLoaded'},turns:[{id:'turn',status:'completed',error:null,items:[
 {id:'user',type:'userMessage',content:[{type:'text',text:'Execute all three steps once.'}]},
 {id:'tool',type:'commandExecution',status:'completed',exitCode:0,aggregatedOutput:'steps 1,2,3 each once'},
 {id:'final',type:'agentMessage',phase:'final_answer',text:'All three steps completed exactly once.'},
]}] });
const session: AgentSession = {id:'thread',harness:'codex',cwd:'/fixture',title:'fixture',status:'idle',needsPermission:false,lastActivity:new Date().toISOString()};
function probe(get:()=>unknown) {
 const adapter = new CodexAppServerAdapter({socketPath:'/not-used',codexDir:'/not-used'});
 vi.spyOn(adapter as any,'ensureReady').mockResolvedValue(undefined);
 const rpc = vi.spyOn(adapter as any,'request').mockImplementation(async()=>({thread:get()}));
 return {adapter,rpc};
}
it('reads exact full history without loading, subscribing, resuming or sending',async()=>{
 const {adapter,rpc}=probe(native);
 const result=await (adapter as any).readTrackedTurnCompletion('thread','turn','/fixture');
 expect(result?.turnId).toBe('turn');expect(result?.transcriptTail).toContain('steps 1,2,3');
 expect(rpc.mock.calls).toEqual([['thread/read',{threadId:'thread',includeTurns:true}]]);
});

describe('cold business completion with existing store and judge',()=>{
 it.each(['completed','unfinished','needs_human','new-user','hold','new-record','unknown-read','lock-hold','lock-desktop','lock-question','new-inventory','lock-event'] as const)('settles only confirmed exact completion: %s',async boundary=>{
  const root=await mkdtemp(join(tmpdir(),'codex-cold-completion-'));
  try {
   const store=new UnfinishedSessionStore(join(root,'unfinished.json'));
   await store.markNativeTurnStarted(session,{turnId:'turn'},'old-parent');
   const settings=new SessionAutostartStore(join(root,'settings.json'),{});
   await settings.setGlobal(true);await settings.setHarness('codex',true);await settings.setSession({harness:'codex',sessionId:'thread',cwd:'/fixture'},true);
   const policy=new AutopilotPolicyStore(join(root,'policy.json'));
   await policy.replacePolicy({schemaVersion:1,enabled:true,harnesses:['codex'],scope:{mode:'all_ingress'},maxContinuationsPerSession:3,timeout:{mode:'auto_continue',delayMs:1000},card:{includeUserMessage:true,includeAssistantMessage:true,includeReason:true}},null);
   const {adapter}=probe(native);
   vi.spyOn(adapter,'listSessions').mockResolvedValue([]);
   const send=vi.spyOn(adapter,'sendMessage');const resume=vi.spyOn(adapter,'resumeSession');
   const stops=new HumanStopStore(join(root,'stops.json'));let question=false;let eventTask:Promise<void>|undefined;
   let unlock:()=>void=()=>{};let reached:()=>void=()=>{};const atLock=new Promise<void>(r=>reached=r);
   const releaseLock=new Promise<void>(r=>unlock=r);
   const settle=store.settleTrackedCodexCompletion?.bind(store);
   if(boundary.startsWith('lock-')){
    store.settleTrackedCodexCompletion=async(...args:Parameters<UnfinishedSessionStore['settleTrackedCodexCompletion']>)=>{
     const blocker=(store as any).mutate(async()=>{reached();await releaseLock;},()=>false);
     const mutation=settle!(...args);await blocker;return mutation;
    };
   }
   let changed=false;const initial=native();
   (adapter as any).request.mockImplementation(async()=>{if(changed && boundary==='unknown-read')throw new Error('timeout');return {thread: changed && (boundary==='new-user'||boundary==='lock-desktop') ? {...initial,turns:[...initial.turns,{id:'desktop-new',status:'inProgress',items:[]}]} : initial};});
   const judge=vi.fn(async()=>{if(!boundary.startsWith('lock-'))changed=true;if(boundary==='hold')await stops.hold(session,{id:'manual-stop',at:new Date().toISOString(),reason:'human Stop'});if(boundary==='new-inventory')await store.upsertInventory({harness:'codex',sessionId:'thread',cwd:'/fixture',workspaceIdentity:'/fixture',title:'fresh human question',status:'needs_input',lastActivity:new Date().toISOString(),observedAt:new Date().toISOString(),transcriptTail:'new question',evidenceFingerprint:'new-evidence',verdict:{verdict:'needs_human',confidence:1,reason:'new question',judgedAt:new Date().toISOString()}});if(boundary==='new-record')await store.markNativeTurnStarted(session,{turnId:'desktop-new'},'new-parent');return {verdict: boundary==='unfinished'||boundary==='needs_human'?boundary:'completed' as const,reason:'Consumer evidence was assessed against the original task.',confidence:1};});
   const launcher=new UnfinishedSessionLauncher({adapters:new Map<string,HarnessAdapter>([['codex',adapter]]),store,settingsStore:settings,generationId:'new-parent',autopilotPolicyStore:policy,humanStopStore:stops,humanRequests:{async list(){return question?[{id:'question',target:{harness:'codex',sessionId:'thread',cwd:'/fixture'},status:'pending'} as any]:[];}},judge:{decide:judge,plan:async()=>({groups:[]})}});
   await launcher.recoverPending();expect(judge).not.toHaveBeenCalled();
   const cycle=launcher.runAutopilotCycle();
   if(boundary.startsWith('lock-')){await atLock;changed=true;if(boundary==='lock-hold')await stops.hold(session,{id:'lock-stop',at:new Date().toISOString(),reason:'human Stop'});if(boundary==='lock-question')question=true;if(boundary==='lock-event'){vi.spyOn(adapter,'getSession').mockResolvedValue({...session,status:'running'});eventTask=launcher.handleEvent('codex',{harness:'codex',sessionId:'thread',kind:'turn.started',nativeType:'turn/started',data:{turnId:'desktop-new'}}).catch(()=>{});}
    unlock();}
   await cycle;await eventTask;
   expect(judge).toHaveBeenCalledOnce();
   if(boundary==='completed'){expect(await store.list()).toEqual([]);expect((await store.listInventory())[0]?.verdict?.verdict).toBe('completed');}
   else {expect(await store.list()).toHaveLength(1);if(boundary==='new-inventory')expect((await store.listInventory())[0]?.verdict?.verdict).toBe('needs_human');else expect(await store.listInventory()).toEqual([]);}
   expect(send).not.toHaveBeenCalled();expect(resume).not.toHaveBeenCalled();
  } finally {await rm(root,{recursive:true,force:true});}
 });
});

// Fast unit expected <1s/max5s: fail closed on partial/uncertain native state.
it.each(['running','pending','different-turn','new-user','tool-running','tool-unknown','failed','no-final','partial-history','different-cwd'] as const)('does not manufacture terminal proof from %s',async boundary=>{
 const t:any=native(),turn=t.turns[0];
 if(boundary==='running')t.status={type:'active',activeFlags:[]};
 if(boundary==='pending')t.status={type:'idle',activeFlags:['waitingOnUserInput']};
 if(boundary==='different-turn')turn.id='another-turn';
 if(boundary==='new-user')turn.items.splice(2,0,{id:'new',type:'userMessage',content:[{type:'text',text:'new Desktop instruction'}]});
 if(boundary==='tool-running')turn.items[1].status='inProgress';
 if(boundary==='tool-unknown')turn.items.push({id:'uncertain',type:'futureTool'});
 if(boundary==='failed')turn.status='failed';
 if(boundary==='no-final')delete turn.items[2].phase;
 if(boundary==='partial-history')t.turns.unshift({id:'older',status:'completed'});
 if(boundary==='different-cwd')t.cwd='/foreign';
 const {adapter}=probe(()=>t);expect(await (adapter as any).readTrackedTurnCompletion('thread','turn','/fixture')).toBeNull();
});
