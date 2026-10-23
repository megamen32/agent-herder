import { mkdir, readFile, rename, writeFile, stat } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";

export interface SessionWorkspaceIdentity { runtimeHostId: string; harness: string; nativeSessionId: string }
export interface SessionWorkspace { hostId: string; absolutePath: string; source: "declared" | "observed"; observedAt: string; evidence?: string }
export interface SessionWorkspaceRecord extends SessionWorkspaceIdentity { version: number; updatedAt: string; workspaces: SessionWorkspace[] }
export interface SessionWorkspaceUpdate extends SessionWorkspaceIdentity { workspaces: SessionWorkspace[]; mode: "replace" | "union"; expectedVersion?: number; observedAt: string }
const text = (value: string, label: string): string => { if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error(`Invalid ${label}`); return value.trim(); };
function identity(input: SessionWorkspaceIdentity): SessionWorkspaceIdentity { return {runtimeHostId:text(input.runtimeHostId,"runtimeHostId").toLowerCase(),harness:text(input.harness,"harness").toLowerCase(),nativeSessionId:text(input.nativeSessionId,"nativeSessionId")}; }
export function sessionWorkspaceKey(input: SessionWorkspaceIdentity): string { const i=identity(input); return JSON.stringify([i.runtimeHostId,i.harness,i.nativeSessionId]); }
function timestamp(value: string): string { if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid observation timestamp"); return new Date(value).toISOString(); }
function workspace(input: SessionWorkspace): SessionWorkspace {
  const absolutePath=text(input.absolutePath,"absolutePath");
  if (!absolutePath.startsWith("/") || absolutePath.includes("\0")) throw new Error("Workspace must have an absolute POSIX path");
  if (input.source !== "declared" && input.source !== "observed") throw new Error("Invalid workspace source");
  return {hostId:text(input.hostId,"hostId").toLowerCase(),absolutePath:posix.normalize(absolutePath),source:input.source,observedAt:timestamp(input.observedAt),...(input.evidence?{evidence:text(input.evidence,"evidence")}: {})};
}
const placeKey = (w:SessionWorkspace) => JSON.stringify([w.hostId,w.absolutePath]);
/** Durable data only: declaring a work area never grants access or changes project bindings. */
export class SessionWorkspaceStore {
  private records = new Map<string,SessionWorkspaceRecord>();
  private loaded = false;
  private signature = "";
  private async refresh(): Promise<void> {
    let signature="missing";
    try {const info=await stat(this.filePath);signature=`${info.mtimeMs}:${info.size}:${info.ino}`;} catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(!this.loaded || signature!==this.signature){await this.load();this.signature=signature;}
  }
  private chain: Promise<unknown> = Promise.resolve();
  constructor(readonly filePath=process.env.AGENT_HERDER_SESSION_WORKSPACES || resolve(homedir(),".local/state/agent-herder/session-workspaces.json")) {}
  private async load(): Promise<void> {
    try {
      const file=JSON.parse(await readFile(this.filePath,"utf8")) as {version:number;records:SessionWorkspaceRecord[]};
      if(file.version!==1 || !Array.isArray(file.records)) throw new Error("Invalid session workspace ledger");
      this.records=new Map(file.records.map(r=>[sessionWorkspaceKey(r),{...identity(r),version:r.version,updatedAt:timestamp(r.updatedAt),workspaces:r.workspaces.map(workspace)}]));
    } catch(error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; this.records=new Map(); }
    this.loaded=true;
  }
  async read(input:SessionWorkspaceIdentity):Promise<SessionWorkspaceRecord|null> { await this.refresh(); return structuredClone(this.records.get(sessionWorkspaceKey(input))??null); }
  async readMany(inputs:SessionWorkspaceIdentity[]):Promise<Map<string,SessionWorkspaceRecord>> { await this.refresh(); const out=new Map<string,SessionWorkspaceRecord>(); for(const i of inputs){ const k=sessionWorkspaceKey(i),r=this.records.get(k); if(r)out.set(k,structuredClone(r)); } return out; }
  async declare(input:SessionWorkspaceUpdate):Promise<SessionWorkspaceRecord> {
    const run=this.chain.then(async()=>{
      const id=identity(input),key=sessionWorkspaceKey(id),at=timestamp(input.observedAt);
      if(input.mode!=="replace" && input.mode!=="union") throw new Error("Invalid update mode");
      if(!Array.isArray(input.workspaces)||input.workspaces.length>64) throw new Error("At most 64 workspaces are allowed");
      const incoming=input.workspaces.map(workspace);
      if(incoming.some(w=>Date.parse(w.observedAt)>Date.parse(at))) throw new Error("Workspace observation is newer than update");
      await mkdir(dirname(this.filePath),{recursive:true});
      const unlock=await lockfile.lock(this.filePath,{realpath:false,retries:{retries:20,minTimeout:10,maxTimeout:100}});
      try {
        await this.load(); const previous=this.records.get(key);
        if(input.expectedVersion!==undefined && input.expectedVersion!==(previous?.version??0)) throw new Error("Workspace version conflict");
        if(previous && Date.parse(at)<=Date.parse(previous.updatedAt)) throw new Error("Stale workspace update");
        const places=new Map((input.mode==="union"?previous?.workspaces??[]:[]).map(w=>[placeKey(w),w]));
        for(const w of incoming) { const prior=places.get(placeKey(w)); if(!prior || Date.parse(w.observedAt)>Date.parse(prior.observedAt) || (w.observedAt===prior.observedAt && w.source==="declared")) places.set(placeKey(w),w); }
        const record:SessionWorkspaceRecord={...id,version:(previous?.version??0)+1,updatedAt:at,workspaces:[...places.values()]};
        const next=new Map(this.records); next.set(key,record);
        const tmp=`${this.filePath}.${randomUUID()}.tmp`;
        await writeFile(tmp,JSON.stringify({version:1,records:[...next.values()]}),{mode:0o600}); await rename(tmp,this.filePath); this.records=next;
        return structuredClone(record);
      } finally {await unlock();}
    });
    this.chain=run.catch(()=>{}); return run;
  }
}
export const sessionWorkspaces=new SessionWorkspaceStore();
