import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserChatHistoryCache } from "../src/adapters/browser-chat-history-cache.js";
import { BrowserChatAdapter } from "../src/adapters/browser-chat.js";
import { parseChromeEvaluation } from "../src/adapters/mac-mini-chrome-transport.js";
import type { BrowserChat, BrowserChatDriver } from "../src/adapters/browser-chat.js";
import type { SessionMessageView } from "../src/types/index.js";

const ACCOUNT_A="a".repeat(64), ACCOUNT_B="b".repeat(64);
const messages: SessionMessageView[] = [{
  id:"m1",role:"user",text:"Hello",parts:[{type:"text",text:"Hello"}],
}, {
  id:"m2",role:"assistant",text:"Hello back, with a code fence: ```ts\nconst n=1\n```",
  parts:[{type:"text",text:"Hello back, with a code fence: ```ts\nconst n=1\n```"}],
}];
const roots:string[]=[];
afterEach(async()=>{
  vi.unstubAllEnvs();
  for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});
});
async function dir(){const root=await mkdtemp(join(tmpdir(),"browser-history-cache-"));roots.push(root);return root}

describe("durable browser chat history",()=>{
  it("returns cached messages immediately when refresh is slow or offline",async()=>{
    const root=await dir();
    let reads=0;
    const first=new BrowserChatHistoryCache("chatgpt",async()=>{reads++;return messages},root);
    first.setAccountScope(ACCOUNT_A);
    expect(await first.messages("conversation-id")).toEqual([]); // cold miss responds immediately
    await vi.waitFor(async () => expect(await first.messages("conversation-id")).toEqual(messages));
    expect(reads).toBe(1);
    const persisted=new BrowserChatHistoryCache("chatgpt",async()=>{throw Error("offline")},root);
    persisted.setAccountScope(ACCOUNT_A);
    expect(await persisted.messages("conversation-id")).toEqual(messages);
    const files=await readdir(join(root,"chatgpt",ACCOUNT_A));
    expect(files).toHaveLength(1);
    const file=join(root,"chatgpt",ACCOUNT_A,files[0]!);
    expect((await stat(file)).mode&0o777).toBe(0o600);
    const raw=await readFile(file);
    expect(raw.toString("utf8")).not.toContain("Hello back"); // gzip at rest
  });

  it("never mixes ChatGPT/Z.ai or different authenticated account caches",async()=>{
    const root=await dir();
    const a=new BrowserChatHistoryCache("chatgpt",async()=>messages,root);
    a.setAccountScope(ACCOUNT_A);
    await a.messages("identical");
    await vi.waitFor(async () => expect(await a.messages("identical")).toEqual(messages));
    const other=new BrowserChatHistoryCache("zai",async()=>null,root);
    other.setAccountScope(ACCOUNT_A);
    expect(await other.messages("identical")).toEqual([]);
    a.setAccountScope(ACCOUNT_B);
    const b=new BrowserChatHistoryCache("chatgpt",async()=>null,root);
    b.setAccountScope(ACCOUNT_B);
    expect(await b.messages("identical")).toEqual([]);
    a.setAccountScope(undefined);
    expect(a.available).toBe(false);
    expect(await a.messages("identical")).toBeNull();
  });

  it("handles embedded markdown fences in DevTools JSON without truncating text",()=>{
    const payload={messages:[{id:"m",text:"A fenced code sample:\n```py\nprint(1)\n```"}]};
    const result="Script ran on page and returned:\n```json\n"+JSON.stringify(payload)+"\n```";
    expect(parseChromeEvaluation<typeof payload>(result)).toEqual(payload);
  });

  it("integrates a real provider instance with native history, scoped IDs and 100-chat warming",async()=>{
    const root=await dir();
    vi.stubEnv("AGENT_HERDER_BROWSER_CHAT_CACHE_ROOT",root);
    const chats:BrowserChat[]=Array.from({length:101},(_,i)=>({
      id:"native-"+i,title:"Chat "+i,unread:false,working:false,
      updatedAt:"2026-11-01T00:00:00Z",
    }));
    const read=vi.fn(async(id:string)=>id==="native-0"?messages:[{
      id:id+"-1",role:"user" as const,text:"Fixture",parts:[{type:"text" as const,text:"Fixture"}],
    }]);
    const driver:BrowserChatDriver={
      listChats:async()=>chats,getMessages:read,getAccountScope:()=>ACCOUNT_A,
      sendMessage:async()=>({}),
    };
    const adapter=new BrowserChatAdapter(driver,{
      id:"chatgpt",name:"ChatGPT",harness:"chatgpt",cwd:"/browser/chatgpt",
    },"/browser/chatgpt",true);
    await adapter.init();
    const sessions=await adapter.listSessions();
    expect(sessions).toHaveLength(101);
    expect((await adapter.getSession("chatgpt::native-0"))?.title).toBe("Chat 0");
    await vi.waitFor(async()=>expect((await adapter.getSessionMessages("chatgpt::native-0",20))?.map(x=>x.text))
      .toEqual(messages.map(x=>x.text)));
    expect(adapter.controlCapabilities.resume).toBe(true);
  });
});

describe("read-only deep-link details outside 100 cached chats", () => {
  it("never navigates a remote browser when an exact old chat is opened", async () => {
    const root=await dir();
    vi.stubEnv("AGENT_HERDER_BROWSER_CHAT_CACHE_ROOT",root);
    let browserWrites=0;
    const driver:BrowserChatDriver={
      listChats:async()=>[],
      getKnownChat:(id)=>id==="route:123e4567-e89b-12d3-a456-426614174000"
        ?{id,title:"Older Z.ai chat",unread:false,working:false,
          updatedAt:"2026-10-31T19:00:00Z"}:null,
      getChat:async()=>{browserWrites++;throw Error("read must not navigate browser")},
      getAccountScope:()=>"b".repeat(64),
      getMessages:async()=>[{id:"m",role:"user",text:"Older text",
        parts:[{type:"text",text:"Older text"}]}],
      sendMessage:async()=>({}),
    };
    const adapter=new BrowserChatAdapter(driver,
      {id:"zai",name:"Z.ai",harness:"zai",cwd:"/browser/zai"},"/browser/zai",true);
    await adapter.init();
    const id="zai::"+encodeURIComponent("route:123e4567-e89b-12d3-a456-426614174000");
    expect((await adapter.getSession(id))?.title).toBe("Older Z.ai chat");
    expect(browserWrites).toBe(0);
    expect(await adapter.getSessionMessages(id,10)).toEqual([]);
    await vi.waitFor(async()=>expect(await adapter.getSessionMessages(id,10))
      .toMatchObject([{role:"user",text:"Older text"}]));
    expect(browserWrites).toBe(0);
  });
});

describe("change-aware history request budget", () => {
  it("does not refetch cached history merely because time passed", async () => {
    const root = await dir();
    const fetch = vi.fn(async () => messages);
    const cache = new BrowserChatHistoryCache("chatgpt", fetch, root);
    cache.setAccountScope(ACCOUNT_A);
    await cache.messages("one");
    await vi.waitFor(async () => expect(await cache.messages("one")).toEqual(messages));
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3_600_000);
    try {
      for (let i = 0; i < 20; i++) expect(await cache.messages("one")).toEqual(messages);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { now.mockRestore(); }
  });

  it("uses trusted revision changes, not repeated metadata, and preserves cache when warming is disabled", async () => {
    const root = await dir();
    const fetch = vi.fn(async () => messages);
    const cache = new BrowserChatHistoryCache("chatgpt", fetch, root);
    cache.setAccountScope(ACCOUNT_A);
    cache.prewarm([{id:"one", revision:"v1"}]);
    await vi.waitFor(async () => expect(await cache.messages("one")).toEqual(messages));
    for (let i = 0; i < 20; i++) cache.prewarm([{id:"one", revision:"v1"}]);
    expect(fetch).toHaveBeenCalledTimes(1);
    cache.prewarm([{id:"one", revision:"v2"}]);
    expect((cache as any).dirty.has("one")).toBe(true);
    vi.stubEnv("AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT", "0");
    cache.prewarm(["another"]);
    expect(await readdir(join(root,"chatgpt",ACCOUNT_A))).toHaveLength(1);
    cache.setAccountScope(undefined);
  });

  it("globally backs off history reads after a 429", async () => {
    const root = await dir();
    const fetch = vi.fn(async () => { throw Error("history_http_429"); });
    const cache = new BrowserChatHistoryCache("chatgpt", fetch, root);
    cache.setAccountScope(ACCOUNT_A);
    await cache.messages("one");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((cache as any).cooldownUntil).toBeGreaterThan(Date.now()+30_000));
    await cache.messages("two");
    cache.prewarm(["three"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    cache.setAccountScope(undefined);
  });
});
