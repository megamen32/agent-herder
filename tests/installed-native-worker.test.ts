import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NativeWorkerPort} from './native/installed-browser-bindings.js';
import type {OwnedCanaryBinding} from './native/installed-owned-cleanup.js';

// Exercise the actual serialized reader and IPC boundary. This module has no
// native credentials, network, model, browser, shared process or installed state.
const moduleSource = String.raw`
import {appendFile} from 'node:fs/promises';
const harness=process.env.CI_TEST_HARNESS, log=x=>appendFile(process.env.CI_TEST_LOG,x+'\n');
const id='run-created-native', host='own-host', cwd=process.cwd();
let terminal=harness!=='opencode', prepared=false, closeAttempted=false, viewReads=0;
const session=()=>({id,harness,hostId:host,cwd,status:terminal?'idle':'running'});
const view=()=>({native_session_id:id,native_conversation_id:'actual-native',owned_page_id:42,
 owned_page_namespace:'vibe-'+'e'.repeat(64),source_route:'https://chatgpt.com/c/actual-native',
 creation_receipt:{created:true},navigation_receipt:{navigated:true},observedAt:new Date().toISOString()});
const pairs=[{prompt:'first prompt',token:'FIRST'},{prompt:'second prompt',token:'SECOND'}];
export async function readZcodeOfficialRunning(){const now=Date.now();return {pid:1234,generation:2,tasks:[],
 observedAt:new Date(now).toISOString(),expiresAt:new Date(now+15000).toISOString()};}
export function makeConfiguredAdapter(){return {
 nativeReadWithoutActivation:true,
 getPinnedCreateModel(){return process.env.AHAP_ZCODE_CREATE_MODEL;},
 async verifyPinnedCreateModel(){return {model:process.env.AHAP_ZCODE_CREATE_MODEL,source:'zcode-native-create-model-catalog',observed_at:new Date().toISOString()};},
 async init(){await log('init');},async getSession(){return session();},
 async verifyPinnedAccountScope(){},getAccountScope(){return 'd'.repeat(64);},getOwnedPageNamespace(){return 'vibe-'+'e'.repeat(64);},
 async prepareCanaryObservation(handle){if(handle!==id)throw Error('wrong handle');await log('prepare');prepared=true;return view();},
 async readCanaryObservation(handle){if(!prepared||handle!==id)throw Error('prepare required');await log('read_view_start');
  if(process.env.CI_TEST_VIEW_DELAY_MS)await new Promise(resolve=>setTimeout(resolve,Number(process.env.CI_TEST_VIEW_DELAY_MS)));
  await log('read_view_end');
  viewReads++;const current=session();if(process.env.CI_TEST_CLOSE_RUNNING==='1'&&viewReads>1)current.status='running';
  return {session:current,complete:true,observedAt:new Date().toISOString(),proof:{owned_view_receipt:view()}};},
 getCanaryViewReceipt(){return {control:id,pageId:42,closeAttempted,closed:false,...(prepared?{receipt:view()}:{} )};},
 async closeCanaryObservation(){await log('close_view');closeAttempted=true;if(process.env.CI_TEST_CLOSE_UNKNOWN==='1')throw Error('close unknown');return {page_id:42,closed:true};},
 async listActiveSessions(){return terminal?[]:[session()];},
 async getSessionMessages(){return [{id:'native-current-user',role:'user',text:'current canary prompt'}];},
 getActiveSessionSnapshotReceipt(){return {exhaustive:true,scope:'authorized_owner_active_sessions',source:'opencode-native-active-status',observedAt:new Date().toISOString()};},
 async getRawTranscript(){const now=Date.now();const raw={session:{sessionId:id,status:'idle',model:{providerId:'provider',modelId:'model'},workspace:{workspacePath:cwd,workspaceIdentity:cwd}},
  settings:{model:{current:{providerId:'provider',modelId:'model',options:{reasoningLevel:'enabled'}}}},
  projection:{sessionId:id,status:'idle',currentTurnId:'turn-second',pendingPermissions:[],activeToolCalls:[],backgroundJobs:[]},
  runtime:{eventSeq:30,stateRevision:3,pendingRequestIds:[]},messages:pairs.flatMap((p,i)=>[
   {info:{messageId:'u'+i,sessionId:id,role:'user'},parts:[{type:'text',text:p.prompt}]},
   {info:{messageId:'a'+i,parentMessageId:'u'+i,sessionId:id,role:'assistant',semantics:{origin:'agent_runtime',kind:'assistant_response'},finish:'stop',time:{created:now-10,completed:now-5}},parts:[{type:'text',text:p.token}]}])};
  return {complete:true,source:{kind:'native-api',location:'zcode app-server session/read',format:'json'},timestampCoverage:'native',bytes:Buffer.from(JSON.stringify(raw))};},
 async cancelTurn(){await log('cancel');terminal=true;if(process.env.CI_TEST_CANCEL_UNKNOWN==='1')throw Object.assign(Error('accepted outcome unknown'),{receipt:{nativeAccepted:true}});return {ok:true};},
 async close(){await log('close_sdk');}
};}
`;

async function withWorker(harness: 'chatgpt' | 'opencode' | 'zcode', flags: Record<string, string>, run: (value: {
  worker: NativeWorkerPort; binding: OwnedCanaryBinding; logs: () => Promise<string[]>;
}) => Promise<void>, timeouts: Partial<Record<'readSession' | 'close',number>> = {}) {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'ci-native-worker-'))), module=join(dir,'adapter.mjs'), log=join(dir,'calls.log');
  await writeFile(module,moduleSource);await writeFile(log,'');
  const worker=new NativeWorkerPort(harness+'-instance',harness,'own-host',module,
    createHash('sha256').update(moduleSource).digest('hex'),
    {HOME:dir,PATH:'/usr/bin:/bin',CI_TEST_HARNESS:harness,CI_TEST_LOG:log,...(harness==='zcode'?{AHAP_ZCODE_CREATE_MODEL:'provider/model$enabled'}:{}),...flags},dir,process.execPath,
    harness==='chatgpt'?'owned_current_conversations':harness==='zcode'?'pinned_official_server_owner':'owner_active_catalog',timeouts);
  const binding:OwnedCanaryBinding={runId:'own-run',coreSessionRef:'session:created-by-run',nativeId:'run-created-native',
    harness,hostId:'own-host',cwd:dir,createReceiptId:'confirmed-native-create'};
  try {await run({worker,binding,logs:async()=>(await readFile(log,'utf8')).trim().split('\n').filter(Boolean)});}
  finally {try{await worker.close();}catch{}await rm(dir,{recursive:true,force:true});}
}

describe('protected native reader child', {timeout:15000}, () => {
  it('prepares exactly one owned browser view for repeated reads of the original control handle', async () => {
    await withWorker('chatgpt',{},async({worker,binding,logs})=>{
      await worker.preflight();
      const first=await worker.readSession(binding.nativeId),second=await worker.readSession(binding.nativeId);
      expect(first.session.id).toBe(binding.nativeId);expect(second.proof?.owned_view_receipt.owned_page_id).toBe(42);
      await expect(worker.readSession('different-handle')).rejects.toThrow();
      await worker.close();await worker.close();
      expect((await logs()).filter(x=>x==='prepare')).toHaveLength(1);
      expect((await logs()).filter(x=>x==='close_view')).toHaveLength(1);
    });
  });
  it('preserves UNKNOWN owned-view close receipt and never dispatches another close', async () => {
    await withWorker('chatgpt',{CI_TEST_CLOSE_UNKNOWN:'1'},async({worker,binding,logs})=>{
      await worker.preflight();await worker.readSession(binding.nativeId);
      await expect(worker.close()).rejects.toMatchObject({receipt:{pageId:42,closeAttempted:true,closed:false}});
      await expect(worker.close()).rejects.toThrow();
      expect((await logs()).filter(x=>x==='close_view')).toHaveLength(1);
      expect((await logs()).filter(x=>x==='close_sdk')).toHaveLength(1);
    });
  });
  it('does not close a browser view when its formerly idle native session is now running',async()=>{
    await withWorker('chatgpt',{CI_TEST_CLOSE_RUNNING:'1'},async({worker,binding,logs})=>{
      await worker.preflight();expect((await worker.readSession(binding.nativeId)).session.status).toBe('idle');
      await expect(worker.close()).rejects.toMatchObject({receipt:{pageId:42,closeAttempted:false}});
      await expect(worker.close()).rejects.toThrow();
      expect((await logs()).filter(x=>x==='close_view')).toHaveLength(0);
      expect((await logs()).filter(x=>x==='prepare')).toHaveLength(1);
    });
  });
  it('retains the timed-out prepare receipt and serializes close after the original read without replay',async()=>{
    await withWorker('chatgpt',{CI_TEST_VIEW_DELAY_MS:'700'},async({worker,binding,logs})=>{
      await worker.preflight();
      await expect(worker.readSession(binding.nativeId)).rejects.toMatchObject({code:'native_read_timeout',
        receipt:{operation:'readSession',outcome:'UNKNOWN',progress:{phase:'browser_prepared',native_session_id:binding.nativeId}}});
      await worker.close();
      const all=await logs(),starts=all.flatMap((value,index)=>value==='read_view_start'?[index]:[]);
      expect(starts).toHaveLength(2);expect(starts[1]).toBeGreaterThan(all.indexOf('read_view_end'));
      expect(all.filter(value=>value==='prepare')).toHaveLength(1);expect(all.filter(value=>value==='close_view')).toHaveLength(1);
    },{readSession:300,close:3000});
  });
  it.each([false,true])('cancels once and reconciles terminal state after accepted/UNKNOWN: %s', async unknown => {
    await withWorker('opencode',unknown?{CI_TEST_CANCEL_UNKNOWN:'1'}:{},async({worker,binding,logs})=>{
      const expected={pairs:[{prompt:'current canary prompt',token:'CURRENT'}]};
      await worker.preflight();const before=await worker.readOwnedState(binding,expected);
      expect(before.terminal).toBe(false);expect(before.cancellation).toBe('supported');
      await expect(worker.cancelOwned({...binding,hostId:'foreign'},before,expected)).rejects.toThrow();
      await expect(worker.cancelOwned(binding,{...before,generation:'changed'},expected)).rejects.toThrow();
      await expect(worker.cancelOwned(binding,before,{pairs:[{prompt:'different canary prompt',token:'OTHER'}]})).rejects.toThrow();
      expect((await logs()).filter(x=>x==='cancel')).toHaveLength(0);
      if(unknown)await expect(worker.cancelOwned(binding,before,expected)).rejects.toMatchObject({receipt:{nativeAccepted:true}});
      else expect((await worker.cancelOwned(binding,before,expected)).accepted).toBe(true);
      expect((await worker.readOwnedState(binding,expected)).terminal).toBe(true);
      await expect(worker.cancelOwned(binding,before,expected)).rejects.toThrow();
      expect((await logs()).filter(x=>x==='cancel')).toHaveLength(1);
    });
  });
  it('retains an explicitly scoped official ZCode receipt without upgrading global coverage', async () => {
    await withWorker('zcode',{},async({worker,binding})=>{
      await worker.preflight();
      const observed=await worker.readSession(binding.nativeId,{pairs:[{prompt:'first prompt',token:'FIRST'},{prompt:'second prompt',token:'SECOND'}]});
      expect(observed.proof?.capability).toBe('official-server-canary');
      expect(observed.proof?.completed_message_ids).toEqual(['a0','a1']);
      const active=await worker.readActive();
      expect(active.scope).toBe('pinned_official_server_owner');expect(active.scopedComplete).toBe(true);expect(active.exhaustive).toBe(false);
      expect((await worker.readOwnedState(binding)).terminal).toBe(true);
    });
  });
});
