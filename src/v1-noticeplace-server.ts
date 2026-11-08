import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dispatchProjectLaunch, ProjectLaunchAttemptLog, type ProjectLaunchRunner } from './automation/project-launch-dispatch.js';
import { AutomationLaunchPolicyStore } from './automation-launch-policy.js';
import { hasNoticeplaceHealthBearer, NOTICEPLACE_HEALTH_AUTHORIZED, NOTICEPLACE_HEALTH_PURPOSE } from './automation/noticeplace-health-launch.js';
import { incidentSessionPolicy } from './automation/incident-session-router.js';
import { NOTICEPLACE_V1_MODEL } from './automation/v1-noticeplace-launch.js';
import { validateNoticePlaceOwnerState, type NoticePlaceOwnerStateProvider } from './automation/v1-noticeplace-owner-state.js';
import { resumeNoticePlaceSession, type NoticePlaceResumePort } from './automation/v1-noticeplace-resume.js';

const POLICY_PATH = '/api/automation/launch-policy';
const LAUNCH_PATH = '/api/automation/project-launch';
const BODY_LIMIT = 2 * 1024 * 1024;
const DISARM_PATH = '/api/settings/automation/disarm';
const AUTOPILOT_PATH = /^\/api\/autopilot\/sessions\/([^/]+)\/([^/]+)$/u;
const SESSION_READ_PATH = /^\/api\/sessions\/([^/]+)\/([^/]+)\/(progress|details)$/u;
const SESSION_RESUME_PATH = /^\/api\/sessions\/([^/]+)\/([^/]+)\/resume$/u;

export type NoticePlaceSessionIdentityPort = {
  /** Resolve an exact native ID or a historical core ref to its scoped core ref. */
  toCoreRef(id:string):Promise<string|null>;
  /** Resolve an exact scoped core ref to its native session ID. */
  toNativeId(coreRef:string):Promise<string|null>;
};

export type NoticePlaceSessionReadPort = {
  /** Existing owner-owned reader returns the legacy helper response shape. */
  read(sessionRef:string,kind:'progress'|'details'):Promise<unknown>;
};

export type NoticePlaceAutopilotPort = {
  ready?(): Promise<boolean>;
  get(input: {harness:string;sessionId:string;cwd:string}): Promise<{enabled:boolean;sessionId:string}>;
  arm(input: {harness:string;sessionId:string;cwd:string;enabled:boolean;noticeIncident?:{incidentId:string;project:string};noticeAttempt?:{incidentId:string;attemptId:string}}): Promise<{enabled:boolean;sessionId:string}>;
};

export type V1NoticePlaceServerOptions = {
  policyStore: AutomationLaunchPolicyStore;
  attempts: ProjectLaunchAttemptLog;
  runner: ProjectLaunchRunner;
  /** Parent wires the actual fleet stores through protected existing transport. */
  ownerState: NoticePlaceOwnerStateProvider;
  /** Real Autopilot session store + native Stop judge/observer adapter. Missing means fail-closed. */
  autopilot?: NoticePlaceAutopilotPort;
  /** Read-only compatibility adapter supplied by the session-read owner. */
  sessionRead?: NoticePlaceSessionReadPort;
  /** Exact scoped identity lookup; required for all consumer-facing session IDs. */
  identity: NoticePlaceSessionIdentityPort;
  /** Authenticated Rust facade tool port used only for exact-session resume. */
  resume: NoticePlaceResumePort;
};

function send(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'content-length':Buffer.byteLength(body) });
  response.end(body);
}

async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const item of request) {
    const chunk = Buffer.from(item);
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required');
  return value as Record<string, unknown>;
}

function textField(body: Record<string, unknown>, key: string, max = 32768): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value) ? value : undefined;
}

function resumeMessage(value:unknown):string|undefined {
  return typeof value==='string'&&value.trim().length>0&&Buffer.byteLength(value)<=BODY_LIMIT&&!/[\u0000-\u0008\u000b\u000c\u000d-\u001f\u007f]/u.test(value)?value:undefined;
}

function incidentIdentity(body: Record<string, unknown>, message: string): string | undefined {
  const direct = textField(body,'incident_id',512);
  if (direct) return direct;
  // The installed repair-first consumer embeds the original bounded telemetry
  // facts as JSON in its prompt. IDs are opaque; no prefix is assumed.
  for (const line of message.split('\n').reverse()) {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const facts = value as Record<string,unknown>;
      const id = typeof facts.id === 'string' ? facts.id : facts.incident_id;
      if (typeof id === 'string' && id.trim() && id.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(id)) return id;
    } catch { /* Telemetry prose is not executable input. */ }
  }
}

/** Standalone compatibility HTTP facade; deliberately separate from the legacy daemon and shared web server. */
export function createV1NoticePlaceServer(options: V1NoticePlaceServerOptions): Server {
  return createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const resumeMatch=path.match(SESSION_RESUME_PATH);
      if(request.method==='POST'&&resumeMatch){
        let harness:string,sessionId:string;
        try{harness=decodeURIComponent(resumeMatch[1]!);sessionId=decodeURIComponent(resumeMatch[2]!);}catch{return send(response,400,{error:'invalid session reference'});}
        if(harness!=='opencode'||!sessionId||sessionId.length>512||/[\/\r\n\0]/u.test(sessionId))return send(response,400,{error:'unsupported harness or invalid session id'});
        const body=await bodyOf(request);
        const message=resumeMessage(body.message), inputId=textField(body,'inputId',512);
        if(!message||body.humanRequested!==false||!inputId)return send(response,400,{error:'message, humanRequested:false and inputId are required'});
        const ownerState=validateNoticePlaceOwnerState(await options.ownerState.read());
        if(!ownerState)return send(response,503,{ok:false,admitted:false,outcome:'human_hold',code:'human_stop_active',inputId,error:'Fleet owner STOP is active or owner state is unknown; resume was not attempted'});
        let coreRef:string|null,nativeId:string|null;
        try{coreRef=await options.identity.toCoreRef(sessionId);nativeId=coreRef?await options.identity.toNativeId(coreRef):null;}
        catch{return send(response,503,{outcome:'admission_unknown',error:'Exact session identity is unavailable'});}
        if(!coreRef||!nativeId)return send(response,404,{error:'session identity is not present in the configured scope'});
        const result=await resumeNoticePlaceSession({port:options.resume,coreSessionRef:coreRef,message,humanRequested:false,inputId});
        return send(response,result.outcome==='accepted'?200:result.outcome==='admission_unknown'?503:409,{
          ...result,ok:result.outcome==='accepted',admitted:result.outcome==='accepted',sessionId:nativeId,inputId,
        });
      }
      const sessionReadMatch=path.match(SESSION_READ_PATH);
      if(request.method==='GET'&&sessionReadMatch){
        if(!options.sessionRead)return send(response,503,{error:'Session read provider is unavailable'});
        let harness:string,sessionRef:string;
        try{harness=decodeURIComponent(sessionReadMatch[1]!);sessionRef=decodeURIComponent(sessionReadMatch[2]!);}catch{return send(response,400,{error:'invalid session reference'});}
        if(harness!=='opencode'||!sessionRef||sessionRef.length>512||/[\/\r\n\0]/u.test(sessionRef))return send(response,400,{error:'unsupported harness or invalid session reference'});
        const url=new URL(request.url??'/', 'http://127.0.0.1');
        const kind=sessionReadMatch[3] as 'progress'|'details';
        const expectedLimit=kind==='progress'?'5':'1';
        if(url.searchParams.get('limit')!==expectedLimit||url.searchParams.get('history')!=='auto')return send(response,400,{error:'unsupported session read options'});
        try{
          const coreRef=await options.identity.toCoreRef(sessionRef);
          const nativeId=coreRef?await options.identity.toNativeId(coreRef):null;
          if(!coreRef||!nativeId)return send(response,404,{error:'session identity is not present in the configured scope'});
          const value=await options.sessionRead.read(coreRef,kind);
          if(value&&typeof value==='object'&&!Array.isArray(value)){
            const payload=value as Record<string,unknown>,session=payload.session;
            if(session&&typeof session==='object'&&!Array.isArray(session))return send(response,200,{...payload,session:{...(session as Record<string,unknown>),id:nativeId}});
          }
          return send(response,200,value);
        }
        catch{return send(response,503,{error:'Session read is unavailable'});}
      }
      const autopilotMatch = path.match(AUTOPILOT_PATH);
      if (autopilotMatch && (request.method === 'GET' || request.method === 'PUT')) {
        if (!options.autopilot) return send(response,503,{error:'Autopilot judge/observer port is unavailable; state is UNKNOWN'});
        const harness = decodeURIComponent(autopilotMatch[1]);
        const requestedId = decodeURIComponent(autopilotMatch[2]);
        const sessionId = requestedId;
        if (harness !== 'opencode' || !sessionId || sessionId.length > 128 || /[\r\n\0]/u.test(sessionId)) return send(response,400,{error:'unsupported harness or invalid session id'});
        let coreRef:string|null,nativeId:string|null;
        try{coreRef=await options.identity.toCoreRef(sessionId);nativeId=coreRef?await options.identity.toNativeId(coreRef):null;}
        catch{return send(response,503,{error:'Exact session identity is unavailable'});}
        if(!coreRef||!nativeId)return send(response,404,{error:'session identity is not present in the configured scope'});
        const cwd = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('cwd') || '';
        if (request.method === 'GET') {
          if (!cwd) return send(response,400,{error:'cwd is required for an exact session read'});
          const state = await options.autopilot.get({harness,sessionId:coreRef,cwd});
          return state.sessionId === coreRef ? send(response,200,{harness,sessionId:nativeId,core_session_ref:coreRef,enabled:state.enabled}) : send(response,503,{error:'Autopilot session read is UNKNOWN'});
        }
        const body = await bodyOf(request);
        if (typeof body.enabled !== 'boolean' || typeof body.cwd !== 'string' || !body.cwd.trim()) return send(response,400,{error:'enabled:boolean and cwd are required'});
        const noticeIncident = body.noticeIncident === undefined ? undefined : body.noticeIncident as {incidentId:string;project:string};
        const noticeAttempt = body.noticeAttempt === undefined ? undefined : body.noticeAttempt as {incidentId:string;attemptId:string};
        const validPair = (value: unknown, keys: string[]) => {
          const item = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined;
          return Boolean(item && keys.every(key => typeof item[key] === 'string' && (item[key] as string).trim() && (item[key] as string).length <= 128 && !/[\r\n\0]/u.test(item[key] as string)));
        };
        if ((noticeIncident && !validPair(noticeIncident,['incidentId','project'])) || (noticeAttempt && !validPair(noticeAttempt,['incidentId','attemptId']))) return send(response,400,{error:'notice bindings are invalid'});
        const armed = await options.autopilot.arm({harness,sessionId:coreRef,cwd:body.cwd,enabled:body.enabled,...(noticeIncident?{noticeIncident}:{}),...(noticeAttempt?{noticeAttempt}:{})});
        return armed.enabled === body.enabled && armed.sessionId === coreRef ? send(response,200,{...armed,sessionId:nativeId,core_session_ref:coreRef,harness}) : send(response,503,{error:'Autopilot arm/observer confirmation is UNKNOWN'});
      }
      if (request.method === 'GET' && path === DISARM_PATH) {
        const state = validateNoticePlaceOwnerState(await options.ownerState.read());
        if (!state) return send(response,503,{ok:false,error:'Fleet owner state is unknown or stopped'});
        return send(response,200,state);
      }
      if (request.method === 'GET' && path === POLICY_PATH) {
        const loaded = await options.policyStore.readDocument();
        if (loaded.kind !== 'valid') return send(response,503,{error:'Launch policy unavailable',state:loaded.kind});
        response.setHeader('etag',loaded.etag);
        return send(response,200,loaded.policy);
      }
      if (request.method !== 'POST' || path !== LAUNCH_PATH) return send(response,404,{error:'not found'});
      if (!hasNoticeplaceHealthBearer(request.headers.authorization)) return send(response,403,{error:'NoticePlace incident launch is not authorized'});
      const input = await bodyOf(request);
      if (input.purpose !== NOTICEPLACE_HEALTH_PURPOSE) return send(response,403,{error:'unsupported launch purpose'});
      const project = textField(input,'project',4096), cwd = textField(input,'cwd',4096);
      const rawMessage = input.message;
      const message = typeof rawMessage === 'string' && rawMessage.trim() && Buffer.byteLength(rawMessage) <= BODY_LIMIT && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(rawMessage) ? rawMessage : undefined;
      const operationId = textField(input,'operation_id',512);
      const incidentId = incidentIdentity(input,message ?? '');
      const harness = input.harness;
      const model = input.model;
      if (!project || !cwd || !message || !operationId || !incidentId || harness !== 'opencode' || model !== NOTICEPLACE_V1_MODEL)
        return send(response,400,{error:'project, cwd, original incident identity, stable operation_id and exact OpenCode MiniMax route are required'});
      const ownerState = validateNoticePlaceOwnerState(await options.ownerState.read());
      if (!ownerState) return send(response,503,{outcome:'human_hold',error:'Fleet owner STOP is active or owner state is unknown; launch was not attempted'});
      if (!options.autopilot) return send(response,503,{outcome:'admission_unknown',error:'Autopilot judge/observer port is not wired; launch was not attempted'});
      if (options.autopilot.ready && !await options.autopilot.ready()) return send(response,503,{outcome:'admission_unknown',error:'Authoritative Rust snapshot, native completion, or judge port is UNKNOWN; launch was not attempted'});
      let policy;
      try {
        policy = incidentSessionPolicy(input.incident_session_policy);
      } catch (error) {
        return send(response,400,{error:(error as Error).message});
      }
      const loaded = await options.policyStore.load();
      if (loaded.kind !== 'valid') return send(response,503,{error:'Launch policy unavailable'});
      const mode = input.mode === 'sync' ? 'sync' : 'queue';
      const result = await dispatchProjectLaunch({
        [NOTICEPLACE_HEALTH_AUTHORIZED]:true,
        policy:loaded.policy,
        project,cwd,message,operationId,harness,model,mode,
        incidentSessionPolicy:policy,
      },options.attempts,options.runner);
      const present=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
      const toNative=async(coreRef:string):Promise<string|null>=>{
        try{return await options.identity.toNativeId(coreRef);}catch{return null;}
      };
      const mapped=async(value:Record<string,unknown>):Promise<Record<string,unknown>>=>{
        if(typeof value.sessionId!=='string'||!value.sessionId)return value;
        const coreRef=value.sessionId;
        const nativeId=await toNative(coreRef);
        if(nativeId)return {...value,sessionId:nativeId,session_id:nativeId,core_session_ref:coreRef};
        const unresolved:Record<string,unknown>={...value,core_session_ref:coreRef,identity:'unknown'};
        delete unresolved.sessionId;
        delete unresolved.session_id;
        return unresolved;
      };
      const responseResult=await mapped({...result,incidentId,purpose:NOTICEPLACE_HEALTH_PURPOSE});
      const identityUnknown=responseResult.identity==='unknown';
      if(identityUnknown)responseResult.outcome='admission_unknown';
      if(Array.isArray(result.attempts)){
        responseResult.attempts=await Promise.all(result.attempts.map(async attempt=>{
          if(!present(attempt))return attempt;
          const next:Record<string,unknown>={...attempt};
          if(typeof next.sessionId==='string'&&next.sessionId){
            const coreRef=next.sessionId,nativeId=await toNative(coreRef);
            if(nativeId){next.sessionId=nativeId;next.session_id=nativeId;next.core_session_ref=coreRef;}
            else{delete next.sessionId;delete next.session_id;next.core_session_ref=coreRef;next.identity='unknown';}
          }
          if(present(next.result))next.result=await mapped(next.result);
          return next;
        }));
      }
      return send(response,identityUnknown?503:200,responseResult);
    })().catch(() => {
      // Avoid reflecting arbitrary transport errors, tokens or provider payloads.
      if (!response.headersSent) send(response,500,{error:'NoticePlace facade operation failed; mutation outcome may be UNKNOWN'});
      else response.end();
    });
  });
}
