
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { dirname, isAbsolute, resolve } from "node:path";
import { createOpenAICompatibleJudge } from "../autopilot/index.js";
import { UserStyleStore } from "../autopilot/user-style.js";
import { getHumanStopStore } from "../human-stop-store.js";
import { createZaiBrowserJudgeFetch } from "../autopilot/zai-browser-judge.js";
import { MacMiniChromeTransport } from "../adapters/mac-mini-chrome-transport.js";
import { browserTransportSettingsFromEnv } from "../adapters/browser-runtime-settings.js";
import { ZaiUserIoJudgeSlot } from "../autopilot/zai-userio-judge.js";
import type { UserIoConfig } from "../adapters/userio-agent-channel.js";
import { NoticePlaceMcpPort } from "./v1-noticeplace-mcp.js";
import { V1BrowserAutopilot } from "./v1-browser-autopilot.js";

export type V1BrowserAutopilotConfig = {
  schemaVersion: 1;
  enabled: boolean;
  statePath: string;
  gptadminProfileFile: string;
  pollIntervalMs?: number;
  profiles: Array<{ instanceRef: string; nodeRef: string; label: string; cwd: string; sessionRefs: string[] }>;
  zai: (
    { transport: "browser"; accountScope: string; sshTarget?: string; browserMcpUrl?: string; browserMcpProfileFile?: string } |
    { transport: "userio"; profiles: Array<Omit<UserIoConfig, "fetcher">> } |
    { transport: "api"; baseUrl: string; tokenEnv?: string; tokenFile?: string }
  ) & { contextBytes?: number; timeoutMs?: number };
};
type ConsumerPorts = ConstructorParameters<typeof V1BrowserAutopilot>[0];
type Target = Parameters<ConsumerPorts["read"]>[0];
type Snapshot = Awaited<ReturnType<ConsumerPorts["read"]>>;
type Receipt = Awaited<ReturnType<ConsumerPorts["deliver"]>>;
export type BrowserNativeMcpPort = { call(tool: string, args: Record<string, unknown>): Promise<unknown>; close?(): Promise<void> };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("browser_autopilot_invalid_native_object");
  return value as Record<string, unknown>;
}
function value(result: unknown): Record<string, unknown> {
  const outer=object(result);
  if (outer.isError === true) throw new Error("browser_autopilot_native_read_refused");
  return outer.structuredContent ? object(outer.structuredContent) : outer;
}
function string(input: unknown): string {
  if (typeof input!=="string" || !input.trim() || /[\u0000-\u001f]/u.test(input)) throw new Error("browser_autopilot_invalid_identity");
  return input;
}
function key(target: Target): string { return JSON.stringify([target.instanceRef,target.sessionRef]); }
function digest(input: unknown): string { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }

export function validateV1BrowserAutopilotConfig(input: unknown): V1BrowserAutopilotConfig {
  const config=object(input);
  if (config.schemaVersion!==1 || typeof config.enabled!=="boolean" || !Array.isArray(config.profiles)) throw new Error("browser_autopilot_invalid_config");
  const statePath=string(config.statePath),gptadminProfileFile=string(config.gptadminProfileFile);
  if (!isAbsolute(statePath) || !isAbsolute(gptadminProfileFile)) throw new Error("browser_autopilot_absolute_paths_required");
  if (config.pollIntervalMs!==undefined && (!Number.isSafeInteger(config.pollIntervalMs) || Number(config.pollIntervalMs)<30_000 || Number(config.pollIntervalMs)>3_600_000))
    throw new Error("browser_autopilot_poll_interval_out_of_range");
  const instances=new Set<string>(),targets=new Set<string>();
  const profiles=config.profiles.map(raw=>{
    const row=object(raw);
    const instanceRef=string(row.instanceRef),nodeRef=string(row.nodeRef),label=string(row.label),cwd=string(row.cwd);
    if (!isAbsolute(cwd) || instances.has(instanceRef) || !Array.isArray(row.sessionRefs)) throw new Error("browser_autopilot_invalid_profile");
    instances.add(instanceRef);
    const sessionRefs=row.sessionRefs.map(item=>{
      const ref=string(item);
      const scoped=JSON.stringify([instanceRef,ref]);
      if (targets.has(scoped) || ref.includes("*")) throw new Error("browser_autopilot_duplicate_or_wildcard_target");
      targets.add(scoped);return ref;
    });
    return {instanceRef,nodeRef,label,cwd,sessionRefs};
  });
  if (config.enabled && !targets.size) throw new Error("browser_autopilot_requires_enrolled_sessions");
  const route=object(config.zai);
  if (route.contextBytes!==undefined && (!Number.isSafeInteger(route.contextBytes) || Number(route.contextBytes)<1024 || Number(route.contextBytes)>512*1024))
    throw new Error("browser_autopilot_context_budget_invalid");
  if (route.timeoutMs!==undefined && (!Number.isSafeInteger(route.timeoutMs) || Number(route.timeoutMs)<1_000 || Number(route.timeoutMs)>300_000))
    throw new Error("browser_autopilot_timeout_invalid");
  const common={...(route.contextBytes===undefined?{}:{contextBytes:Number(route.contextBytes)}),
    ...(route.timeoutMs===undefined?{}:{timeoutMs:Number(route.timeoutMs)})};
  let zai:V1BrowserAutopilotConfig["zai"];
  if(route.transport==="userio"){
    if(route.baseUrl!==undefined||route.tokenEnv!==undefined||route.tokenFile!==undefined
      ||route.sshTarget!==undefined||route.browserMcpUrl!==undefined
      ||route.browserMcpProfileFile!==undefined
      ||!Array.isArray(route.profiles)||route.profiles.length<1||route.profiles.length>3)
      throw new Error("browser_autopilot_zai_userio_profile_invalid");
    const seen=new Set<string>();
    const instances=route.profiles.map(value=>{
      const p=object(value);
      const endpoint=string(p.endpoint),agentId=string(p.agentId),
        instanceId=string(p.instanceId),accountScope=string(p.accountScope),
        tokenFile=string(p.tokenFile);
      let url:URL;
      try{url=new URL(endpoint);}catch{throw new Error("browser_autopilot_zai_userio_endpoint_invalid");}
      const local=["localhost","127.0.0.1","[::1]"].includes(url.hostname);
      if((url.protocol!=="https:" && !(local&&url.protocol==="http:"))
        ||url.pathname!=="/"||url.search||url.hash||url.username||url.password
        ||!/^[A-Za-z0-9_.:-]{1,128}$/u.test(agentId)
        ||!/^browser-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(instanceId)
        ||!/^[a-f0-9]{64}$/u.test(accountScope)||!isAbsolute(tokenFile)
        ||seen.has(instanceId))
        throw new Error("browser_autopilot_zai_userio_profile_invalid");
      seen.add(instanceId);
      return {endpoint:url.origin,agentId,instanceId,accountScope,tokenFile};
    });
    zai={transport:"userio",profiles:instances,...common};
  } else if(route.transport==="browser"){
    const accountScope=string(route.accountScope);
    if(!/^[a-f0-9]{64}$/u.test(accountScope) || route.baseUrl!==undefined || route.tokenEnv!==undefined || route.tokenFile!==undefined)
      throw new Error("browser_autopilot_zai_browser_binding_invalid");
    const sshTarget=route.sshTarget===undefined?undefined:string(route.sshTarget);
    if(sshTarget!==undefined && !/^[a-zA-Z_][\w.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/u.test(sshTarget))
      throw new Error("browser_autopilot_zai_browser_binding_invalid");
    const browserMcpUrl=route.browserMcpUrl===undefined?undefined:string(route.browserMcpUrl);
    const browserMcpProfileFile=route.browserMcpProfileFile===undefined?undefined:string(route.browserMcpProfileFile);
    if(browserMcpUrl||browserMcpProfileFile)
      throw new Error("browser_autopilot_zai_vibe_transport_disabled");
    zai={transport:"browser",accountScope,...(sshTarget?{sshTarget}:{}),...common};
  } else {
    if(route.transport!==undefined && route.transport!=="api")throw new Error("browser_autopilot_zai_transport_invalid");
    const baseUrl=string(route.baseUrl);
    if((route.tokenEnv===undefined)===(route.tokenFile===undefined))throw new Error("browser_autopilot_one_token_reference_required");
    const tokenEnv=route.tokenEnv===undefined?undefined:string(route.tokenEnv);
    const tokenFile=route.tokenFile===undefined?undefined:string(route.tokenFile);
    const url=new URL(baseUrl);
    if(url.protocol!=="https:" || url.hostname!=="api.z.ai" || url.port || url.username || url.password || url.search || url.hash
      || !/^\/api\/(?:coding\/)?paas\/v4\/?$/u.test(url.pathname))throw new Error("browser_autopilot_zai_route_mismatch");
    if(tokenEnv!==undefined && !/^[A-Z][A-Z0-9_]{1,127}$/u.test(tokenEnv))throw new Error("browser_autopilot_token_reference_invalid");
    if(tokenFile!==undefined && !isAbsolute(tokenFile))throw new Error("browser_autopilot_absolute_path_required");
    zai={transport:"api",baseUrl,...(tokenEnv?{tokenEnv}:{tokenFile:tokenFile!}),...common};
  }
  return {schemaVersion:1,enabled:config.enabled,statePath,gptadminProfileFile,profiles,
    ...(config.pollIntervalMs===undefined?{}:{pollIntervalMs:Number(config.pollIntervalMs)}),zai};
}

/** Configuration and credential references are owner-owned files, not chat arguments. */
async function readProtectedBrowserAutopilotText(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("browser_autopilot_absolute_path_required");
  const stat=await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode&0o077)!==0
    || (process.getuid && stat.uid!==process.getuid())) throw new Error("browser_autopilot_protected_file_required");
  return readFile(path,"utf8");
}
export async function readProtectedBrowserAutopilotJson(path: string): Promise<unknown> {
  return JSON.parse(await readProtectedBrowserAutopilotText(path));
}

/** One daemon owns a durable state path; independent copies cannot overwrite receipts. */
export async function acquireV1BrowserAutopilotLease(statePath:string,onCompromised:()=>void):Promise<()=>Promise<void>> {
  if(!isAbsolute(statePath))throw new Error("browser_autopilot_absolute_path_required");
  await mkdir(dirname(statePath),{recursive:true,mode:0o700});
  try {
    return await lockfile.lock(statePath,{realpath:false,lockfilePath:statePath+".worker.lock",
      retries:0,stale:60_000,update:10_000,onCompromised});
  } catch(error) {
    throw new Error((error as NodeJS.ErrnoException).code==="ELOCKED"
      ?"browser_autopilot_state_in_use":"browser_autopilot_lease_unavailable");
  }
}

function nativeMessage(raw: unknown) {
  const row=object(raw),id=string(row.id);
  if (row.role!=="user" && row.role!=="assistant" && row.role!=="tool" && row.role!=="system") throw new Error("browser_autopilot_native_role_invalid");
  let text=row.text;
  if (text===undefined && Array.isArray(row.parts)) text=row.parts.flatMap(part=>{
    if (!part || typeof part!=="object") return [];
    const item=part as Record<string,unknown>;
    return item.type==="text" && typeof item.text==="string" ? [item.text] : [];
  }).join("\n");
  if (text!==undefined && typeof text!=="string") throw new Error("browser_autopilot_native_text_invalid");
  return {id,role:row.role,text:typeof text==="string"?text:"",
    ...(typeof row.turnId==="string"?{turnId:row.turnId}:{}),
    ...(typeof row.inputId==="string"?{inputId:row.inputId}:{}),
    ...(typeof row.origin==="string"?{origin:row.origin}:{}),
    ...(typeof row.completionStatus==="string"?{completionStatus:row.completionStatus}:{}),
    ...(typeof row.endTurn==="boolean"?{endTurn:row.endTurn}:{}),
    ...(typeof row.phase==="string"?{phase:row.phase}:{})};
}

/** Only exact enrolled sessions travel through the authoritative Rust MCP port. */
export function createV1BrowserNativePorts(config: V1BrowserAutopilotConfig, port: BrowserNativeMcpPort) {
  const targetProfiles=new Map(config.profiles.flatMap(profile=>profile.sessionRefs.map(sessionRef=>[key({instanceRef:profile.instanceRef,sessionRef}),profile] as const)));
  const snapshots=new Map<string,{at:number;promise:Promise<Snapshot>}>();
  const lists=new Map<string,{at:number;promise:Promise<Record<string,unknown>[]>}>();
  const ttl=config.pollIntervalMs??60_000;
  function profile(target: Target) {
    const current=targetProfiles.get(key(target));
    if (!current) throw new Error("browser_autopilot_target_not_configured");
    return current;
  }
  async function rows(instanceRef: string,force: boolean) {
    const cached=lists.get(instanceRef);
    if (!force && cached && Date.now()-cached.at<ttl) return cached.promise;
    const promise=(async()=>{
      const result:Record<string,unknown>[]=[];let cursor:string|undefined;
      const visited=new Set<string>();
      for(let page=0;page<16;page++){
        const read=value(await port.call("sessions",{action:"list",instance_ref:instanceRef,...(cursor?{cursor}:{})}));
        if (!Array.isArray(read.sessions)) throw new Error("browser_autopilot_native_inventory_unavailable");
        result.push(...read.sessions.map(object));
        if (read.next_cursor==null) return result;
        cursor=string(read.next_cursor);
        if (visited.has(cursor)) throw new Error("browser_autopilot_native_cursor_cycle");
        visited.add(cursor);
      }
      throw new Error("browser_autopilot_native_inventory_incomplete");
    })();
    lists.set(instanceRef,{at:Date.now(),promise});
    // A cooldown/error is cached for this interval as well: never turn unavailable reads into a burst.
    return promise;
  }
  async function read(target: Target,_signal?:AbortSignal,force=false):Promise<Snapshot> {
    const bound=profile(target),cacheKey=key(target);
    if (_signal?.aborted) throw new DOMException("Cancelled","AbortError");
    const cached=snapshots.get(cacheKey);
    if (!force && cached && Date.now()-cached.at<ttl) return cached.promise;
    const promise=(async()=>{
      const matches=(await rows(bound.instanceRef,force)).filter(row=>row.session_ref===target.sessionRef);
      if(matches.length!==1)throw new Error("browser_autopilot_exact_session_unavailable");
      const row=matches[0]!,address=object(row.address),instance=object(address.instance),native=object(row.native),hold=object(row.human_stop);
      const nativeSessionId=string(address.native_session_id);
      if(instance.instance_id!==bound.instanceRef || instance.node!==bound.nodeRef || native.id!==nativeSessionId
        || native.harness!=="chatgpt" || native.cwd!==bound.cwd || typeof hold.held!=="boolean" || typeof native.needsPermission!=="boolean"
        || !["idle","running","needs_input","stopped","error"].includes(String(native.status)))
        throw new Error("browser_autopilot_native_binding_mismatch");
      const response=value(await port.call("session",{action:"messages",session_ref:target.sessionRef}));
      if(response.session_ref!==target.sessionRef)throw new Error("browser_autopilot_native_messages_mismatch");
      const page=object(response.page);
      if(!Array.isArray(page.messages))throw new Error("browser_autopilot_native_messages_unavailable");
      const messages=page.messages.map(nativeMessage);
      const status=native.needsPermission?"needs_input":native.status;
      return {...target,nativeSessionId,cwd:bound.cwd,status,humanStopHeld:hold.held,
        revision:digest({address,status,humanStopHeld:hold.held,messages,model:native.model??null}),messages,
        ...(typeof native.model==="string"?{model:native.model}:{})} as Snapshot;
    })();
    snapshots.set(cacheKey,{at:Date.now(),promise});
    return promise;
  }
  function receipt(raw:unknown,receiptRef?:string):Receipt {
    let root:Record<string,unknown>;
    try {root=object(raw);}catch{return {status:"unknown",...(receiptRef?{receiptRef}:{})} as Receipt;}
    const failed=root.isError===true;
    if(root.structuredContent)root=object(root.structuredContent);
    if(root.effect==="none")return {status:"rejected",reason:"native_admission_refused",...(receiptRef?{receiptRef}:{})} as Receipt;
    if(!failed && root.outcome==="confirmed" && typeof root.native_receipt_id==="string" && root.native_receipt_id)
      return {status:"confirmed",...(receiptRef?{receiptRef}:{}),...(typeof root.native_message_id==="string"?{messageId:root.native_message_id}:{})} as Receipt;
    return {status:"unknown",...(receiptRef?{receiptRef}:{})} as Receipt;
  }
  return {
    read:(target:Target,signal?:AbortSignal)=>read(target,signal),
    canApply:async(target:Target,snapshot:Snapshot)=>{
      const current=await read(target);
      return config.enabled && current.revision===snapshot.revision && current.status==="idle" && !current.humanStopHeld;
    },
    deliver:async(input:Parameters<ConsumerPorts["deliver"]>[0]):Promise<Receipt>=>{
      if(!config.enabled)return {status:"rejected",reason:"autopilot_disabled"} as Receipt;
      const fresh=await read(input.target,input.signal,true);
      if(!config.enabled || fresh.revision!==input.expectedRevision || fresh.nativeSessionId!==input.nativeSessionId || fresh.status!=="idle" || fresh.humanStopHeld || input.signal?.aborted)
        return {status:"rejected",reason:"native_fence_changed"} as Receipt;
      let raw:Record<string,unknown>;
      try {raw=object(await port.call("deliver",{action:"session",session_ref:input.target.sessionRef,message:input.message,mode:"queue",request_key:input.requestKey}));}
      catch {return {status:"unknown",reason:"native_delivery_receipt_unavailable"} as Receipt;}
      if(raw.isError===true)return receipt(raw);
      if(raw.structuredContent)raw=object(raw.structuredContent);
      const ref=raw.task_ref??((raw.resultType==="task"||raw.native_task===true)?raw.taskId:undefined)??raw._herder_delivery_task;
      snapshots.delete(key(input.target));lists.delete(input.target.instanceRef);
      if(typeof ref==="string"&&ref)return {status:"accepted",receiptRef:ref} as Receipt;
      return receipt(raw);
    },
    reconcile:async(input:Parameters<ConsumerPorts["reconcile"]>[0]):Promise<Receipt>=>{
      profile(input.target);
      const ref=input.receipt?.receiptRef;
      const unknown:Receipt={status:"unknown",...(ref?{receiptRef:ref}:{}),reason:"native_delivery_unverified"};
      const fromHistory=async():Promise<Receipt>=>{
        const evidence=input.evidence;
        if(!evidence)return unknown;
        try {
          const fresh=await read(input.target,input.signal,true);
          if(fresh.nativeSessionId!==evidence.nativeSessionId)return unknown;
          const anchors=fresh.messages.flatMap((message,index)=>message.id===evidence.assistantMessageId?[index]:[]);
          if(anchors.length!==1)return unknown;
          const users=fresh.messages.slice(anchors[0]!+1).filter(message=>message.role==="user");
          // Confirm the effect only at the original turn boundary. A later
          // matching quote or a second identical user message is ambiguous.
          if(!users.length || users[0]!.text!==evidence.message
            || users.filter(message=>message.text===evidence.message).length!==1)return unknown;
          return {status:"confirmed",messageId:users[0]!.id,...(ref?{receiptRef:ref}:{})} as Receipt;
        } catch {return unknown;}
      };
      if(!ref)return fromHistory();
      let task:Record<string,unknown>;
      try {task=value(await port.call("compat_task",{action:"get",task_ref:ref}));}
      catch{return fromHistory();}
      if(task.taskId!==ref || task.resultType!=="complete")return fromHistory();
      if(task.status==="working")return {status:"accepted",receiptRef:ref} as Receipt;
      if(task.status!=="completed")return fromHistory();
      const result=receipt(task.result,ref);
      return result.status==="unknown"?fromHistory():result;
    },
  };
}

export async function createV1BrowserAutopilotRuntime(input:unknown,options:{port?:BrowserNativeMcpPort;env?:NodeJS.ProcessEnv}={}) {
  const config=validateV1BrowserAutopilotConfig(input),env=options.env??process.env;
  let port=options.port;
  if(!port){
    const profile=object(await readProtectedBrowserAutopilotJson(config.gptadminProfileFile));
    const authorization=string(profile.authorization);
    const token=authorization.replace(/^Bearer\s+/iu,"");
    if(!token || /[\r\n]/u.test(token))throw new Error("browser_autopilot_native_credential_unavailable");
    port=new NoticePlaceMcpPort(async()=>token);
  }
  const zai=config.zai;
  const token=zai.transport==="api"?(zai.tokenEnv ? env[zai.tokenEnv]
    : config.enabled ? (await readProtectedBrowserAutopilotText(zai.tokenFile!)).trim() : undefined)
    :undefined;
  if(config.enabled && zai.transport==="api" && (!token?.trim() || /[\r\n]/u.test(token) || /^(?:secret:|secret_ref:|gptadmin-secret:)/u.test(token)))
    throw new Error("browser_autopilot_zai_credential_unavailable");
  const browserTools=zai.transport==="browser"?new MacMiniChromeTransport(zai.sshTarget,30_000,browserTransportSettingsFromEnv(env)):undefined;
  const browserPool=zai.transport==="api"?undefined:createZaiBrowserJudgeFetch({
    accountScope:zai.transport==="userio"?zai.profiles[0]!.accountScope:zai.accountScope,
    ...(browserTools?{tools:browserTools}:{}),
    ...(zai.transport==="userio"?{createSlot:(_model:unknown,index:number)=>
      new ZaiUserIoJudgeSlot(zai.profiles[index%zai.profiles.length]!)}:{}),
    maxPromptBytes:512*1024,responseTimeoutMs:zai.timeoutMs??240_000,
  });
  const native=createV1BrowserNativePorts(config,port);
  const service=new V1BrowserAutopilot({
    statePath:resolve(config.statePath),holdUnfinishedJudgingOnRestart:zai.transport!=="api",...native,
    isGeneratedPrompt:async(target,message)=>{
      const snapshot=await native.read(target);
      return getHumanStopStore().isGeneratedPrompt("chatgpt",snapshot.nativeSessionId,
        {text:message.text,...(message.inputId?{turnId:message.inputId}:{})});
    },
    createJudge:({signal,shouldContinue})=>createOpenAICompatibleJudge({
      baseUrl:zai.transport==="api"?zai.baseUrl:"https://chat.z.ai/autopilot",
      model:"glm-5.3",token,retryPolicy:"zai-cycle",contextBytes:zai.contextBytes??128*1024,
      timeoutMs:zai.timeoutMs??(browserPool?240_000:90_000),signal,shouldContinue,
      ...(browserPool?{fetchImpl:browserPool.withGuard(shouldContinue)}:{}),
      styleStore:new UserStyleStore(resolve(config.statePath)+".style.json"),
    }),
  });
  const configured=new Set(config.profiles.flatMap(profile=>profile.sessionRefs.map(sessionRef=>key({instanceRef:profile.instanceRef,sessionRef}))));
  for(const target of (await service.inspect()).targets)
    if(!configured.has(key(target)))await service.setEnabled(target,false);
  for(const profile of config.profiles)for(const sessionRef of profile.sessionRefs)
    await service.setEnabled({instanceRef:profile.instanceRef,sessionRef},config.enabled);
  return {config,service,close:async()=>{service.stop();await service.settle();await browserPool?.close();await port?.close?.();}};
}
