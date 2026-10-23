import type { SessionWorkspace, SessionWorkspaceIdentity } from "./session-workspaces.js";
import { sessionWorkspaceKey, SessionWorkspaceStore } from "./session-workspaces.js";
/** Call from bounded startup/native-event ingestion, never from inventory queries.
 * Only native tool execution and explicit startup/project declarations qualify.
 * Callers must provide the actual execution host: runtime/GUI host and cwd are not evidence.
 */
export interface NativeWorkspaceEvidence extends SessionWorkspaceIdentity {
  hostId: string;
  absolutePath: string;
  observedAt: string;
  evidenceRef: string;
  kind: "startup_declaration" | "native_tool_execution" | "project_binding" | "coordination_declaration";
}
export async function backfillSessionWorkspaces(store:SessionWorkspaceStore,evidence:NativeWorkspaceEvidence[]):Promise<{updated:number;unchanged:number}> {
  let updated=0,unchanged=0;
  const groups=new Map<string,NativeWorkspaceEvidence[]>();
  for(const item of evidence){const key=sessionWorkspaceKey(item)+":"+item.observedAt;const group=groups.get(key)??[];group.push(item);groups.set(key,group);}
  for(const group of [...groups.values()].sort((a,b)=>Date.parse(a[0].observedAt)-Date.parse(b[0].observedAt))){
    const item=group[0],previous=await store.read(item);
    // A historical import must never resurrect a location after a newer replace/clear.
    if(previous && Date.parse(previous.updatedAt)>=Date.parse(item.observedAt)){unchanged+=group.length;continue;}
    const workspaces:SessionWorkspace[]=group.map(entry=>({hostId:entry.hostId,absolutePath:entry.absolutePath,observedAt:entry.observedAt,source:entry.kind==="native_tool_execution"?"observed":"declared",evidence:`${entry.kind}:${entry.evidenceRef}`}));
    await store.declare({...item,workspaces,mode:"union",expectedVersion:previous?.version??0});updated+=group.length;
  }
  return {updated,unchanged};
}

/** Extract only execution context explicitly carried by native tools. No title,
 * GUI cwd or arbitrary transcript-wide pathname matching is allowed here. */
export function workspaceEvidenceFromNativeMessages(input:SessionWorkspaceIdentity & {workHostId:string;messages:Array<Record<string,unknown>>}):NativeWorkspaceEvidence[] {
  const output:NativeWorkspaceEvidence[]=[];
  for(const message of input.messages){
    const observedAt=typeof message.timestamp==="number"?new Date(message.timestamp).toISOString():typeof message.timestamp==="string"?message.timestamp:"";
    if(!Number.isFinite(Date.parse(observedAt)))continue;
    const calls=Array.isArray(message.tool_calls)?message.tool_calls:[];
    for(const call of calls){
      if(!call||typeof call!=="object")continue;
      const tool=call as Record<string,unknown>;
      let args=tool.tool_call_args;
      if(typeof args==="string"){try{args=JSON.parse(args);}catch{continue;}}
      if(!args||typeof args!=="object")continue;
      const a=args as Record<string,unknown>,name=String(tool.tool_name??"");
      const paths:string[]=[];
      // cwd is valid only for a tool that actually executes code, never a
      // coordination/human request where it usually describes the GUI launch.
      if(/(?:^|__)(?:bash|shell_exec|exec_command|ctx_execute|ctx_execute_file)$/.test(name)){
        for(const field of ["workdir","cwd"]){if(typeof a[field]==="string"&&a[field].startsWith("/"))paths.push(a[field]);}
        const command=typeof a.command==="string"?a.command:typeof a.code==="string"?a.code:"";
        for(const match of command.matchAll(/\b(?:cd\s+|git\s+-C\s+)["']?(\/home\/roomhacker\/[^\s"';&|)]+)/g))paths.push(match[1]);
      }
      for(const absolutePath of new Set(paths))output.push({runtimeHostId:input.runtimeHostId,harness:input.harness,nativeSessionId:input.nativeSessionId,hostId:input.workHostId,absolutePath,observedAt,evidenceRef:`native-message:${String(message.msg_id??"unknown")}:tool:${String(tool.tool_call_id??name)}`,kind:"native_tool_execution"});
    }
  }
  return output;
}

/** Migrate the existing declaration seam only after inventory proves an exact,
 * unambiguous runtime identity. Bare native IDs shared by hosts/harnesses are
 * intentionally skipped; this never changes the old coordination ledger. */
export function workspaceEvidenceFromLegacyDeclarations(input:{identities:SessionWorkspaceIdentity[];declarations:Array<{sessionId:string;harness:string;hostId:string;cwd:string;expiresAt:string}>;observedAt:string}):NativeWorkspaceEvidence[]{
  const output:NativeWorkspaceEvidence[]=[];
  for(const declaration of input.declarations){
    if(Date.parse(declaration.expiresAt)<=Date.parse(input.observedAt))continue;
    const matches=input.identities.filter(i=>i.nativeSessionId===declaration.sessionId&&i.harness===declaration.harness);
    if(matches.length!==1)continue;
    output.push({...matches[0],hostId:declaration.hostId,absolutePath:declaration.cwd,observedAt:input.observedAt,evidenceRef:`coordination-workspace:${declaration.sessionId}:expires:${declaration.expiresAt}`,kind:"coordination_declaration"});
  }
  return output;
}

export interface WorkspaceOwnerSession extends SessionWorkspaceIdentity { parentSessionId?:string; lastActivity:string }
/** Owner refresh seam: bounded native reader runs during ingestion only, at
 * most once per changed/unknown session per minute. Inventory queries do no I/O.
 * readEvidence must use explicit/native execution contexts, never launch cwd. */
export function createSessionWorkspaceOwnerUpdater(deps:{store:SessionWorkspaceStore;readEvidence:(session:WorkspaceOwnerSession)=>Promise<NativeWorkspaceEvidence[]>;now?:()=>number}) {
  const attempted=new Map<string,{activity:string;at:number}>();
  const now=deps.now??Date.now;
  return async(sessions:WorkspaceOwnerSession[]):Promise<void>=>{
    const records=await deps.store.readMany(sessions);
    for(const session of sessions){
      const key=sessionWorkspaceKey(session),prior=attempted.get(key),record=records.get(key);
      if(record?.workspaces.length || (prior && (prior.activity===session.lastActivity || now()-prior.at<60_000)))continue;
      attempted.set(key,{activity:session.lastActivity,at:now()});
      await backfillSessionWorkspaces(deps.store,await deps.readEvidence(session));
    }
    // Parent locations come from an exact native parent relationship and retain
    // that provenance. They never come from a matching title or GUI workspace.
    const refreshed=await deps.store.readMany([...sessions,...sessions.filter(s=>s.parentSessionId).map(s=>({...s,nativeSessionId:s.parentSessionId!}))]);
    for(const session of sessions){
      if(refreshed.get(sessionWorkspaceKey(session))?.workspaces.length || !session.parentSessionId)continue;
      const parent=refreshed.get(sessionWorkspaceKey({...session,nativeSessionId:session.parentSessionId}));
      if(!parent?.workspaces.length)continue;
      const existing=await deps.store.read(session);
      if(existing)continue; // Explicit unknown/clear is intentional, not permission to infer.
      const observedAt=new Date(now()).toISOString();
      await deps.store.declare({...session,mode:"union",expectedVersion:0,observedAt,workspaces:parent.workspaces.map(w=>({...w,observedAt,source:"declared",evidence:`parent_declaration:${session.parentSessionId}:v${parent.version}:${w.evidence??"declared"}`}))});
    }
    const active=new Set(sessions.map(sessionWorkspaceKey));for(const key of attempted.keys())if(!active.has(key))attempted.delete(key);
  };
}

/** Native reader for the owner updater. The work-host resolver must come from
 * explicit per-session declarations or a verified execution transport; it must
 * not default to the desktop/runtime hostname. */
export function createMavisWorkspaceEvidenceReader(deps:{
  control:{getMessages:(id:string,options:{limit:number})=>Promise<{ok:boolean;body:unknown}>};
  workHostForSession:(session:WorkspaceOwnerSession)=>Promise<string|undefined>;
}) {
  return async(session:WorkspaceOwnerSession):Promise<NativeWorkspaceEvidence[]>=>{
    if(session.harness!=="minimax-code")return [];
    const workHostId=await deps.workHostForSession(session);if(!workHostId)return [];
    const result=await deps.control.getMessages(session.nativeSessionId,{limit:40});
    if(!result.ok)throw new Error("Native workspace evidence unavailable");
    const body=result.body as {messages?:unknown};
    if(!body||!Array.isArray(body.messages))throw new Error("Malformed native workspace evidence");
    return workspaceEvidenceFromNativeMessages({...session,workHostId,messages:body.messages.filter((m):m is Record<string,unknown>=>!!m&&typeof m==="object")});
  };
}
