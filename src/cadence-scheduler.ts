import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export type CadenceState = "scheduled" | "dispatching" | "delivery_unknown" | "blocked" | "paused" | "complete";
export interface CadenceSchedule {
  id: string; sessionId: string; requestId: string; message: string;
  /** Harness that owns the session. Older rows are Codex threads. */
  harness: string;
  activatedAt: string; nextAt: string; state: CadenceState; sequence: number;
  lastWakeAt?: string; inputId?: string; result?: Record<string, unknown>; reason?: string;
}
export interface CadenceOptions {
  path: string; now?: () => number;
  inspect: (sessionId: string, harness: string) => Promise<"idle" | "busy" | "held" | "unavailable">;
  deliver: (schedule: CadenceSchedule) => Promise<{ status: "accepted" | "rejected" | "unknown"; receipt?: Record<string, unknown> }>;
}
const MINUTE = 60_000;
export const CADENCE_MESSAGE = "Продолжи исходную задачу в этом же чате: проверь актуальное состояние, выполни следующий полезный шаг и обнови результат. Если цель достигнута, заверши cadence через cadence_control action=complete. При явной паузе прекрати расписание через action=pause. Это пробуждение не разрешает финансовые или иные ранее не разрешённые внешние действия.";
/** The final phase is anchored at :45 Europe/Moscow (UTC+3, no DST).
 * The first anchor after the two-hour boundary may be less than an hour away. */
export function nextCadenceAt(activation: number, after: number): number {
  if (after < activation + 60 * MINUTE) return Math.min(after + 15 * MINUTE, activation + 60 * MINUTE);
  if (after < activation + 120 * MINUTE) return Math.min(after + 30 * MINUTE, activation + 120 * MINUTE);
  const next = new Date(after); next.setUTCMinutes(45, 0, 0);
  if (next.getTime() <= after) next.setUTCHours(next.getUTCHours() + 1);
  return next.getTime();
}
/** All state transitions are cross-process locked and fsynced before native send.
 * An interrupted dispatch stays unknown forever rather than replaying a prompt. */
export class CadenceScheduler {
  private sweeping = false;
  constructor(private readonly options: CadenceOptions) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private async transaction<T>(fn: (rows: CadenceSchedule[]) => T, readOnly = false): Promise<T> {
    const path = this.options.path;
    await mkdir(dirname(path), {recursive:true, mode:0o700});
    await writeFile(path+".lock", "", {flag:"a",mode:0o600});
    const release = await lockfile.lock(path+".lock", {realpath:false, stale:30_000, retries:{retries:60,minTimeout:10,maxTimeout:100}});
    try {
      let rows: CadenceSchedule[];
      try { rows = JSON.parse(await readFile(path,"utf8")); }
      catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error; rows=[]; }
      if (!Array.isArray(rows)) throw new Error("Invalid cadence store");
      const result=fn(rows);
      if(readOnly)return structuredClone(result);
      const temp=path+"."+randomUUID()+".tmp";
      const handle=await open(temp,"wx",0o600);
      try { await handle.writeFile(JSON.stringify(rows,null,2)+"\n"); await handle.sync(); } finally { await handle.close(); }
      await rename(temp,path);
      const directory=await open(dirname(path),"r");try{await directory.sync();}finally{await directory.close();}
      return structuredClone(result);
    } finally { await release(); }
  }
  list(): Promise<CadenceSchedule[]> { return this.transaction(rows=>rows, true); }
  async schedule(input:{sessionId:string;requestId:string;message?:string;harness?:string}):Promise<CadenceSchedule> {
    const {sessionId,requestId}=input; const message=input.message??CADENCE_MESSAGE;
    const harness=input.harness??"codex";
    if(!sessionId?.trim() || sessionId.length>512 || !requestId?.trim() || requestId.length>256 || !message.trim() || message.length>16000)throw new Error("Exact sessionId, requestId and bounded continuation required");
    const observation=await this.options.inspect(sessionId,harness);
    if(observation==="held" || observation==="unavailable")throw new Error("Exact Codex session is stopped or unavailable");
    return this.transaction(rows=>{
      const id="cadence_"+createHash("sha256").update(JSON.stringify([sessionId,requestId])).digest("hex").slice(0,32);
      const existing=rows.find(row=>row.id===id);
      if(existing){if(existing.message!==message)throw new Error("requestId already belongs to another continuation");return existing;}
      if(rows.some(row=>row.sessionId===sessionId && ["scheduled","dispatching","delivery_unknown"].includes(row.state)))throw new Error("Session already has a live or unresolved cadence");
      const now=this.now();
      const row:CadenceSchedule={id,sessionId,requestId,message,harness,activatedAt:new Date(now).toISOString(),nextAt:new Date(nextCadenceAt(now,now)).toISOString(),state:"scheduled",sequence:0};
      rows.push(row);return row;
    });
  }
  control(id:string,sessionId:string,action:"pause"|"complete"):Promise<CadenceSchedule> {
    return this.transaction(rows=>{
      const row=rows.find(row=>row.id===id && row.sessionId===sessionId);
      if(!row)throw new Error("Exact cadence owner not found");
      row.state=action==="pause"?"paused":"complete";row.reason="explicit "+action;return row;
    });
  }
  async sweep():Promise<void> {
    if(this.sweeping)return;this.sweeping=true;
    try {
      for(const candidate of await this.list()) {
        if(candidate.state!=="scheduled")continue;
        const observation=await this.options.inspect(candidate.sessionId,candidate.harness??"codex");
        if(observation==="held") {
          await this.transaction(rows=>{const row=rows.find(r=>r.id===candidate.id);if(row?.state==="scheduled"){row.state="paused";row.reason="HumanStop";}});continue;
        }
        const due=Date.parse(candidate.nextAt);
        const hourly=due>Date.parse(candidate.activatedAt)+120*MINUTE;
        if(due<=this.now() && hourly && (observation==="busy" || this.now()-due>=MINUTE)) {
          // A busy turn already does useful work. Hourly slots expire rather
          // than becoming a delayed backlog after that wall-clock minute.
          await this.transaction(rows=>{const row=rows.find(r=>r.id===candidate.id);if(row?.state==="scheduled" && row.nextAt===candidate.nextAt){row.nextAt=new Date(nextCadenceAt(Date.parse(row.activatedAt),this.now())).toISOString();row.reason=observation==="busy"?"busy hourly slot skipped":"expired hourly slot skipped";}});continue;
        }
        if(observation!=="idle" || due>this.now())continue;
        const claim=await this.transaction(rows=>{
          const row=rows.find(r=>r.id===candidate.id);
          if(row?.state!=="scheduled" || Date.parse(row.nextAt)>this.now())return null;
          row.state="dispatching";row.sequence++;row.inputId=`${row.id}:${row.sequence}`;return row;
        });
        if(!claim)continue;
        // Re-check immediately before submission. The native adapter and supervisor
        // provide the final HumanStop fence and reject a conflicting native writer.
        const fresh=await this.options.inspect(claim.sessionId,claim.harness??"codex");
        const current=(await this.list()).find(row=>row.id===claim.id);
        if(current?.state!=="dispatching")continue;
        if(fresh!=="idle") {
          await this.transaction(rows=>{const row=rows.find(r=>r.id===claim.id);if(row?.state==="dispatching"){row.state=fresh==="held"?"paused":"scheduled";if(fresh==="busy" && hourly)row.nextAt=new Date(nextCadenceAt(Date.parse(row.activatedAt),this.now())).toISOString();row.reason="preflight: "+fresh;}});continue;
        }
        let result:Awaited<ReturnType<CadenceOptions["deliver"]>>;
        try { result=await this.options.deliver(claim); }
        catch(error) {result={status:"unknown",receipt:{error:String(error)}};}
        await this.transaction(rows=>{
          const row=rows.find(r=>r.id===claim.id);if(!row || row.inputId!==claim.inputId)return;
          row.result={status:result.status,...result.receipt};
          // A concurrent explicit pause/complete remains authoritative.
          if(row.state!=="dispatching")return;
          if(result.status!=="accepted"){row.state=result.status==="unknown"?"delivery_unknown":"blocked";return;}
          const now=this.now();row.lastWakeAt=new Date(now).toISOString();row.nextAt=new Date(nextCadenceAt(Date.parse(row.activatedAt),now)).toISOString();row.state="scheduled";
        });
      }
    } finally {this.sweeping=false;}
  }
  start(report:(error:unknown)=>void=console.error):()=>void {
    const timer=setInterval(()=>{void this.sweep().catch(report);},5000);timer.unref();void this.sweep().catch(report);
    return ()=>clearInterval(timer);
  }
}
