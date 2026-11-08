import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationLaunchPolicyStore } from '../src/automation-launch-policy.js';
import { dispatchProjectLaunch, ProjectLaunchAttemptLog } from '../src/automation/project-launch-dispatch.js';
import { createNoticePlaceIncidentRouter, createNoticePlaceRustRunner, type NoticePlaceRustToolPort } from '../src/automation/v1-noticeplace-rust.js';
import { NOTICEPLACE_V1_MODEL } from '../src/automation/v1-noticeplace-launch.js';
import { createV1NoticePlaceServer } from '../src/v1-noticeplace-server.js';
import { noticePlaceOwnerNodeStatus, validateNoticePlaceOwnerState } from '../src/automation/v1-noticeplace-owner-state.js';

const token = 'test-only-noticeplace-token';
let root: string;
let servers: Server[];
let wireCalls: Array<{tool:string,args:Record<string,unknown>;key?:string}>;
let wireMode: 'normal'|'delayed-complete'|'unknown-create'|'partial-create'|'nested-create-prompt-unknown'|'iserror-create-unknown'|'human-stop'|'completed-without-admission' = 'normal';
let taskReads = 0;
let ownerMode: 'confirmed'|'unknown'|'stopped' = 'confirmed';
let sessionReadCalls:Array<{sessionRef:string;kind:'progress'|'details'}>;

beforeEach(async () => { root = await mkdtemp(join(process.cwd(),'.tmp/noticeplace-v1-')); servers=[]; wireCalls=[]; wireMode='normal'; taskReads=0; ownerMode='confirmed'; sessionReadCalls=[]; vi.stubEnv('NOTICEPLACE_HEALTH_LAUNCH_TOKEN',token); });
afterEach(async () => { await Promise.all(servers.map(s=>new Promise<void>(resolve=>s.close(()=>resolve())))); vi.unstubAllEnvs(); await rm(root,{recursive:true,force:true}); });

const policy = {
  version:1 as const, allowedHarnesses:['opencode' as const], preferredHarness:'opencode' as const,
  models:{opencode:NOTICEPLACE_V1_MODEL},
  projectRoutes:{'/workspace/infra':{harnesses:['opencode' as const],models:{opencode:NOTICEPLACE_V1_MODEL},aliases:['infra-service']}},
};
const facts = {id:'incident-opaque-42',project:'infra-service',source_id:'monitor-a',consumer_id:'consumer-a',host_id:'server-100',problem_type:'service'};
const input = {purpose:'noticeplace.health-analysis',project:'infra-service',cwd:'/workspace/infra',message:`Repair from trusted telemetry\n${JSON.stringify(facts)}`,operation_id:'op-stable-42',harness:'opencode',model:NOTICEPLACE_V1_MODEL,mode:'queue'};

function fakeRust(): NoticePlaceRustToolPort & { calls: Array<{tool:string,args:Record<string,unknown>;key?:string}> } {
  const state = { calls: [] as Array<{tool:string,args:Record<string,unknown>;key?:string}> };
  return { ...state, async call(tool,args,key) {
    state.calls.push({tool,args,key}); wireCalls.push({tool,args,key});
    if (tool==='create') return {structuredContent:{task_ref:'task-create-1',status:'working',native_task:true}};
    if (tool==='compat_task') {
      taskReads++;
      if (wireMode==='delayed-complete' && taskReads===1) return {structuredContent:{resultType:'complete',taskId:'task-create-1',status:'working'}};
      if (args.task_ref==='delivery-task-2') return {structuredContent:{resultType:'complete',taskId:'delivery-task-2',status:'completed',result:{isError:wireMode==='human-stop',structuredContent:wireMode==='human-stop'?{code:'human_stop',effect:'none'}:{outcome:'confirmed',native_receipt_id:'native-receipt-2'}}}};
      if (wireMode==='unknown-create') return {structuredContent:{resultType:'complete',taskId:'task-create-1',status:'completed',result:{isError:true,structuredContent:{create:{effect:'unknown'},prompt:{effect:'unknown',code:'outcome_unknown'}}}}};
      if (wireMode==='partial-create'||wireMode==='iserror-create-unknown') return {structuredContent:{resultType:'complete',taskId:'task-create-1',status:'completed',result:{isError:true,structuredContent:{create:{effect:'confirmed',session_ref:'session-ref-1'},prompt:{effect:'unknown',code:'outcome_unknown'}}}}};
      if (wireMode==='nested-create-prompt-unknown') return {structuredContent:{resultType:'complete',taskId:'task-create-1',status:'completed',result:{isError:false,structuredContent:{create:{effect:'confirmed',session_ref:'session-ref-1',metadata:{state:'confirmed'}},prompt:{effect:'unknown',code:'outcome_unknown',metadata:{admitted:true,state:'confirmed'}}}}}};
      if (wireMode==='human-stop') return {structuredContent:{resultType:'complete',taskId:'task-create-1',status:'completed',result:{isError:true,structuredContent:{create:{effect:'confirmed',session_ref:'session-ref-1'},prompt:{code:'human_stop',effect:'none'}}}}};
      if (wireMode==='completed-without-admission') return {structuredContent:{resultType:'complete',taskId:'task-create-1',status:'completed',result:{isError:false,structuredContent:{create:{effect:'confirmed',session_ref:'session-ref-1'},prompt:{}}}}};
      return {structuredContent:{resultType:'complete',taskId:'task-create-1',status:'completed',result:{isError:false,structuredContent:{create:{effect:'confirmed',session_ref:'session-ref-1'},prompt:{outcome:'confirmed',native_receipt_id:'native-receipt-1'}}}}};
    }
    if (tool==='sessions') return {structuredContent:{sessions:[{session_ref:'session-ref-1',native:{status:'stopped',title:'repair'}}],complete:true,next_cursor:null}};
    if (tool==='deliver') return {structuredContent:{task_ref:'delivery-task-2',status:'working',native_task:true}};
    throw new Error(`unexpected tool ${tool}`);
  }};
}

async function listen(): Promise<{server:Server;url:string}> {
  const rust=fakeRust();
  const policyStore=new AutomationLaunchPolicyStore(join(root,'policy.json'));
  await policyStore.replace(policy);
  const attempts=new ProjectLaunchAttemptLog(join(root,'attempts.json'));
  const instance={instanceRef:'opencode-instance-test',harness:'opencode' as const,model:NOTICEPLACE_V1_MODEL,cwd:'/workspace/infra',deliveryMode:'start' as const};
  const runner=createNoticePlaceRustRunner({port:rust,instance,incidentRouter:createNoticePlaceIncidentRouter(join(root,'incident-bindings.json'),rust,instance)});
  const ownerState={async read():Promise<unknown>{
    if(ownerMode==='unknown') return {ok:false};
    return {ok:true,state:{disarmed:ownerMode==='confirmed'?false:true,records:[{scope:'*',forbidden:ownerMode==='stopped'}]},nodes:['server-100','server-44','server-88'].map(hostId=>({hostId,status:'confirmed'}))};
  }};
  const autopilot={async get({sessionId}:{sessionId:string}){return {enabled:false,sessionId};},async arm({sessionId,enabled}:{sessionId:string;enabled:boolean}){return {enabled,sessionId};}};
  const server=createV1NoticePlaceServer({policyStore,attempts,runner,ownerState,autopilot,sessionRead:{async read(sessionRef,kind){sessionReadCalls.push({sessionRef,kind});return kind==='progress'?{session:{id:sessionRef},progress:{items:['legacy-progress-shape']}}:{session:{id:sessionRef},details:{messages:['legacy-details-shape']}};}}});
  servers.push(server);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); if(!address||typeof address==='string')throw new Error('missing local test address');
  return {server,url:`http://127.0.0.1:${address.port}`};
}

describe('V1 NoticePlace HTTP → Rust MCP consumer',()=>{
  it('can disarm only the addressed test session after repair',async()=>{
    const {url}=await listen();
    const response=await fetch(`${url}/api/autopilot/sessions/opencode/session-ref-1`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false,cwd:'/workspace/infra'})});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({enabled:false,sessionId:'session-ref-1'});
    expect(wireCalls).toHaveLength(0);
  });
  it('serves the installed OpenCode progress/details paths through the injected legacy-shape reader',async()=>{
    const {url}=await listen();
    const progress=await fetch(`${url}/api/sessions/opencode/session-ref-1/progress?limit=5&history=auto`);
    const details=await fetch(`${url}/api/sessions/opencode/session-ref-1/details?limit=1&history=auto`);
    expect(progress.status).toBe(200);
    expect(await progress.json()).toEqual({session:{id:'session-ref-1'},progress:{items:['legacy-progress-shape']}});
    expect(details.status).toBe(200);
    expect(await details.json()).toEqual({session:{id:'session-ref-1'},details:{messages:['legacy-details-shape']}});
    expect(sessionReadCalls).toEqual([{sessionRef:'session-ref-1',kind:'progress'},{sessionRef:'session-ref-1',kind:'details'}]);
    expect(wireCalls).toHaveLength(0);
  });

  it('rejects other harnesses and non-installed read query shapes without touching the reader',async()=>{
    const {url}=await listen();
    expect((await fetch(`${url}/api/sessions/codex/session-ref-1/progress?limit=5&history=auto`)).status).toBe(400);
    expect((await fetch(`${url}/api/sessions/opencode/session-ref-1/details?limit=5&history=auto`)).status).toBe(400);
    expect(sessionReadCalls).toHaveLength(0);
  });

  it('does not let a running local owner file mask a remote STOP',()=>{
    expect(noticePlaceOwnerNodeStatus({disarmed:false,records:[{scope:'*',forbidden:false}]})).toBe('confirmed');
    expect(noticePlaceOwnerNodeStatus({disarmed:true,records:[{scope:'*',forbidden:false}]})).toBe('stopped');
    expect(noticePlaceOwnerNodeStatus({disarmed:false,records:[{scope:'*',forbidden:true}]})).toBe('stopped');
    expect(validateNoticePlaceOwnerState({ok:true,state:{disarmed:false,records:[{scope:'*',forbidden:false}]},nodes:[
      {hostId:'server-100',status:'confirmed'},{hostId:'server-44',status:'stopped'},{hostId:'server-88',status:'confirmed'},
    ]})).toBeUndefined();
  });
  it('polls the durable receipt read without repeating create mutation',async()=>{
    wireMode='delayed-complete';
    const {url}=await listen();
    const response=await fetch(`${url}/api/automation/project-launch`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)});
    expect(await response.json()).toMatchObject({outcome:'accepted',sessionId:'session-ref-1'});
    expect(wireCalls.filter(call=>call.tool==='create')).toHaveLength(1);
    expect(wireCalls.filter(call=>call.tool==='compat_task')).toHaveLength(2);
  });
  it.each(['unknown','stopped'] as const)('exposes fail-closed fleet disarm state and blocks launch for %s',async(mode)=>{
    ownerMode=mode;
    const {url}=await listen();
    const response=await fetch(`${url}/api/settings/automation/disarm`);
    expect(response.status).toBe(503);
    const denied=await fetch(`${url}/api/automation/project-launch`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)});
    expect(denied.status).toBe(503);
    expect(wireCalls).toHaveLength(0);
  });
  it('requires unique confirmed reports from each required fleet node',async()=>{
    const {url}=await listen();
    const response=await fetch(`${url}/api/settings/automation/disarm`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,state:{disarmed:false,records:[{scope:'*',forbidden:false}]},nodes:[{hostId:'server-100',status:'confirmed'},{hostId:'server-44',status:'confirmed'},{hostId:'server-88',status:'confirmed'}]});
  });
  it('reads policy, creates once, resumes the retained Rust session, and survives facade restart',async()=>{
    const first=await listen();
    const policyResponse=await fetch(`${first.url}/api/automation/launch-policy`);
    expect(policyResponse.status).toBe(200);
    expect((await policyResponse.json()).models.opencode).toBe(NOTICEPLACE_V1_MODEL);
    const post=()=>fetch(`${first.url}/api/automation/project-launch`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)});
    const admitted=await post();
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toMatchObject({incidentId:facts.id,operationId:input.operation_id,outcome:'accepted',sessionId:'session-ref-1'});
    await new Promise<void>(resolve=>first.server.close(()=>resolve()));
    servers=servers.filter(s=>s!==first.server);

    const second=await listen();
    // Same operation survives restart as a receipt read; no Rust mutation is replayed.
    const replay=await (await fetch(`${second.url}/api/automation/project-launch`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)})).json();
    expect(replay).toMatchObject({outcome:'accepted',sessionId:'session-ref-1'});
    // New operation in the same source group delivers to the exact retained Rust session.
    const followup=await fetch(`${second.url}/api/automation/project-launch`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({...input,operation_id:'op-stable-43',message:`follow-up\n${JSON.stringify(facts)}`})});
    const followupResult=await followup.json();
    expect(followupResult,JSON.stringify({followupResult,wireCalls})).toMatchObject({outcome:'accepted',sessionId:'session-ref-1'});
    expect(wireCalls.filter(call=>call.tool==='create')).toHaveLength(1);
    expect(wireCalls.filter(call=>call.tool==='deliver')).toHaveLength(1);
    expect(wireCalls.filter(call=>call.tool==='create')[0]?.args.request_key).toBe('herder-launch:opencode:op-stable-42');
    expect(wireCalls.filter(call=>call.tool==='deliver')[0]).toMatchObject({args:{session_ref:'session-ref-1',mode:'start'},key:'herder-launch:opencode:op-stable-43'});
    expect(Object.keys(wireCalls.filter(call=>call.tool==='deliver')[0]!.args).sort()).toEqual(['action','message','mode','request_key','session_ref']);
  });

  it('requires exact runtime route and bearer before any Rust tool call',async()=>{
    const {url}=await listen();
    const denied=await fetch(`${url}/api/automation/project-launch`,{method:'POST',headers:{authorization:'Bearer invalid','content-type':'application/json'},body:JSON.stringify(input)});
    expect(denied.status).toBe(403);
    const wrongModel=await fetch(`${url}/api/automation/project-launch`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({...input,model:'omniroute/minimax-combo-m3.1'})});
    expect(wrongModel.status).toBe(400);
  });

  it('keeps Rust UNKNOWN terminal across a facade restart',async()=>{
    wireMode='unknown-create';
    const first=await listen();
    const post=()=>fetch(`${first.url}/api/automation/project-launch`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)});
    expect(await (await post()).json()).toMatchObject({outcome:'admission_unknown'});
    await new Promise<void>(resolve=>first.server.close(()=>resolve())); servers=servers.filter(s=>s!==first.server);
    const second=await listen();
    expect(await (await fetch(`${second.url}/api/automation/project-launch`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)})).json()).toMatchObject({outcome:'admission_unknown'});
    expect(wireCalls.filter(call=>call.tool==='create')).toHaveLength(1);
  });

  it('lets Rust HumanStop refusal hold the retained session without creating a replacement',async()=>{
    const {url}=await listen();
    const post=(operation_id:string)=>fetch(`${url}/api/automation/project-launch`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({...input,operation_id})});
    expect(await (await post('op-first')).json()).toMatchObject({outcome:'accepted'});
    wireMode='human-stop';
    expect(await (await post('op-after-stop')).json()).toMatchObject({outcome:'human_hold'});
    expect(wireCalls.filter(call=>call.tool==='create')).toHaveLength(1);
    expect(wireCalls.filter(call=>call.tool==='deliver')).toHaveLength(1);
  });

  it.each(['partial-create','nested-create-prompt-unknown','iserror-create-unknown','completed-without-admission'] as const)(
    'preserves confirmed create session but never upgrades %s to admitted',async(mode)=>{
      wireMode=mode;
      const {url}=await listen();
      const post=(operation_id:string)=>fetch(`${url}/api/automation/project-launch`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({...input,operation_id})});
      const first=await (await post('op-partial')).json();
      expect(first).toMatchObject({outcome:'admission_unknown',sessionId:'session-ref-1'});
      const bindings=JSON.parse(await readFile(join(root,'incident-bindings.json'),'utf8'));
      expect(Object.values(bindings.groups)).toContainEqual(expect.objectContaining({sessionId:'session-ref-1',pending:'herder-launch:opencode:op-partial'}));
      // Same unchanged source group is still fenced; it cannot create a replacement.
      const second=await (await post('op-new-after-partial')).json();
      expect(second).toMatchObject({outcome:'admission_unknown'});
      expect(wireCalls.filter(call=>call.tool==='create')).toHaveLength(1);
      expect(wireCalls.filter(call=>call.tool==='deliver')).toHaveLength(0);
    });

  it('classifies Rust human_stop code from the exact create prompt shape',async()=>{
    wireMode='human-stop';
    const {url}=await listen();
    const result=await (await fetch(`${url}/api/automation/project-launch`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(input)})).json();
    expect(result).toMatchObject({outcome:'human_hold',sessionId:'session-ref-1'});
    expect(wireCalls.filter(call=>call.tool==='create')).toHaveLength(1);
  });
});
