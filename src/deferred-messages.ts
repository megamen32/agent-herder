import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface DeferredMessage { id: string; sessionId: string; message: string; createdAt: string; }
type State = { version: 1; messages: DeferredMessage[] };

export class DeferredMessageStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly filePath = process.env.AGENT_HERDER_DEFERRED_MESSAGES || resolve(homedir(), ".local/state/agent-herder/deferred-messages.json")) {}
  async add(sessionId: string, message: string): Promise<DeferredMessage> { return this.serial(async () => { const s=await this.read(); const m={id:randomUUID(),sessionId,message,createdAt:new Date().toISOString()}; s.messages.push(m); await this.write(s); return m; }); }
  async list(sessionId: string): Promise<DeferredMessage[]> { return this.serial(async () => (await this.read()).messages.filter(m=>m.sessionId===sessionId)); }
  async take(sessionId: string): Promise<DeferredMessage[]> { return this.serial(async () => { const s=await this.read(); const messages=s.messages.filter(m=>m.sessionId===sessionId); if (!messages.length) return []; const ids=new Set(messages.map(m=>m.id)); s.messages=s.messages.filter(m=>!ids.has(m.id)); await this.write(s); return messages; }); }
  async remove(ids: string[]): Promise<void> { if (!ids.length) return; await this.serial(async()=>{ const s=await this.read(); const set=new Set(ids); s.messages=s.messages.filter(m=>!set.has(m.id)); await this.write(s); }); }
  private serial<T>(fn:()=>Promise<T>):Promise<T>{ const next=this.chain.then(fn,fn); this.chain=next.then(()=>undefined,()=>undefined); return next; }
  private async read():Promise<State>{ try { const x=JSON.parse(await readFile(this.filePath,"utf8")); return {version:1,messages:Array.isArray(x.messages)?x.messages:[]}; } catch(e){ if ((e as NodeJS.ErrnoException).code==="ENOENT") return {version:1,messages:[]}; throw e; } }
  private async write(s:State):Promise<void>{ await mkdir(dirname(this.filePath),{recursive:true,mode:0o700}); const tmp=`${this.filePath}.${process.pid}.tmp`; await writeFile(tmp,JSON.stringify(s,null,2)+"\n",{mode:0o600}); await rename(tmp,this.filePath); }
}
export const deferredMessages = new DeferredMessageStore();

export function renderDeferredMessages(messages: DeferredMessage[]): string | null {
  if (!messages.length) return null;
  return [
    "<agent-herder-inbox>",
    "Новые сообщения от других агентов. Учти их до следующего действия и ответь через Agent Herder, если указан отправитель.",
    ...messages.map(m=>`- ${m.createdAt} :: ${m.message}`),
    "</agent-herder-inbox>",
  ].join("\n");
}

export function isBusyCodexWriter(harness: string, error?: string): boolean {
  return harness === "codex" && /already has an active writer/i.test(error || "");
}

export async function withDeferred(sessionId:string, message:string):Promise<{message:string; ids:string[]}> {
  const pending=await deferredMessages.list(sessionId);
  if (!pending.length) return {message,ids:[]};
  const prefix=["<agent-herder-deferred>",...pending.map(m=>`- ${m.createdAt} :: ${m.message}`),"</agent-herder-deferred>"].join("\n");
  return {message:`${prefix}\n\n${message}`,ids:pending.map(m=>m.id)};
}
