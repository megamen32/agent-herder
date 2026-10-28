import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionRef { harness: string; sessionId: string }
interface TurnObservation { at: string; kind: string; turnId?: string }
export interface DependencySnapshot {
  busy: boolean;
  turnId?: string;
  completion?: { at: string; outcome: string };
}
export type ResumeAfterTrigger = { kind: "delay"; delayMs: number } | { kind: "at"; at: string };
export interface ResumeAfterRequest {
  owner: SessionRef;
  dependencies?: SessionRef[];
  message?: string;
  /** Reuse on retry; use a new id for a later wait on the same sessions. */
  requestId?: string;
  /** One-shot scheduling trigger; mutually exclusive with dependency joins. */
  trigger?: ResumeAfterTrigger;
  /** HumanRequest this wake continues; an admitted answer invalidates the wake. */
  humanRequestId?: string;
  /** Native-bound question deadline; the durable registry arbitrates the close. */
  expiresAt?: string;
}
export interface ResumeAfterWait {
  id: string;
  owner: SessionRef;
  dependencies: SessionRef[];
  trigger?: ResumeAfterTrigger;
  scheduledAt?: string;
  humanRequestId?: string;
  expiresAt?: string;
  message: string;
  createdAt: string;
  state: "waiting" | "dispatching" | "resumed" | "cancelled" | "delivery_unknown" | "delivery_failed" | "delivery_blocked";
  completed: Record<string, { at: string; outcome: string; turnId?: string }>;
  reason?: string;
  observed?: Record<string, TurnObservation>;
  dependencyTurns?: Record<string, string>;
  delivery?: Delivery;
}
type Delivery = { status: "accepted" | "rejected" | "failed" | "ambiguous"; reason?: string; receipt?: Record<string, unknown> };
export interface ResumeAfterOptions {
  directory: string;
  /** Snapshot current waiting IDs before serving requests, for a controlled maintenance rollout. */
  holdExistingWaitingAtStartup?: boolean;
  deliver: (wait: ResumeAfterWait) => Promise<Delivery>;
  queryReceipt?: (wait: ResumeAfterWait) => Promise<Delivery>;
  isHeld: (ref: SessionRef) => Promise<boolean>;
  /** Unknown/unavailable state returns true, not guessed completion. */
  isBusy: (ref: SessionRef) => Promise<boolean>;
  /** Native current/last turn proof, never completion inferred from idle. */
  readDependency?: (ref: SessionRef) => Promise<DependencySnapshot>;
  validateRef?: (ref: SessionRef) => Promise<void>;
  /** Extra dependency-only checks, e.g. a harness without a native event stream can never prove completion. */
  validateDependency?: (ref: SessionRef) => Promise<void>;
  /** Asks the durable HumanRequest registry whether an expired question may close. */
  onHumanRequestTimeout?: (wait: ResumeAfterWait) => Promise<"closed" | "already_answered">;
  now?: () => number;
}
const key = (ref: SessionRef): string => JSON.stringify([ref.harness, ref.sessionId]);
const terminal = new Set(["turn.completed", "turn.failed", "session.deleted"]);
const defaultMessage = "Указанные сессии закончили выполнение. Продолжи исходную задачу: проверь их результаты, подтяни изменения, сведи PR и повтори необходимые тесты. Завершение сессии само по себе не означает зелёный результат.";

/** One process-owned, durable join. No model polling and no extra agent. */
export class ResumeAfterService {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly startupHeldWaitIds = new Set<string>();
  // Retain events received before registration. After a cold start, adapters
  // must prove the last native turn or registration records a terminal blocker.
  private readonly observations = new Map<string, TurnObservation>();
  constructor(private readonly options: ResumeAfterOptions) {}

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(fn, fn);
    this.queue = operation.catch(() => undefined);
    return operation;
  }
  private path(id: string): string {
    if (!/^wait_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid wait id");
    return join(this.options.directory, id+".json");
  }
  private async save(wait: ResumeAfterWait): Promise<void> {
    await mkdir(this.options.directory, {recursive:true});
    const file = this.path(wait.id);
    const temp = file+".tmp-"+randomUUID();
    await writeFile(temp, JSON.stringify(wait)+"\n");
    await rename(temp,file);
  }
  async get(id: string): Promise<ResumeAfterWait | null> {
    try { return JSON.parse(await readFile(this.path(id),"utf8")) as ResumeAfterWait; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async list(): Promise<ResumeAfterWait[]> {
    let names: string[];
    try { names=await readdir(this.options.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const rows=[];
    for (const name of names.filter(n=>/^wait_[a-f0-9]{32}\.json$/.test(n)).sort()) {
      const row=await this.get(name.slice(0,-5)); if(row) rows.push(row);
    }
    return rows;
  }
  async captureStartupHold():Promise<number>{
    return this.serialized(async()=>{
      if(!this.options.holdExistingWaitingAtStartup)return 0;
      const waits=await this.list();
      for(const wait of waits)if(wait.state==="waiting")this.startupHeldWaitIds.add(wait.id);
      return this.startupHeldWaitIds.size;
    });
  }
  private isMaintenanceHeld(wait:ResumeAfterWait):boolean{
    return this.options.holdExistingWaitingAtStartup===true && this.startupHeldWaitIds.has(wait.id);
  }
  register(input: ResumeAfterRequest): Promise<ResumeAfterWait> {
    return this.serialized(async()=>{
      const valid=(ref:SessionRef)=>ref && typeof ref.harness==="string" && ref.harness.trim() && typeof ref.sessionId==="string" && ref.sessionId.trim() && ref.sessionId.length<=512;
      if(!valid(input.owner))throw new Error("An exact owner session is required");
      const requestedDependencies=input.dependencies??[];
      if(!Array.isArray(requestedDependencies) || requestedDependencies.length>32 || !requestedDependencies.every(valid)) throw new Error("Dependencies must contain at most 32 exact sessions");
      if(input.trigger && requestedDependencies.length)throw new Error("A scheduled resume cannot also wait for session dependencies");
      if(!input.trigger && !requestedDependencies.length)throw new Error("Provide a schedule trigger or 1..32 session dependencies");
      const dependencies=[...new Map(requestedDependencies.map(ref=>[key(ref),{...ref}])).values()].sort((a,b)=>key(a).localeCompare(key(b)));
      if(dependencies.some(ref=>key(ref)===key(input.owner))) throw new Error("A session cannot wait for itself");
      const message=input.message ?? defaultMessage;
      if(!message.trim() || message.length>16000) throw new Error("A nonempty continuation up to 16000 characters is required");
      if(input.trigger && (!input.requestId?.trim() || input.requestId.length>256))throw new Error("A scheduled resume requires a stable requestId up to 256 characters");
      if(input.trigger && !input.message?.trim())throw new Error("A scheduled resume requires an explicit message");
      if(input.humanRequestId!==undefined && (typeof input.humanRequestId!=="string" || !input.humanRequestId.trim() || input.humanRequestId.length>128))throw new Error("humanRequestId must be a non-empty identifier up to 128 characters");
      if(input.expiresAt!==undefined && !validRfc3339Instant(input.expiresAt))throw new Error("expiresAt must be a timezone-qualified RFC3339 instant");
      const fingerprint=JSON.stringify({owner:input.owner,dependencies,message,
        ...(input.trigger?{trigger:input.trigger}:{}),
        ...(input.humanRequestId?{humanRequestId:input.humanRequestId}:{}),
        ...(input.expiresAt?{expiresAt:input.expiresAt}:{})});
      const id="wait_"+createHash("sha256").update(JSON.stringify([key(input.owner),input.requestId ?? fingerprint])).digest("hex").slice(0,32);
      const existing=await this.get(id);
      if(existing){
        const existingFingerprint=JSON.stringify({owner:existing.owner,dependencies:existing.dependencies,message:existing.message,
          ...(existing.trigger?{trigger:existing.trigger}:{}),
          ...(existing.humanRequestId?{humanRequestId:existing.humanRequestId}:{}),
          ...(existing.expiresAt?{expiresAt:existing.expiresAt}:{})});
        if(existingFingerprint!==fingerprint) throw new Error("Retry id belongs to a different wait");
        return existing;
      }
      let scheduledAt:string|undefined;
      if(input.trigger){
        const now=this.options.now?.()??Date.now();
        let due:number;
        if(input.trigger.kind==="delay"){
          if(!Number.isSafeInteger(input.trigger.delayMs) || input.trigger.delayMs<=0 || now+input.trigger.delayMs>Number.MAX_SAFE_INTEGER)
            throw new Error("delayMs must be a positive safe integer");
          due=now+input.trigger.delayMs;
        }else{
          if(!validRfc3339Instant(input.trigger.at))throw new Error("at must be a timezone-qualified RFC3339 instant");
          due=Date.parse(input.trigger.at);
        }
        const date=new Date(due);
        if(!Number.isFinite(date.getTime()) || due<=now)throw new Error("A scheduled resume time must be a valid future instant");
        scheduledAt=date.toISOString();
      }
      const pending=(await this.list()).filter(w=>w.state==="waiting" || w.state==="dispatching");
      const graph=new Map<string,string[]>();
      for(const wait of pending) graph.set(key(wait.owner),[...(graph.get(key(wait.owner))??[]),...wait.dependencies.map(key)]);
      const reaches=(from:string,target:string,seen=new Set<string>()):boolean=>{
        if(from===target)return true; if(seen.has(from))return false; seen.add(from);
        return (graph.get(from)??[]).some(next=>reaches(next,target,seen));
      };
      if(dependencies.some(ref=>reaches(key(ref),key(input.owner)))) throw new Error("Dependency cycle");
      for(const ref of [input.owner]) await this.options.validateRef?.(ref);
      // Capability is a request-level precondition, not a property of whichever
      // dependency happens to be inspected first. Validate every dependency
      // before HumanStop handling or a terminal runtime snapshot can short-circuit.
      for(const ref of dependencies) await this.options.validateDependency?.(ref);
      const wait:ResumeAfterWait={id,owner:{...input.owner},dependencies,message,
        ...(input.trigger?{trigger:{...input.trigger},scheduledAt}:{}),
        ...(input.humanRequestId?{humanRequestId:input.humanRequestId}:{}),
        ...(input.expiresAt?{expiresAt:input.expiresAt}:{}),
        createdAt:new Date(this.options.now?.()??Date.now()).toISOString(),state:"waiting",completed:{}};
      if(await this.options.isHeld(wait.owner)){
        wait.state="cancelled";wait.reason="requester was stopped";
      } else for(const ref of dependencies) {
        // An unavailable exact dependency is a durable blocker, so retry
        // cannot silently re-arm it. Capability refusals were preflighted above.
        try { await this.options.validateRef?.(ref); }
        catch {
          wait.state="delivery_failed";wait.reason=`Dependency ${ref.harness}:${ref.sessionId}: native turn completion is unavailable (exact session unavailable)`;
          break;
        }
        await this.refreshDependency(wait,ref);
        if(wait.state!=="waiting")break;
      }
      await this.save(wait);
      await this.sweepUnlocked();
      return (await this.get(id))!;
    });
  }
  cancel(id:string,owner:SessionRef):Promise<ResumeAfterWait|null>{
    return this.serialized(async()=>{
      const wait=await this.get(id); if(!wait)return null;
      if(key(wait.owner)!==key(owner))throw new Error("Only the waiting session may cancel this wait");
      if(wait.state==="resumed")return wait;
      wait.state="cancelled";wait.reason="cancelled by requester";await this.save(wait);return wait;
    });
  }
  /**
   * Cancel the still-waiting wake bound to an answered HumanRequest.
   *
   * Only `waiting` wakes are invalidated: a dispatch already in flight or an
   * unknown delivery keeps its own durable state machine and is never replayed
   * or rewritten here. Returns the number of cancelled waits.
   */
  invalidateByHumanRequest(requestId:string,reason:string):Promise<number>{
    return this.serialized(async()=>{
      let invalidated=0;
      for(const wait of await this.list()){
        if(wait.humanRequestId!==requestId || wait.state!=="waiting")continue;
        wait.state="cancelled";wait.reason=`answered by human: ${reason}`;await this.save(wait);
        invalidated+=1;
      }
      return invalidated;
    });
  }
  observe(event:{harness:string;sessionId?:string;kind:string;at?:string;data?:Record<string,unknown>}):Promise<void>{
    return this.serialized(async()=>{
      if(!event.sessionId)return;
      const ref={harness:event.harness,sessionId:event.sessionId};
      const at=event.at??new Date().toISOString();
      if(!Number.isFinite(Date.parse(at)))return;
      const turnId=typeof event.data?.turnId==="string" && event.data.turnId.trim()?event.data.turnId:undefined;
      const observation={at,kind:event.kind,...(turnId?{turnId}:{})};
      const latest=this.observations.get(key(ref));
      if((event.kind==="turn.started" || terminal.has(event.kind))
        && (!latest || Date.parse(at)>=Date.parse(latest.at))
        && !(event.kind!=="turn.started" && event.kind!=="session.deleted" && latest?.turnId && latest.turnId!==turnId))
        this.observations.set(key(ref),observation);
      for(const wait of await this.list()){
        if(wait.state!=="waiting")continue;
        if(key(wait.owner)===key(ref) && event.data?.automationStop){
          wait.state="cancelled";wait.reason="requester was stopped";await this.save(wait);continue;
        }
        if(this.isMaintenanceHeld(wait))continue;
        if(!wait.dependencies.some(d=>key(d)===key(ref)))continue;
        const expected=wait.dependencyTurns?.[key(ref)];
        if(event.kind!=="turn.started" && event.kind!=="session.deleted" && expected && turnId!==expected)continue;
        if(Date.parse(at)<Date.parse(wait.createdAt) && !(expected && turnId===expected))continue;
        const previous=wait.observed?.[key(ref)] ?? wait.completed[key(ref)];
        if(previous && Date.parse(at)<Date.parse(previous.at))continue;
        if(terminal.has(event.kind)) {
          if(this.options.readDependency && event.kind!=="session.deleted" && !turnId)continue;
          wait.completed[key(ref)]={at,outcome:event.kind,...(turnId?{turnId}:{})};
        }
        else if(event.kind==="turn.started") delete wait.completed[key(ref)];
        else continue;
        if(turnId)(wait.dependencyTurns ??= {})[key(ref)]=turnId;
        else if(event.kind==="turn.started")delete wait.dependencyTurns?.[key(ref)];
        (wait.observed ??= {})[key(ref)]=observation;
        await this.save(wait);
      }
      await this.sweepUnlocked();
    });
  }
  private async refreshDependency(wait:ResumeAfterWait,ref:SessionRef):Promise<boolean>{
    const id=key(ref);
    const latest=this.observations.get(id);
    let snapshot:DependencySnapshot|undefined;
    if(this.options.readDependency) {
      try { snapshot=await this.options.readDependency(ref); }
      catch {
        wait.state="delivery_failed";wait.reason=`Dependency ${ref.harness}:${ref.sessionId}: native turn state is unavailable`;
        return true;
      }
    }
    const turnId=snapshot?.turnId ?? (latest && (!snapshot?.busy || latest.kind==="turn.started")?latest.turnId:undefined);
    if(turnId && wait.dependencyTurns?.[id]!==turnId){
      (wait.dependencyTurns ??= {})[id]=turnId;
      delete wait.completed[id];
    }
    if(snapshot?.completion && turnId && wait.completed[id]?.turnId!==turnId) {
      wait.completed[id]={...snapshot.completion,turnId};
    } else if(latest && terminal.has(latest.kind) && !snapshot?.busy
      && (!this.options.readDependency || latest.kind==="session.deleted" || latest.turnId)
      && (!turnId || latest.turnId===turnId)) {
      wait.completed[id]={at:latest.at,outcome:latest.kind,...(latest.turnId?{turnId:latest.turnId}:{})};
      (wait.observed ??= {})[id]=latest;
    }
    if(snapshot && ((!snapshot.busy && !wait.completed[id]) || (snapshot.busy && !turnId))){
      wait.state="delivery_failed";
      wait.reason=`Dependency ${ref.harness}:${ref.sessionId}: native turn ${snapshot.busy?"identity":"completion"} is unavailable; idle alone is not completion`;
    }
    return snapshot?.busy ?? await this.options.isBusy(ref);
  }
  sweep():Promise<void>{return this.serialized(()=>this.sweepUnlocked());}
  private async sweepUnlocked():Promise<void>{
    for(const wait of await this.list()){
      if(["resumed","cancelled","delivery_failed","delivery_blocked"].includes(wait.state))continue;
      if(await this.options.isHeld(wait.owner)){
        wait.state="cancelled";wait.reason="requester was stopped";await this.save(wait);continue;
      }
      // Explicit maintenance holds never cancel or rewrite a user wait. HumanStop
      // remains authoritative above, and receipt reconciliation below is never held.
      if(wait.state==="waiting" && this.isMaintenanceHeld(wait))continue;
      if(wait.state==="waiting" && wait.expiresAt && Date.parse(wait.expiresAt)<=(this.options.now?.()??Date.now())){
        if(!wait.humanRequestId){
          wait.state="cancelled";wait.reason="question expired";await this.save(wait);continue;
        }
        let verdict:"closed"|"already_answered"="closed";
        try { verdict=await this.options.onHumanRequestTimeout?.(wait)??"closed"; }
        catch { continue; /* The arbiter is unreachable: never close on a guess, retry next sweep. */ }
        if(verdict==="closed"){
          wait.state="cancelled";wait.reason="question expired";await this.save(wait);continue;
        }
        // The durable registry says the answer won: fall through to the normal
        // delivery rules instead of closing the question.
      }
      if(wait.state==="dispatching" || wait.state==="delivery_unknown"){
        // A restart or a dropped receipt is not permission to replay an action.
        const receipt=await this.options.queryReceipt?.(wait);
        wait.state=receipt?.status==="accepted"?"resumed":receipt?.status==="rejected"?"delivery_blocked":"delivery_unknown";
        if(receipt){
          wait.delivery=receipt;
          if(receipt.reason!==undefined)wait.reason=receipt.reason;
        }
        await this.save(wait);continue;
      }
      const before=JSON.stringify(wait);
      let busy=false;
      for(const ref of wait.dependencies){
        if(wait.completed[key(ref)]?.outcome!=="session.deleted" && await this.refreshDependency(wait,ref))busy=true;
        if(wait.state!=="waiting")break;
      }
      if(JSON.stringify(wait)!==before)await this.save(wait);
      if(wait.state!=="waiting" || !wait.dependencies.every(ref=>Boolean(wait.completed[key(ref)])))continue;
      if(wait.scheduledAt && (this.options.now?.()??Date.now())<Date.parse(wait.scheduledAt))continue;
      if(await this.options.isBusy(wait.owner))continue;
      if(busy)continue;
      wait.state="dispatching";await this.save(wait);
      try{
        const receipt=await this.options.deliver(wait);
        wait.delivery=receipt;
        wait.state=receipt.status==="accepted"?"resumed":receipt.status==="ambiguous"?"delivery_unknown":receipt.status==="rejected"?"delivery_blocked":"delivery_failed";
        if(receipt.reason)wait.reason=receipt.reason;
      }catch(error){wait.state="delivery_unknown";wait.reason=String(error);}
      await this.save(wait);
    }
  }
}

function validRfc3339Instant(value:string):boolean{
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if(!match)return false;
  const [,year,month,day,hour,minute,second,zone,offsetHour,offsetMinute]=match;
  if(zone==="-00:00")return false;
  const y=Number(year),m=Number(month),d=Number(day),h=Number(hour),min=Number(minute),s=Number(second);
  const check=new Date(0);check.setUTCFullYear(y,m-1,d);check.setUTCHours(h,min,s,0);
  if(check.getUTCFullYear()!==y||check.getUTCMonth()!==m-1||check.getUTCDate()!==d||h>23||min>59||s>59)return false;
  if(zone!=="Z"&&(Number(offsetHour)>23||Number(offsetMinute)>59))return false;
  return Number.isFinite(Date.parse(value));
}
