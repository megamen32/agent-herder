import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SessionRef { harness: string; sessionId: string }
export interface ResumeAfterRequest {
  owner: SessionRef;
  dependencies: SessionRef[];
  message?: string;
  /** Reuse on retry; use a new id for a later wait on the same sessions. */
  requestId?: string;
}
export interface ResumeAfterWait {
  id: string;
  owner: SessionRef;
  dependencies: SessionRef[];
  message: string;
  createdAt: string;
  state: "waiting" | "dispatching" | "resumed" | "cancelled" | "delivery_unknown" | "delivery_failed";
  completed: Record<string, { at: string; outcome: string }>;
  reason?: string;
  observed?: Record<string, { at: string; kind: string }>;
}
type Delivery = { status: "accepted" | "rejected" | "failed" | "ambiguous"; reason?: string };
export interface ResumeAfterOptions {
  directory: string;
  deliver: (wait: ResumeAfterWait) => Promise<Delivery>;
  queryReceipt?: (wait: ResumeAfterWait) => Promise<Delivery>;
  isHeld: (ref: SessionRef) => Promise<boolean>;
  /** Unknown/unavailable state returns true, not guessed completion. */
  isBusy: (ref: SessionRef) => Promise<boolean>;
  validateRef?: (ref: SessionRef) => Promise<void>;
}
const key = (ref: SessionRef): string => JSON.stringify([ref.harness, ref.sessionId]);
const terminal = new Set(["turn.completed", "turn.failed", "session.deleted"]);
const defaultMessage = "Указанные сессии закончили выполнение. Продолжи исходную задачу: проверь их результаты, подтяни изменения, сведи PR и повтори необходимые тесты. Завершение сессии само по себе не означает зелёный результат.";

/** One process-owned, durable join. No model polling and no extra agent. */
export class ResumeAfterService {
  private queue: Promise<unknown> = Promise.resolve();
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
  register(input: ResumeAfterRequest): Promise<ResumeAfterWait> {
    return this.serialized(async()=>{
      const valid=(ref:SessionRef)=>ref && typeof ref.harness==="string" && ref.harness.trim() && typeof ref.sessionId==="string" && ref.sessionId.trim() && ref.sessionId.length<=512;
      if(!valid(input.owner) || !Array.isArray(input.dependencies) || !input.dependencies.length || input.dependencies.length>32 || !input.dependencies.every(valid)) throw new Error("An exact owner and 1..32 session dependencies are required");
      const dependencies=[...new Map(input.dependencies.map(ref=>[key(ref),{...ref}])).values()].sort((a,b)=>key(a).localeCompare(key(b)));
      if(dependencies.some(ref=>key(ref)===key(input.owner))) throw new Error("A session cannot wait for itself");
      const message=input.message ?? defaultMessage;
      if(!message.trim() || message.length>16000) throw new Error("A nonempty continuation up to 16000 characters is required");
      const fingerprint=JSON.stringify({owner:input.owner,dependencies,message});
      const id="wait_"+createHash("sha256").update(JSON.stringify([key(input.owner),input.requestId ?? fingerprint])).digest("hex").slice(0,32);
      const existing=await this.get(id);
      if(existing){
        if(JSON.stringify({owner:existing.owner,dependencies:existing.dependencies,message:existing.message})!==fingerprint) throw new Error("Retry id belongs to a different wait");
        return existing;
      }
      const pending=(await this.list()).filter(w=>w.state==="waiting" || w.state==="dispatching");
      const graph=new Map<string,string[]>();
      for(const wait of pending) graph.set(key(wait.owner),[...(graph.get(key(wait.owner))??[]),...wait.dependencies.map(key)]);
      const reaches=(from:string,target:string,seen=new Set<string>()):boolean=>{
        if(from===target)return true; if(seen.has(from))return false; seen.add(from);
        return (graph.get(from)??[]).some(next=>reaches(next,target,seen));
      };
      if(dependencies.some(ref=>reaches(key(ref),key(input.owner)))) throw new Error("Dependency cycle");
      for(const ref of [input.owner,...dependencies]) await this.options.validateRef?.(ref);
      const wait:ResumeAfterWait={id,owner:{...input.owner},dependencies,message,createdAt:new Date().toISOString(),state:"waiting",completed:{}};
      await this.save(wait);
      return wait;
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
  observe(event:{harness:string;sessionId?:string;kind:string;at?:string;data?:Record<string,unknown>}):Promise<void>{
    return this.serialized(async()=>{
      if(!event.sessionId)return;
      const ref={harness:event.harness,sessionId:event.sessionId};
      const at=event.at??new Date().toISOString();
      if(!Number.isFinite(Date.parse(at)))return;
      for(const wait of await this.list()){
        if(wait.state!=="waiting")continue;
        if(key(wait.owner)===key(ref) && event.data?.automationStop){
          wait.state="cancelled";wait.reason="requester was stopped";await this.save(wait);continue;
        }
        if(Date.parse(at)<Date.parse(wait.createdAt) || !wait.dependencies.some(d=>key(d)===key(ref)))continue;
        const previous=wait.observed?.[key(ref)] ?? wait.completed[key(ref)];
        if(previous && Date.parse(at)<Date.parse(previous.at))continue;
        if(terminal.has(event.kind)) wait.completed[key(ref)]={at,outcome:event.kind};
        else if(event.kind==="turn.started") delete wait.completed[key(ref)];
        else continue;
        (wait.observed ??= {})[key(ref)]={at,kind:event.kind};
        await this.save(wait);
      }
      await this.sweepUnlocked();
    });
  }
  sweep():Promise<void>{return this.serialized(()=>this.sweepUnlocked());}
  private async sweepUnlocked():Promise<void>{
    for(const wait of await this.list()){
      if(["resumed","cancelled","delivery_failed"].includes(wait.state))continue;
      if(await this.options.isHeld(wait.owner)){
        wait.state="cancelled";wait.reason="requester was stopped";await this.save(wait);continue;
      }
      if(wait.state==="dispatching" || wait.state==="delivery_unknown"){
        // A restart or a dropped receipt is not permission to replay an action.
        const receipt=await this.options.queryReceipt?.(wait);
        wait.state=receipt?.status==="accepted"?"resumed":"delivery_unknown";
        await this.save(wait);continue;
      }
      if(!wait.dependencies.every(ref=>Boolean(wait.completed[key(ref)])))continue;
      if(await this.options.isBusy(wait.owner))continue;
      let busy=false;
      for(const ref of wait.dependencies){
        if(wait.completed[key(ref)].outcome!=="session.deleted" && await this.options.isBusy(ref)){busy=true;break;}
      }
      if(busy)continue;
      wait.state="dispatching";await this.save(wait);
      try{
        const receipt=await this.options.deliver(wait);
        wait.state=receipt.status==="accepted"?"resumed":receipt.status==="ambiguous"?"delivery_unknown":"delivery_failed";
        if(receipt.reason)wait.reason=receipt.reason;
      }catch(error){wait.state="delivery_unknown";wait.reason=String(error);}
      await this.save(wait);
    }
  }
}
