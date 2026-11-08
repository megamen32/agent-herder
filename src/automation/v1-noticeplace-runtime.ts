import { isSecretMarker } from '../web/settings-store.js';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AutomationLaunchPolicyStore } from '../automation-launch-policy.js';
import { ProjectLaunchAttemptLog } from './project-launch-dispatch.js';
import { OpenCodeAdapter } from '../adapters/opencode.js';
import { createNoticePlaceIncidentRouter, createNoticePlaceRustRunner } from './v1-noticeplace-rust.js';
import { NoticePlaceMcpPort } from './v1-noticeplace-mcp.js';
import { createExistingNoticePlaceOwnerStateProvider } from './v1-noticeplace-owner-state.js';
import { NOTICEPLACE_V1_MODEL } from './v1-noticeplace-launch.js';
import { AutopilotSessionStore } from '../autopilot/session-store.js';
import { HerderJobRegistry } from '../herder-jobs.js';
import { herderEvents } from '../herder-events.js';
import { HumanRequestRegistry } from '../human-request/index.js';
import { ChoiceRegistry } from '../autopilot/choice-registry.js';
import { PendingQuestionGate } from '../autopilot/pending-question-gate.js';
import { createIncidentUpdateSink, deliverIncidentQuestion } from '../autopilot/notice-incident.js';
import { createNoticePlaceSink } from '../autopilot/index.js';

type Config = {
  noticeplaceBearerEnv:string; noticeplaceEnvFile:string; gptadmin:{target:string;profileFile:string}; policyPath:string; stateDirectory:string; cwd:string;
  instance:{instanceRef:string;harness:'opencode';model:string;deliveryMode:'start'|'queue';baseUrl:string;passwordEnv?:string};
};

function object(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function canonical(value:unknown):unknown{return Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;}

/** Map only the installed Rust row, messages and HumanStop receipt into autopilot's snapshot. */
export function noticePlaceSnapshot(rowValue:unknown,messagesValue:unknown){
  const row=object(rowValue),native=object(row.native),address=object(row.address),hold=object(row.human_stop);
  const page=object(object(messagesValue).page),messages=page.messages;
  if(typeof row.session_ref!=='string'||typeof address.native_session_id!=='string'||typeof native.cwd!=='string'
    ||typeof native.status!=='string'||typeof native.model!=='string'||typeof hold.held!=='boolean'||!Array.isArray(messages))
    throw new Error('rust_authoritative_snapshot_contract_unavailable');
  const rows=messages as Array<Record<string,unknown>>;
  let terminal:Record<string,unknown>|undefined;
  for(let index=rows.length-1;index>=0;index--){const message=rows[index]!;if(message.role==='assistant'&&typeof message.turnId==='string'&&message.turnId.trim()){terminal=message;break;}}
  // A freshly created/running session may not have an assistant turn yet. Keep
  // that state explicit; completion handling must later provide a real turn ID.
  const turnId=typeof terminal?.turnId==='string'?terminal.turnId:'';
  const revision=createHash('sha256').update(JSON.stringify(canonical({row,messages:rows}))).digest('hex');
  return {sessionRef:row.session_ref,nativeSessionId:address.native_session_id,cwd:native.cwd,status:native.status,humanStopHeld:hold.held,turnId,revision,model:native.model,messages:rows};
}

export type NoticePlaceCompletionEvent={kind:string;sessionId?:string;data?:Record<string,unknown>};
export type NoticePlaceCompletionSource={subscribeEvents(listener:(event:NoticePlaceCompletionEvent)=>void):()=>void};
export type NoticePlaceSessionReadFactory=(input:{port:{call(tool:string,args:Record<string,unknown>,operationKey?:string):Promise<unknown>};instanceRef:string;cwd:string})=>{read(sessionRef:string,kind:'progress'|'details'):Promise<unknown>};
export function createNoticePlaceSessionReadAdapter(factory:NoticePlaceSessionReadFactory,port:{call(tool:string,args:Record<string,unknown>,operationKey?:string):Promise<unknown>},instanceRef:string,cwd:string){
  const handler=factory({port,instanceRef,cwd});
  if(!handler||typeof handler.read!=='function')throw new Error('noticeplace_session_read_provider_missing');
  return {read:(sessionRef:string,kind:'progress'|'details')=>handler.read(sessionRef,kind)};
}
export function createNoticePlaceCompletionRegistrar(source:NoticePlaceCompletionSource,listSessions:()=>Promise<Array<{session_ref:string;address:{native_session_id:string}}>>,timeoutMs=10_000){
  return async (sessionRef:string,callback:(event:{sessionRef:string;nativeSessionId:string;turnId:string})=>Promise<unknown>)=>{
    let active=false,closed=false,unsubscribe=()=>{};
    let connectedResolve!:()=>void,connectedReject!:(error:Error)=>void;
    const connected=new Promise<void>((resolve,reject)=>{connectedResolve=resolve;connectedReject=reject;});
    const timer=setTimeout(()=>connectedReject(new Error('opencode_event_stream_connect_timeout')),Math.max(1,timeoutMs));
    const close=()=>{if(closed)return;closed=true;active=false;clearTimeout(timer);unsubscribe();};
    const installedUnsubscribe=source.subscribeEvents(event=>{
      if(event.kind==='process.connected'){active=true;connectedResolve();return;}
      if(event.kind==='process.disconnected'){close();connectedReject(new Error('opencode_event_stream_disconnected'));return;}
      if(!active||event.kind!=='turn.completed'||!event.sessionId)return;
      const turnId=event.data?.turnId;
      if(typeof turnId!=='string'||!turnId.trim())return;
      void listSessions().then(rows=>{
        const matches=rows.filter(row=>row.address?.native_session_id===event.sessionId);
        if(!closed&&active&&matches.length===1&&matches[0]!.session_ref===sessionRef)
          return callback({sessionRef,nativeSessionId:event.sessionId!,turnId});
      }).catch(()=>undefined);
    });
    unsubscribe=installedUnsubscribe;
    if(closed)unsubscribe();
    try{await connected;clearTimeout(timer);if(!active||closed)throw new Error('opencode_event_stream_not_active');}
    catch(error){close();throw error;}
    return {isActive:()=>active&&!closed,close};
  };
}

export function createNoticePlaceRustAutopilotPort(port:{call(tool:string,args:Record<string,unknown>,operationKey?:string):Promise<unknown>},instanceRef:string){
  const value=(value:unknown):Record<string,unknown>=>object(value);
  const listSessions=async()=>{
    const payload=value(await port.call('sessions',{action:'list',instance_ref:instanceRef}));
    if(!Array.isArray(payload.sessions))throw new Error('rust_session_registry_unknown');
    return payload.sessions as Array<{session_ref:string;address:{native_session_id:string};native:{harness:string;cwd:string}|null;human_stop?:{held?:unknown}}>;
  };
  const snapshot=async(sessionRef:string)=>{
    const matches=(await listSessions()).filter(row=>row.session_ref===sessionRef);
    if(matches.length!==1||matches[0]!.native?.harness!=='opencode')throw new Error('exact_rust_session_unavailable');
    const messages=value(await port.call('session',{action:'messages',session_ref:sessionRef}));
    return noticePlaceSnapshot(matches[0],messages);
  };
  return {listSessions,snapshot,async deliver(input:{sessionRef:string;nativeSessionId:string;message:string;requestKey:string;model:string;expectedRevision:string;turnId:string}){
    const fresh=await snapshot(input.sessionRef);
    if(fresh.nativeSessionId!==input.nativeSessionId||fresh.revision!==input.expectedRevision||fresh.turnId!==input.turnId
      ||fresh.model!==input.model||fresh.humanStopHeld||fresh.status!=='idle')throw new Error('noticeplace_snapshot_changed');
    return port.call('deliver',{action:'session',session_ref:input.sessionRef,message:input.message,mode:'current',request_key:input.requestKey},input.requestKey);
  }};
}

async function protectedJson(path:string):Promise<Record<string,unknown>> {
  const info=await stat(path);
  if(!info.isFile()||(info.mode&0o777)!==0o600||info.uid!==process.getuid?.()) throw new Error('protected_profile_invalid');
  const value:unknown=JSON.parse(await readFile(path,'utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('protected_profile_invalid');
  return value as Record<string,unknown>;
}

/** Read existing credential references only. No adoption, rotation or store writes. */
export async function loadNoticePlaceSecretReferences(path:string,keys:string[],env:NodeJS.ProcessEnv=process.env):Promise<void> {
  const unresolved=keys.filter(key=>env[key]!==undefined&&isSecretMarker(env[key]!));
  if(!unresolved.length)return;
  const data=await protectedJson(path),secrets=object(data.secrets);
  for(const key of unresolved){
    const value=secrets[key];
    if(typeof value!=='string'||!value.trim()||isSecretMarker(value))throw new Error('noticeplace_secret_reference_unavailable');
    env[key]=value;
  }
}

/** Assemble the real one-instance NoticePlace facade; secrets remain in protected providers/in-memory headers. */
export async function createNoticePlaceRuntime(config:Config) {
  if(config.instance.instanceRef!=='opencode-noticeplace-local'||config.instance.harness!=='opencode'||config.instance.model!==NOTICEPLACE_V1_MODEL)
    throw new Error('noticeplace_instance_pin_mismatch');
  await loadNoticePlaceSecretReferences(join(dirname(config.noticeplaceEnvFile),'secrets.json'),[
    config.noticeplaceBearerEnv,config.instance.passwordEnv??'OPENCODE_SERVER_PASSWORD','NOTIFY_CENTER_TOKEN',
  ]);
  const profile=await protectedJson(config.gptadmin.profileFile);
  const auth=profile.authorization;
  if(typeof profile.endpoint!=='string'||typeof auth!=='string'||!auth||typeof process.env[config.noticeplaceBearerEnv]!=='string')throw new Error('noticeplace_protected_profile_incomplete');
  const token=auth.replace(/^Bearer\s+/iu,'');
  if(!token||/\r|\n/u.test(token))throw new Error('noticeplace_protected_profile_incomplete');
  const mcp=new NoticePlaceMcpPort(async()=>token);
  const port={call:(tool:'sessions'|'create'|'deliver'|'compat_task'|'stop'|'session',args:Record<string,unknown>,_operationKey?:string)=>mcp.call(tool,args)};
  const stateDir=resolve(config.stateDirectory);
  const instance={instanceRef:config.instance.instanceRef,harness:'opencode' as const,model:NOTICEPLACE_V1_MODEL as typeof NOTICEPLACE_V1_MODEL,cwd:resolve(config.cwd),deliveryMode:config.instance.deliveryMode};
  const openCode=new OpenCodeAdapter({baseUrl:config.instance.baseUrl,password:config.instance.passwordEnv?process.env[config.instance.passwordEnv]:undefined});
  await openCode.init();
  const runner=createNoticePlaceRustRunner({port,instance,incidentRouter:createNoticePlaceIncidentRouter(join(stateDir,'incident-source-sessions.json'),port,instance)});
  const policyStore=new AutomationLaunchPolicyStore(resolve(config.policyPath));
  const attempts=new ProjectLaunchAttemptLog(join(stateDir,'project-launch-attempts.json'));
  // Validate that protected policy exists and is usable before opening a socket.
  if((await policyStore.load()).kind!=='valid')throw new Error('noticeplace_launch_policy_unavailable');
  // Both components are loaded relative to this module in the same immutable SHA bundle.
  const classModule=await import(new URL('./v1-noticeplace-autopilot.js',import.meta.url).href);
  const judgeModule=await import(new URL('./v1-noticeplace-judge.js',import.meta.url).href);
  const sessionReadModule=await import(new URL('./v1-noticeplace-session-read.js',import.meta.url).href);
  if(typeof classModule.V1NoticePlaceAutopilot!=='function'||typeof judgeModule.createNoticePlaceNativeJudge!=='function')throw new Error('noticeplace_native_autopilot_components_missing');
  if(typeof sessionReadModule.createNoticePlaceSessionRead!=='function')throw new Error('noticeplace_session_read_factory_missing');
  const sessionRead=createNoticePlaceSessionReadAdapter(sessionReadModule.createNoticePlaceSessionRead,port,instance.instanceRef,instance.cwd);
  const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
  const rust=createNoticePlaceRustAutopilotPort(port,instance.instanceRef);
  const listSessions=rust.listSessions;
  const store=new AutopilotSessionStore(join(stateDir,'sessions.json'));
  const jobs=new HerderJobRegistry(herderEvents,{persistencePath:join(stateDir,'v1-noticeplace-jobs.json')});
  const humanRequests=new HumanRequestRegistry(join(stateDir,'human-requests.json'));
  const choiceRegistry=new ChoiceRegistry(join(stateDir,'choices.json'));
  const registerCompletion=createNoticePlaceCompletionRegistrar(openCode,listSessions);
  const callback={eventUrl:process.env.NOTIFY_CENTER_EVENT_URL,token:process.env.NOTIFY_CENTER_TOKEN};
  const service=new classModule.V1NoticePlaceAutopilot({store,jobs,stateDir,rust,registerCompletion,
    createJudge:()=>judgeModule.createNoticePlaceNativeJudge({port,instanceRef:instance.instanceRef,jobs,stateDir,revision:async (input:{hook:{session_id?:string}})=>{
      const rows=await listSessions();
      const matches=rows.filter(row=>row.address?.native_session_id===input.hook.session_id);
      if(matches.length!==1)throw new Error('native_judge_session_binding_unknown');
      return (await rust.snapshot(matches[0]!.session_ref)).revision;
    }}),
    core:{notify:createNoticePlaceSink({eventUrl:callback.eventUrl??'',token:callback.token??''}),incidentUpdates:createIncidentUpdateSink(),
      deliverHumanQuestion:deliverIncidentQuestion,pendingQuestions:new PendingQuestionGate({humanRequests,choices:choiceRegistry}),humanRequests,choiceRegistry,maxContinuationsPerSession:3},
  });
  const autopilot={
    async get(input:{harness:string;sessionId:string;cwd:string}){
      if(input.harness!=='opencode')throw new Error('unsupported_autopilot_harness');
      const matches=(await listSessions()).filter(row=>row.session_ref===input.sessionId);
      if(matches.length!==1||matches[0]!.native?.cwd!==input.cwd)return {enabled:false,sessionId:input.sessionId};
      const result=await service.get(input.sessionId);
      return {enabled:result.armed===true,sessionId:input.sessionId};
    },
    async arm(input:{harness:string;sessionId:string;cwd:string;enabled:boolean;noticeIncident?:{incidentId:string;project:string};noticeAttempt?:{incidentId:string;attemptId:string}}){
      if(input.harness!=='opencode')throw new Error('unsupported_autopilot_harness');
      const matches=(await listSessions()).filter(row=>row.session_ref===input.sessionId);
      if(matches.length!==1||matches[0]!.native?.cwd!==input.cwd)throw new Error('exact_autopilot_cwd_unavailable');
      const result=await service.arm({sessionRef:input.sessionId,enabled:input.enabled,...(input.noticeIncident?{noticeIncident:input.noticeIncident}:{}),...(input.noticeAttempt?{noticeAttempt:input.noticeAttempt}:{})});
      return {enabled:result.armed===true,sessionId:input.sessionId};
    },
  };
  await service.restore();
  return {policyStore,attempts,runner,ownerState:createExistingNoticePlaceOwnerStateProvider(),autopilot,sessionRead};
}
