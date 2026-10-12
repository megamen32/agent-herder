import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

export interface DeferredMessage { id: string; sessionId: string; message: string; createdAt: string;
  activeTurn?: {harness:string;identity:string;inputId:string;digest:string;expiresAt:number;state:'pending'|'offered'|'hook_returned'|'expired';deferredIds?:string[]};
}
type State = { version: 1; messages: DeferredMessage[] };

export class DeferredMessageStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly filePath = process.env.AGENT_HERDER_DEFERRED_MESSAGES || resolve(homedir(), ".local/state/agent-herder/deferred-messages.json")) {}
  async add(sessionId: string, message: string): Promise<DeferredMessage> { return this.serial(async () => { const s=await this.read(); const prior=s.messages.find(m=>!m.activeTurn && m.sessionId===sessionId && m.message===message); if (prior) return prior; const m={id:randomUUID(),sessionId,message,createdAt:new Date().toISOString()}; s.messages.push(m); await this.write(s); return m; }); }
  async list(sessionId: string): Promise<DeferredMessage[]> { return this.serial(async () => (await this.read()).messages.filter(m=>!m.activeTurn && m.sessionId===sessionId)); }
  async take(sessionId: string): Promise<DeferredMessage[]> { return this.serial(async () => { const s=await this.read(); const messages=s.messages.filter(m=>!m.activeTurn && m.sessionId===sessionId); if (!messages.length) return []; const ids=new Set(messages.map(m=>m.id)); s.messages=s.messages.filter(m=>!ids.has(m.id)); await this.write(s); return messages; }); }
  async remove(ids: string[]): Promise<void> { if (!ids.length) return; await this.serial(async()=>{ const s=await this.read(); const set=new Set(ids); s.messages=s.messages.filter(m=>m.activeTurn || !set.has(m.id)); await this.write(s); }); }
  /** Same private store, separate exact-turn records. Regular inbox APIs never expose them. */
  async addActive(harness:string,sessionId:string,identity:string,inputId:string,message:string,deferredIds:string[]=[]):Promise<DeferredMessage>{
    return this.serial(async()=>{
      const s=await this.read();this.expireActive(s);
      const digest=createHash('sha256').update(message).digest('hex');
      const prior=s.messages.find(m=>m.sessionId===sessionId&&m.activeTurn?.harness===harness&&m.activeTurn.inputId===inputId);
      if(prior){if(prior.activeTurn!.digest!==digest)throw new Error('Coordination input ID conflicts with its original payload');return prior;}
      if(!identity||!inputId||Buffer.byteLength(message,'utf8')>32768||s.messages.filter(m=>m.activeTurn).length>=512
        ||s.messages.filter(m=>m.activeTurn&&m.sessionId===sessionId&&m.activeTurn.state==='pending').length>=64)throw new Error('Current-turn coordination budget exceeded');
      const m:DeferredMessage={id:randomUUID(),sessionId,message,createdAt:new Date().toISOString(),activeTurn:{harness,identity,inputId,digest,expiresAt:Date.now()+300000,state:'pending',deferredIds}};
      s.messages.push(m);await this.write(s);return m;
    });
  }
  async activeReceipt(harness:string,sessionId:string,inputId:string):Promise<DeferredMessage|undefined>{
    return this.serial(async()=>{const s=await this.read();this.expireActive(s);return s.messages.find(m=>m.sessionId===sessionId&&m.activeTurn?.harness===harness&&m.activeTurn.inputId===inputId)});
  }
  /** One offer only, durably recorded before hook output. A lost hook response is never replayed. */
  async offerActive(harness:string,sessionId:string,identity:string,allowed:()=>Promise<boolean>):Promise<DeferredMessage[]>{
    return this.serial(async()=>{
      const s=await this.read();this.expireActive(s);
      if(!identity||!await allowed()){await this.write(s);return [];}
      this.expireActive(s);
      for(const m of s.messages)if(m.sessionId===sessionId&&m.activeTurn?.harness===harness&&m.activeTurn.identity!==identity&&m.activeTurn.state==='pending'){m.activeTurn.state='expired';m.message='';}
      const offered=s.messages.filter(m=>m.sessionId===sessionId&&m.activeTurn?.harness===harness&&m.activeTurn.identity===identity&&m.activeTurn.state==='pending');
      for(const m of offered)m.activeTurn!.state='offered';
      const regularIds=new Set(offered.flatMap(m=>m.activeTurn!.deferredIds||[]));
      s.messages=s.messages.filter(m=>m.activeTurn||m.sessionId!==sessionId||!regularIds.has(m.id));
      await this.write(s);return offered;
    });
  }
  async discardActive(harness:string,sessionId:string):Promise<void>{await this.serial(async()=>{const s=await this.read();this.expireActive(s);for(const m of s.messages)if(m.sessionId===sessionId&&m.activeTurn?.harness===harness&&m.activeTurn.state==='pending'){m.activeTurn.state='expired';m.message='';}await this.write(s);});}
  async acknowledgeActive(sessionId:string,ids:string[]):Promise<void>{await this.serial(async()=>{const s=await this.read();const set=new Set(ids);for(const m of s.messages)if(m.sessionId===sessionId&&set.has(m.id)&&m.activeTurn?.state==='offered')m.activeTurn.state='hook_returned';await this.write(s);});}
  private expireActive(s:State):void{
    for(const m of s.messages)if(m.activeTurn&&m.activeTurn.state==='pending'&&m.activeTurn.expiresAt<=Date.now()){m.activeTurn.state='expired';m.message='';}
    s.messages=s.messages.filter(m=>!m.activeTurn||Date.parse(m.createdAt)>Date.now()-86400000);
  }
  private serial<T>(fn:()=>Promise<T>):Promise<T>{ const next=this.chain.then(fn,fn); this.chain=next.then(()=>undefined,()=>undefined); return next; }
  private async read():Promise<State>{ try { const x=JSON.parse(await readFile(this.filePath,"utf8")); return {version:1,messages:Array.isArray(x.messages)?x.messages:[]}; } catch(e){ if ((e as NodeJS.ErrnoException).code==="ENOENT") return {version:1,messages:[]}; throw e; } }
  private async write(s:State):Promise<void>{ await mkdir(dirname(this.filePath),{recursive:true,mode:0o700}); const tmp=`${this.filePath}.${process.pid}.tmp`; await writeFile(tmp,JSON.stringify(s,null,2)+"\n",{mode:0o600}); await rename(tmp,this.filePath); }
}
export const deferredMessages = new DeferredMessageStore();

export function renderDeferredMessages(messages: DeferredMessage[]): string | null {
  if (!messages.length) return null;
  return [
    "<agent-herder-inbox>",
    "Новые сообщения от агентов. Учти стабильный ID: повтор уже обработанного ID не запускает действие снова. Ответ только для решения, ошибки или результата; без ACK.",
    ...messages.map(m=>`- id=${m.id} :: ${m.message}`),
    "</agent-herder-inbox>",
  ].join("\n");
}

export function isBusyCodexWriter(harness: string, error?: string): boolean {
  return harness === "codex" && /already has an active writer/i.test(error || "");
}

export async function withDeferred(sessionId:string, message:string):Promise<{message:string; ids:string[]}> {
  const pending=await deferredMessages.list(sessionId);
  if (!pending.length) return {message,ids:[]};
  const prefix=["<agent-herder-deferred>",...pending.map(m=>`- id=${m.id} :: ${m.message}`),"</agent-herder-deferred>"].join("\n");
  return {message:`${prefix}\n\n${message}`,ids:pending.map(m=>m.id)};
}
