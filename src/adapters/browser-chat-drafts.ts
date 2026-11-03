import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserChat } from "./browser-chat.js";

export type DraftState = "pending" | "sending" | "uncertain" | "admitted";
export interface BrowserChatDraft {
  id: string;
  title: string;
  createdAt: string;
  state: DraftState;
  /** Native ID assigned only after first message, never guessed. */
  remoteId?: string;
}
const UUID = "[a-f0-9]{8}-[a-f0-9-]{27,48}";
const DRAFT_ID = new RegExp("^draft:("+UUID+")$","i");
const ACCOUNT_SCOPE = /^[a-f0-9]{64}$/i;
const MAX_DRAFTS = 100;

/** Verified-account durable local drafts for sites that allocate a /c/ ID
 * only after the user's first message. The draft itself sends nothing.
 */
export class BrowserChatDraftStore {
  private dir = "";
  private scope = "";
  /** Prevent an older asynchronous account read from restoring another
   * account's drafts after the browser has switched identities.
   */
  private scopeEpoch = 0;
  private readonly items = new Map<string, BrowserChatDraft>();
  constructor(
    private readonly provider: "chatgpt" | "zai",
    private readonly root = process.env.AGENT_HERDER_BROWSER_DRAFT_ROOT ||
      join(homedir(), ".local", "state", "agent-herder", "browser-chat-drafts"),
  ) {}

  get verified(): boolean { return this.dir.length > 0; }
  get(id: string): BrowserChatDraft | undefined { return this.items.get(id); }
  list(): BrowserChat[] { return [...this.items.values()].map(x=>this.asChat(x)); }

  private path(id: string): string {
    const match = id.match(DRAFT_ID);
    if (!match || !this.dir) throw new Error("Invalid or unscoped browser draft");
    return join(this.dir,match[1]+".json");
  }

  async useScope(scope?: string): Promise<void> {
    if (scope===this.scope) return;
    const epoch = ++this.scopeEpoch;
    this.items.clear();this.scope="";this.dir="";
    if (!scope || !ACCOUNT_SCOPE.test(scope)) return;
    const dir=join(this.root,this.provider,scope);
    let files:string[]=[];
    try { files=(await readdir(dir)).filter(x=>/^[a-f0-9-]{36}\.json$/i.test(x)); }
    catch { /* first use */ }
    const drafts:BrowserChatDraft[]=[];
    for (const name of files.slice(0,MAX_DRAFTS*2)) {
      try {
        const bytes=await readFile(join(dir,name));
        if (bytes.byteLength>2048) continue;
        const data=JSON.parse(bytes.toString("utf8")) as BrowserChatDraft;
        if (!data || typeof data.id!=="string" ||
          !DRAFT_ID.test(data.id) || name!==data.id.slice(6)+".json" ||
          !["pending","sending","uncertain","admitted"].includes(data.state) ||
          typeof data.title!=="string" || data.title.length>180 ||
          typeof data.createdAt!=="string" ||
          (data.remoteId!==undefined && (typeof data.remoteId!=="string"||data.remoteId.length>120))) continue;
        drafts.push(data);
      } catch { /* an invalid cache file cannot create a conversation */ }
    }
    if (epoch !== this.scopeEpoch) return;
    this.scope=scope;this.dir=dir;
    drafts.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    for (const draft of drafts.slice(0,MAX_DRAFTS)) this.items.set(draft.id,draft);
  }

  private async save(data: BrowserChatDraft): Promise<void> {
    const dir=this.dir,target=this.path(data.id),epoch=this.scopeEpoch;
    await mkdir(dir,{recursive:true,mode:0o700});
    await chmod(dir,0o700);
    const temp=target+"."+randomUUID()+".tmp";
    try {
      await writeFile(temp,JSON.stringify(data),{mode:0o600,flag:"wx"});
      if (this.dir!==dir || epoch!==this.scopeEpoch)
        throw new Error("Browser account changed while persisting a draft");
      await rename(temp,target);
      this.items.set(data.id,data);
    } finally { await unlink(temp).catch(()=>undefined); }
  }

  async create(title?: string): Promise<BrowserChat> {
    if (!this.verified) throw new Error("Cannot create a chat before browser account verification");
    if (this.items.size>=MAX_DRAFTS) throw new Error("The local account has 100 drafts; finish existing drafts first");
    const data:BrowserChatDraft={
      id:"draft:"+randomUUID(),
      title:title?.trim().slice(0,120)||
        (this.provider==="chatgpt"?"Новый чат ChatGPT":"Новый чат Z.ai"),
      state:"pending",createdAt:new Date().toISOString(),
    };
    await this.save(data);
    return this.asChat(data);
  }

  asChat(data: BrowserChatDraft, native?: BrowserChat): BrowserChat {
    return {
      ...native,
      id:data.id,title:data.title,working:native?.working ?? data.state==="sending",
      unread:native?.unread ?? false,stopVisible:native?.stopVisible ?? false,
      updatedAt:native?.updatedAt ?? data.createdAt,
      updatedAtSemantics:"local-draft",
      pendingRemoteCreation:data.state!=="admitted",
      ...(data.remoteId?{sourceRoute:
        (this.provider==="chatgpt"?"https://chatgpt.com/c/":"https://chat.z.ai/c/")+
        data.remoteId.replace(/^route:/,"")}:{}),
    };
  }

  /** Keep the stable Herder ID after first send, hide duplicate native listing. */
  merge(chats: readonly BrowserChat[]): BrowserChat[] {
    const admitted=new Set([...this.items.values()].map(x=>x.remoteId).filter(Boolean));
    return [...[...this.items.values()].map(d=>this.asChat(d,chats.find(c=>c.id===d.remoteId))),...chats.filter(x=>!admitted.has(x.id))];
  }

  async startSend(id: string): Promise<BrowserChatDraft> {
    const data=this.get(id);
    if (!data) throw new Error("Draft does not belong to the authenticated browser account");
    if (data.state==="sending" || data.state==="uncertain") {
      throw new Error("First-message submission is uncertain; reconcile without automatic retry");
    }
    if (data.state==="admitted") return data;
    const next={...data,state:"sending" as const};
    await this.save(next);
    return next;
  }
  async resetPreClick(id: string): Promise<void> {
    const data=this.get(id);
    if (data?.state==="sending") await this.save({...data,state:"pending"});
  }
  async markUncertain(id: string): Promise<void> {
    const data=this.get(id);
    if (data?.state==="sending") await this.save({...data,state:"uncertain"});
  }
  async admit(id: string,remoteId:string): Promise<void> {
    const valid=this.provider==="chatgpt"
      ? /^[a-f0-9-]{28,80}$/i.test(remoteId) : /^route:[a-f0-9-]{12,80}$/i.test(remoteId);
    if (!valid) throw new Error("New browser chat has no verified native ID");
    const data=this.get(id);
    if (!data || !["sending","uncertain"].includes(data.state))
      throw new Error("First-message admission state changed");
    await this.save({...data,remoteId,state:"admitted"});
  }
}
