import { afterEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserChatDraftStore } from "../src/adapters/browser-chat-drafts.js";
import { BrowserChatAdapter } from "../src/adapters/browser-chat.js";
import { createNamedSession } from "../src/named-session.js";
import { openOwnedBlankChatPage, submitFirstChatMessage, newChatPostClickProbe, zaiNewChatMessageProbe } from "../src/adapters/browser-chat-new-page.js";
import { ChatGptMacCdpDriver } from "../src/adapters/chatgpt-mac-cdp-driver.js";
import { ZaiCdpDriver } from "../src/adapters/zai-cdp-driver.js";
import type { ChromePageTools } from "../src/adapters/mac-mini-chrome-transport.js";

const ACCOUNT="a".repeat(64), OTHER="b".repeat(64);
const GPT_NATIVE="6ada477c-7014-83ed-82ae-7881dbe3e109";
const ZAI_NATIVE="123e4567-e89b-12d3-a456-426614174000";
const folders:string[]=[];
async function root() { const p=await mkdtemp(join(tmpdir(),"herder-new-chat-"));folders.push(p);return p; }
afterEach(async()=> {
  vi.unstubAllEnvs();
  await Promise.all(folders.splice(0).map(x=>rm(x,{recursive:true,force:true})));
});
function json(value: unknown) {
  return "Script ran on page and returned:\n```json\n"+JSON.stringify(value)+"\n```";
}

describe("durable local draft",()=>{
  for(const provider of ["chatgpt","zai"] as const) {
    it(provider+" creates without sending, persists and isolates accounts",async()=>{
      const p=await root();
      const a=new BrowserChatDraftStore(provider,p);
      await a.useScope(ACCOUNT);
      const d=await a.create("My initial title");
      expect(d).toMatchObject({title:"My initial title",working:false,pendingRemoteCreation:true});
      expect(d.id).toMatch(/^draft:/);
      const names=await readdir(join(p,provider,ACCOUNT));
      expect(names).toHaveLength(1);
      expect((await stat(join(p,provider,ACCOUNT,names[0]!))).mode&0o777).toBe(0o600);
      const record=JSON.parse(await readFile(join(p,provider,ACCOUNT,names[0]!),"utf8"));
      expect(record.state).toBe("pending");
      const afterRestart=new BrowserChatDraftStore(provider,p);
      await afterRestart.useScope(ACCOUNT);
      expect(afterRestart.get(d.id)?.title).toBe("My initial title");
      await afterRestart.useScope(OTHER);
      expect(afterRestart.get(d.id)).toBeUndefined();
      await afterRestart.useScope(undefined);
      expect(afterRestart.verified).toBe(false);
      await expect(afterRestart.create()).rejects.toThrow(/verif/i);
    });
  }
  it("rejects stale in-flight account reads after a concurrent login switch",async()=>{
    const p=await root();
    const a=new BrowserChatDraftStore("chatgpt",p);
    await a.useScope(ACCOUNT);
    const chatA=await a.create("Account A draft");
    await a.useScope(OTHER);
    const chatB=await a.create("Account B draft");
    const restored=new BrowserChatDraftStore("chatgpt",p);
    await Promise.all([restored.useScope(ACCOUNT),restored.useScope(OTHER)]);
    expect(restored.get(chatA.id)).toBeUndefined();
    expect(restored.get(chatB.id)?.title).toBe("Account B draft");
    expect(restored.verified).toBe(true);
  });

  it("blocks duplicate first-message submissions after an uncertain click",async()=>{
    const p=await root();
    const s=new BrowserChatDraftStore("chatgpt",p);
    await s.useScope(ACCOUNT);
    const d=await s.create();
    expect((await s.startSend(d.id)).state).toBe("sending");
    await expect(s.startSend(d.id)).rejects.toThrow(/uncertain/);
    await s.markUncertain(d.id);
    await expect(s.startSend(d.id)).rejects.toThrow(/uncertain/);
    await s.admit(d.id,GPT_NATIVE);
    const admitted=await s.startSend(d.id);
    expect(admitted).toMatchObject({state:"admitted",remoteId:GPT_NATIVE});
    const merged=s.merge([{id:GPT_NATIVE,title:"native",unread:true,working:true,stopVisible:true,
      updatedAt:new Date().toISOString()}]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(d.id);
    expect(merged[0]?.pendingRemoteCreation).toBe(false);
    expect(merged[0]).toMatchObject({working:true,stopVisible:true,unread:true});
  });
  it("rolls back only a proven pre-click failure",async()=>{
    const s=new BrowserChatDraftStore("zai",await root());
    await s.useScope(ACCOUNT);
    const d=await s.create();
    await s.startSend(d.id);
    await s.resetPreClick(d.id);
    expect(s.get(d.id)?.state).toBe("pending");
    await s.startSend(d.id);
    await s.admit(d.id,"route:"+ZAI_NATIVE);
    expect(s.get(d.id)?.remoteId).toBe("route:"+ZAI_NATIVE);
  });
});

class NewChatPageFixture implements ChromePageTools {
  readonly calls: Array<{name:string; args:Record<string,unknown>}>=[];
  created=false;
  clicked=false;
  closed=false;
  inheritedDraft=false;
  failBeforeClick=false;
  ambiguousClick=false;
  nativeRoute=true;
  rejection:string|undefined;
  chatgptEditorLabel="Спросить ChatGPT";
  constructor(readonly site:"chatgpt"|"zai",readonly timeoutOnOpen=false) {}
  get origin(){return this.site==="chatgpt"?"https://chatgpt.com":"https://chat.z.ai"}
  get remoteRoute(){return "/c/"+(this.site==="chatgpt"?GPT_NATIVE:ZAI_NATIVE)}
  async call(name:string,args:Record<string,unknown>={}):Promise<string> {
    this.calls.push({name,args});
    if(name==="list_pages"){
      return "7: Existing personal chat ("+this.origin+"/c/some-old-chat)\n"
        +(this.created ? "20: New blank chat ("+this.origin+"/)\n" : "");
    }
    if(name==="new_page"){
      expect(args).toMatchObject({background:true,url:this.origin+"/?herder_owned="+this.site});
      this.created=true;
      if(this.timeoutOnOpen)throw Error("Navigation timeout");
      return "Opened new page";
    }
    if(name==="evaluate_script"){
      const source=String(args.function);
      expect(() => new Function("return ("+source+")")).not.toThrow();
      if(source.includes("/api/auth/session") ||
        source.includes("/api/v1/chats/?page=")) {
        return json({scope:ACCOUNT,chats:[]});
      }
      if(source.includes("execCommand('selectAll')")){
        return json({cleared:true});
      }
      if(source.includes("ready:!!editor")){
        return json({origin:this.origin,path:"/",ready:true,empty:!this.inheritedDraft});
      }
      if(source.includes("send_not_ready")){
        if(this.ambiguousClick)throw Error("transport lost after click");
        if(this.failBeforeClick)return json({submitted:false,reason:"send_not_ready"});
        this.clicked=true;return json({submitted:true});
      }
      if(source.includes("path:location.pathname")){
        return json({origin:this.origin,path:this.clicked&&this.nativeRoute?this.remoteRoute:"/",rejection:this.rejection});
      }
      if(source.includes('herderZaiNewChatVerify'))return json({verified:true});
      throw Error("unexpected script");
    }
    if(name==="take_snapshot"){
      return this.site==="chatgpt"
        ? `uid=1_42 textbox "${this.chatgptEditorLabel}" focusable multiline`
        : 'uid=1_44 textbox "Send a Message" focusable multiline';
    }
    if(name==="fill")return "ok";
    if(name==="close_page"){this.closed=true;return "Closed";}
    throw Error("unexpected tool:"+name);
  }
}
describe("browser first-message admission",()=>{
  it("verifies the exact Z.ai native user message and account before adopting its route",async()=>{
    let text='Synthetic prompt';let count=1;
    const fetch=async(url:string)=>({ok:true,json:async()=>url.includes('/messages/batch')
      ?{chat_id:ZAI_NATIVE,data:Object.fromEntries(Array.from({length:count},(_,i)=>['m'+i,{role:'user',content:text}]))}
      :{id:ZAI_NATIVE,user_id:'fixture',chat:{history:{messages:Object.fromEntries(Array.from({length:count},(_,i)=>['m'+i,{}]))}}}});
    const fn=runInNewContext('('+zaiNewChatMessageProbe(ZAI_NATIVE,'Synthetic prompt',ACCOUNT)+')',{
      location:{origin:'https://chat.z.ai',pathname:'/c/'+ZAI_NATIVE},fetch,JSON,encodeURIComponent,TextEncoder,Uint8Array,
      crypto:{subtle:{digest:async()=>new Uint8Array(32).fill(0xaa).buffer}},
    });
    expect(await fn()).toMatchObject({verified:true});
    text='different';expect(await fn()).toMatchObject({verified:false,reason:'native_history_mismatch'});
    text='Synthetic prompt';count=2;expect(await fn()).toMatchObject({verified:false,reason:'native_history_mismatch'});
  });
  it("does not bind a new Z.ai draft to a route already in its account inventory",async()=>{
    class ExistingRouteFixture extends NewChatPageFixture {
      override async call(name:string,args:Record<string,unknown>={}):Promise<string>{
        if(name==='evaluate_script' && String(args.function).includes('/api/v1/chats/?page=')) {
          this.calls.push({name,args});return json({scope:ACCOUNT,chats:[{id:ZAI_NATIVE,title:'existing chat'}]});
        }
        return super.call(name,args);
      }
    }
    const tools=new ExistingRouteFixture('zai');
    const receipt=await submitFirstChatMessage(tools,'zai','Synthetic prompt',ACCOUNT);
    expect(receipt).toMatchObject({clicked:true,uncertain:true});
    expect(receipt.remoteId).toBeUndefined();
  });
  it("does not bind a Z.ai route when its native history does not contain the submitted first message",async()=>{
    class WrongHistoryFixture extends NewChatPageFixture {
      override async call(name:string,args:Record<string,unknown>={}):Promise<string>{
        if(name==='evaluate_script' && String(args.function).includes('herderZaiNewChatVerify'))
          return json({verified:false,reason:'native_history_mismatch'});
        return super.call(name,args);
      }
    }
    const receipt=await submitFirstChatMessage(new WrongHistoryFixture('zai'),'zai','Synthetic prompt',ACCOUNT);
    expect(receipt).toMatchObject({clicked:true,uncertain:true});
    expect(receipt.remoteId).toBeUndefined();
  });
  it("recognizes the current Russian ChatGPT new-chat editor",async()=>{
    const tools=new NewChatPageFixture("chatgpt");
    tools.chatgptEditorLabel="Работайте с ChatGPT";
    const receipt=await submitFirstChatMessage(tools,"chatgpt","User-written prompt");
    expect(receipt).toMatchObject({clicked:true,uncertain:false,remoteId:GPT_NATIVE});
  });
  for(const site of ["chatgpt","zai"] as const){
    it(site+" creates a background chat with verified provider ID only after user's text",async()=>{
      const tools=new NewChatPageFixture(site,true);
      const receipt=await submitFirstChatMessage(tools,site,"User-written prompt");
      expect(receipt).toMatchObject({clicked:true,uncertain:false,
        remoteId:site==="chatgpt"?GPT_NATIVE:"route:"+ZAI_NATIVE});
      expect(tools.calls.filter(x=>x.name==="new_page")).toHaveLength(1);
      expect(tools.calls.filter(x=>x.name==="fill")).toHaveLength(1);
      expect(tools.calls.filter(x=>x.name==="fill").map(x=>x.args.value)).toEqual(["User-written prompt"]);
      expect(tools.calls.filter(x=>x.name==="evaluate_script"&&
        String(x.args.function).includes("send_not_ready"))).toHaveLength(1);
      expect(tools.closed).toBe(false);
      expect(tools.calls).not.toContainEqual(expect.objectContaining({name:"navigate_page"}));
    });
    it(site+" refuses pre-click send without any retry and closes only owned blank tab",async()=>{
      const tools=new NewChatPageFixture(site);
      tools.failBeforeClick=true;
      const receipt=await submitFirstChatMessage(tools,site,"User-written prompt");
      expect(receipt).toMatchObject({clicked:false,uncertain:false,reason:"send_not_ready"});
      expect(tools.closed).toBe(true);
      expect(tools.clicked).toBe(false);
    });
    it(site+" does not retry when browser click outcome is unknown",async()=>{
      const tools=new NewChatPageFixture(site);
      tools.ambiguousClick=true;
      const receipt=await submitFirstChatMessage(tools,site,"User-written prompt");
      expect(receipt).toMatchObject({clicked:true,uncertain:true});
      expect(tools.closed).toBe(false);
    });
  }
});

describe("inherited draft safety",()=>{
  for(const site of ["chatgpt","zai"] as const){
    it(site+" refuses inherited drafts without filling, closing or sending",async()=>{
      const tools=new NewChatPageFixture(site);
      tools.inheritedDraft=true;
      const receipt=await submitFirstChatMessage(tools,site,"Synthetic prompt");
      expect(receipt.clicked).toBe(false);
      expect(receipt.uncertain).toBe(false);
      expect(receipt.reason).toContain("contains a draft");
      expect(tools.calls.map(x=>x.name)).not.toContain("fill");
      expect(tools.calls.map(x=>x.name)).not.toContain("close_page");
      expect(tools.clicked).toBe(false);
    });
  }
});

describe("new-page account verification",()=>{
  for(const site of ["chatgpt","zai"] as const){
    it(site+" never fills or sends when the new tab has a different authenticated account",async()=>{
      const tools=new NewChatPageFixture(site);
      const receipt=await submitFirstChatMessage(tools,site,"Never send me",OTHER);
      expect(receipt).toMatchObject({clicked:false,uncertain:false,
        reason:"New-chat account identity could not be verified"});
      expect(tools.calls.map(x=>x.name)).not.toContain("fill");
      expect(tools.calls.filter(x=>x.name==="evaluate_script" &&
        String(x.args.function).includes("send_not_ready"))).toHaveLength(0);
      expect(tools.closed).toBe(true);
    });
  }
});

describe("two separate site adapters",()=>{
  it("createSession returns a selectable local draft without sending any message",async()=>{
    let sends=0;
    const adapter=new BrowserChatAdapter({
      listChats:async()=>[],sendMessage:async()=>{sends++;return{}},
      createChat:async()=>({
        id:"draft:"+GPT_NATIVE,title:"Новый чат",working:false,unread:false,
        updatedAt:new Date().toISOString(),pendingRemoteCreation:true,
      }),
    },{id:"chatgpt",name:"ChatGPT",cwd:"/browser/chatgpt",harness:"chatgpt"},"/browser/chatgpt",true);
    const created=await adapter.createSession({name:"New Chat",cwd:"/browser/chatgpt"});
    expect(created.id).toBe("chatgpt::"+encodeURIComponent("draft:"+GPT_NATIVE));
    expect(created.meta?.pendingRemoteCreation).toBe(true);
    expect((await adapter.getSession(created.id))?.id).toBe(created.id);
    expect(sends).toBe(0);
  });
  it("drivers expose createChat only for their site, without native navigation on create",async()=>{
    for(const site of ["chatgpt","zai"] as const) {
      const base=new NewChatPageFixture(site);
      const driver=site==="chatgpt"?
        new ChatGptMacCdpDriver(base) :new ZaiCdpDriver(base);
      expect(typeof driver.createChat).toBe("function");
      expect(driver.browserFeatures.chatCreation).toBe(true);
    }
  });
});

/** Full driver path without any real user messages or browser writes. */
class NewChatIntegratedFixture extends NewChatPageFixture {
  readonly sends: string[] = [];
  constructor(site:"chatgpt"|"zai") { super(site); }
  override async call(name:string,args:Record<string,unknown>={}):Promise<string> {
    const fn=String(args.function||"");
    if (name==="evaluate_script" && args.pageId===7) {
      this.calls.push({name,args});
      if(fn.includes("async () =>") && (
        fn.includes("/backend-api/conversations?offset=0&limit=100") ||
        fn.includes("/api/v1/chats/?page="))) {
        return json({scope:ACCOUNT,chats:[{
          id:this.site==="chatgpt"?GPT_NATIVE:ZAI_NATIVE,
          title:"Older personal conversation",updatedAt:Date.now()/1000,
        }]});
      }
      if(fn.includes("const buttons = [...document.querySelectorAll('button[data-selected]')]")) {
        return json({origin:this.origin,path:this.remoteRoute,loggedIn:true,
          composer:true,titles:["Older personal conversation"],selectedTitle:"Older personal conversation",
          phase:"idle",draftPresent:false});
      }
      if(fn.includes("const route = /^\\/")) {
        return json({origin:this.origin,path:this.remoteRoute,authenticated:true,composer:true,
          phase:"idle",draftPresent:false,chats:[{id:GPT_NATIVE,title:"Older personal conversation"}]});
      }
    }
    const result=await super.call(name,args);
    if(name==="fill")this.sends.push(String(args.value||""));
    return result;
  }
}

describe("driver integration: draft to native conversation, no synthetic prompt",()=>{
  it("restores an exact ChatGPT draft after the driver restarts",async()=>{
    const p=await root();vi.stubEnv("AGENT_HERDER_BROWSER_DRAFT_ROOT",p);
    const tools=new NewChatIntegratedFixture("chatgpt");
    const before=new ChatGptMacCdpDriver(tools);
    const draft=await before.createChat({title:"Persistent test draft"});
    const after=new ChatGptMacCdpDriver(tools);
    expect(await after.getChat(draft.id)).toMatchObject({id:draft.id,title:"Persistent test draft",pendingRemoteCreation:true});
    expect(tools.calls.some(c=>c.name==="fill" || c.name==="new_page")).toBe(false);
  });
  for(const site of ["chatgpt","zai"] as const){
    it(site+" creates a selectable draft then admits exactly one user first message",async()=>{
      const p=await root();
      vi.stubEnv("AGENT_HERDER_BROWSER_DRAFT_ROOT",p);
      const tools=new NewChatIntegratedFixture(site);
      const d=site==="chatgpt"
        ?new ChatGptMacCdpDriver(tools)
        :new ZaiCdpDriver(tools);
      const first=await d.createChat({title:"Human readable title"});
      expect(first).toMatchObject({pendingRemoteCreation:true,title:"Human readable title"});
      expect(first.id).toMatch(/^draft:/);
      expect(tools.calls.some(c=>c.name==="new_page")).toBe(false);
      const out=await d.sendMessage({chatId:first.id,text:"User-written prompt"});
      expect(out).toEqual({});
      expect(tools.sends).toEqual(["User-written prompt"]);
      expect(tools.calls.filter(c=>c.name==="new_page")).toHaveLength(1);
      expect(tools.calls.filter(c=>c.name==="fill")).toHaveLength(1);
      expect(tools.calls.filter(c=>c.name==="fill").map(c=>c.args.value)).toEqual(["User-written prompt"]);
      const created=d.getKnownChat?.(first.id);
      expect(created).toMatchObject({pendingRemoteCreation:false});
      const store=new BrowserChatDraftStore(site,p);
      await store.useScope(ACCOUNT);
      expect(store.get(first.id)?.remoteId).toBe(site==="chatgpt"
        ?GPT_NATIVE:"route:"+ZAI_NATIVE);
    });
  }
});

describe("atomic first-send safety in the site's own browser DOM",()=>{
  for(const site of ["chatgpt","zai"] as const){
    it(site+" never clicks Stop, wrong route, changed human draft or ambiguous Send",async()=>{
      const tools=new NewChatPageFixture(site);
      await submitFirstChatMessage(tools,site,"a user-written prompt");
      const source=String(tools.calls.find(c=>c.name==="evaluate_script" &&
        String(c.args.function).includes("send_not_ready"))?.args.function);
      expect(source).toContain("send_not_ready");

      const state={
        pathname:"/",origin:site==="chatgpt"?"https://chatgpt.com":"https://chat.z.ai",
        text:"a user-written prompt",generating:false,sendButtons:1,
        clicks:0,
      };
      const visible=()=>[{}];
      const send={type:"submit",disabled:false,getClientRects:visible,
        getAttribute:(key:string)=>key==="data-testid"?"send-button":null,
        querySelector:()=>null,
        click:()=>{state.clicks++}};
      const editor=site==="chatgpt"
        ? {innerText:state.text,textContent:state.text,closest:()=>({contains:()=>true})}
        : {value:state.text};
      const stop={...send,getAttribute:(key:string)=>key==="data-testid"?"stop-button":null,
        querySelector:(selector:string)=>selector.includes("span.block.size-3")?{}:null};
      const document={
        querySelector:(sel:string)=>sel.includes("contenteditable")||sel.startsWith("textarea")?editor:null,
        querySelectorAll:(sel:string)=>sel==="#send-message-button"?[send]:
          sel==="button"?state.generating?[send,stop]:Array.from({length:state.sendButtons},()=>send):[],
      };
      const evaluate=()=>runInNewContext("("+source+")()",{
        location:{get origin(){return state.origin},get pathname(){return state.pathname}},
        document,
      }) as {submitted:boolean;reason?:string};
      state.pathname="/c/another";
      expect(evaluate()).toMatchObject({submitted:false,reason:"new_chat_target_changed"});
      state.pathname="/";
      state.text="User changed the draft";
      if(site==="chatgpt"){(editor as {innerText:string;textContent:string}).innerText=state.text;}
      else (editor as {value:string}).value=state.text;
      expect(evaluate()).toMatchObject({submitted:false,reason:"draft_changed"});
      state.text="a user-written prompt";
      if(site==="chatgpt"){(editor as {innerText:string;textContent:string}).innerText=state.text;}
      else (editor as {value:string}).value=state.text;
      state.generating=true;
      expect(evaluate()).toMatchObject({submitted:false,reason:"busy"});
      state.generating=false;
      state.sendButtons=site==="chatgpt"?2:1;
      if(site==="chatgpt")expect(evaluate()).toMatchObject({submitted:false,reason:"send_not_ready"});
      state.sendButtons=1;
      expect(evaluate()).toMatchObject({submitted:true});
      expect(state.clicks).toBe(1);
    });
  }
});

describe("native Agent Herder create-session API contract",()=>{
  for(const site of ["chatgpt","zai"] as const){
    it(site+" resolves an immediately selectable new draft without browser messages",async()=>{
      const disk=await root();
      vi.stubEnv("AGENT_HERDER_NAMED_SESSION_STORE",join(disk,"named-sessions.json"));
      let creates=0,sends=0;
      const saved=new Map<string,{id:string;title:string;working:boolean;unread:boolean;updatedAt:string;pendingRemoteCreation:boolean}>();
      const driver={
        listChats:async()=>[...saved.values()],
        getChat:async(id:string)=>saved.get(id)||null,
        sendMessage:async()=>{sends++;return{}},
        createChat:async({title}:{title?:string})=>{
          creates++;
          const c={id:"draft:"+GPT_NATIVE,title:title||"Новый чат",working:false,unread:false,
            updatedAt:new Date().toISOString(),pendingRemoteCreation:true};
          saved.set(c.id,c);return c;
        },
      };
      const adapter=new BrowserChatAdapter(driver,{
        id:site,name:site,cwd:"/home/roomhacker/.browser-chat/"+site,harness:site,
      },"/home/roomhacker/.browser-chat/"+site,true);
      const name=site+"-20261103-000000-"+String(Math.random()).slice(2,10);
      const result=await createNamedSession(new Map([[site,adapter]]),{
        harness:site,cwd:"/",name,
      });
      expect(result).toMatchObject({ok:true,created:true,harness:site});
      const id=result.sessionId!;
      expect(id).toBe(site+"::"+encodeURIComponent("draft:"+GPT_NATIVE));
      expect((await adapter.getSession(id))?.meta?.pendingRemoteCreation).toBe(true);
      expect(creates).toBe(1);
      expect(sends).toBe(0);
    });
  }
});

describe("native provider rejection after first Send",()=>{
  it("does not mark a route allocated during a Z.ai concurrency rejection as accepted",async()=>{
    const tools=new NewChatPageFixture("zai");
    tools.rejection="concurrent_conversation_limit";
    const receipt=await submitFirstChatMessage(tools,"zai","fixture prompt",ACCOUNT);
    expect(receipt).toMatchObject({clicked:true,uncertain:true});
    expect(receipt.remoteId).toBeUndefined();
    expect(receipt.reason).toContain("concurrent_conversation_limit");
    expect(tools.calls.filter(c=>c.name==="fill")).toHaveLength(1);
    expect(tools.closed).toBe(false);
  });
  it("recognizes the site's observed red concurrency error without reading other chats",()=>{
    const source=newChatPostClickProbe("zai");
    const result=runInNewContext("("+source+")()",{
      location:{origin:"https://chat.z.ai",pathname:"/c/"+ZAI_NATIVE},
      document:{querySelectorAll:(selector:string)=>{
        expect(selector).toContain("border-red-600");
        return [{getClientRects:()=>[1],innerText:"Your current concurrent conversation limit has been reached. Please try again later."}];
      }},
    });
    expect(result).toMatchObject({rejection:"concurrent_conversation_limit"});
  });
  it("verifies a ChatGPT create action without calling conversation inventory",async()=>{
    const p=await root();vi.stubEnv("AGENT_HERDER_BROWSER_DRAFT_ROOT",p);
    const tools=new NewChatIntegratedFixture("chatgpt");
    const driver=new ChatGptMacCdpDriver(tools);
    const chat=await driver.createChat({title:"Explicit new chat"});
    expect(chat.pendingRemoteCreation).toBe(true);
    const code=tools.calls.filter(c=>c.name==="evaluate_script").map(c=>String(c.args.function));
    expect(code.some(c=>c.includes("/api/auth/session"))).toBe(true);
    expect(code.some(c=>c.includes("/backend-api/conversations?offset"))).toBe(false);
    expect(tools.calls.some(c=>c.name==="fill")).toBe(false);
  });
});

describe("first message on an explicitly pinned blank page", () => {
  for (const site of ["chatgpt", "zai"] as const) {
    it(site + " submits on the verified pin without opening or closing another page", async () => {
      const tools = new NewChatPageFixture(site);
      const result = await submitFirstChatMessage(tools, site, "owned fixture input", ACCOUNT, 9);
      expect(result).toMatchObject({clicked:true, uncertain:false});
      expect(tools.calls.some(call => call.name === "new_page" || call.name === "close_page")).toBe(false);
      expect(tools.calls.filter(call => call.args.pageId !== undefined).every(call => call.args.pageId === 9)).toBe(true);
    });
    it(site + " preserves a pinned user draft without filling, clicking or closing", async () => {
      const tools = new NewChatPageFixture(site);
      tools.inheritedDraft = true;
      const result = await submitFirstChatMessage(tools, site, "owned fixture input", ACCOUNT, 9);
      expect(result).toMatchObject({clicked:false, uncertain:false});
      expect(tools.calls.some(call => ["new_page", "fill", "close_page"].includes(call.name))).toBe(false);
    });
    it(site + " rejects an existing conversation on the pin before any mutation", async () => {
      class ExistingChat extends NewChatPageFixture {
        override async call(name:string,args:Record<string,unknown>={}) {
          if(name === "evaluate_script" && String(args.function).includes("ready:!!editor")) {
            this.calls.push({name,args});
            return json({origin:this.origin,path:this.remoteRoute,ready:true,empty:true});
          }
          return super.call(name,args);
        }
      }
      const tools = new ExistingChat(site);
      const result = await submitFirstChatMessage(tools, site, "owned fixture input", ACCOUNT, 9);
      expect(result).toMatchObject({clicked:false, uncertain:false});
      expect(tools.calls.some(call => ["new_page", "fill", "close_page"].includes(call.name))).toBe(false);
    });
  }
});

for (const site of ["chatgpt", "zai"] as const) {
  it(site + " legacy driver forwards its exact page pin for the first draft send", async () => {
    vi.stubEnv("AGENT_HERDER_BROWSER_DRAFT_ROOT", await root());
    class PinnedFixture extends NewChatPageFixture {
      override async call(name:string,args:Record<string,unknown>={}) {
        if(name === "list_pages") {
          this.calls.push({name,args});
          return "9: Owned blank page ("+this.origin+"/)";
        }
        return super.call(name,args);
      }
    }
    const tools = new PinnedFixture(site);
    const driver = site === "chatgpt" ? new ChatGptMacCdpDriver(tools,9,0,ACCOUNT) : new ZaiCdpDriver(tools,9,0);
    const draft = await driver.createChat({title:"Owned test"});
    await driver.sendMessage({chatId:draft.id,text:"owned fixture input"});
    expect(tools.calls.some(call => call.name === "new_page")).toBe(false);
    expect(tools.calls.filter(call => call.name === "fill")).toEqual([
      {name:"fill",args:expect.objectContaining({pageId:9,value:"owned fixture input"})},
    ]);
  });
}

describe("one marked tab per provider", () => {
  it("submits the first message in the already owned marked tab instead of opening another one", async () => {
    const opened: string[] = [];
    const listing = "7: ChatGPT (https://chatgpt.com/?herder_owned=chatgpt)";
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return listing;
      if (name === "new_page") { opened.push(String(args.url)); return ""; }
      if (name === "take_snapshot") return 'uid=1_42 textbox "Спросить ChatGPT" multiline';
      if (name === "fill") return "ok";
      if (name === "evaluate_script") {
        const source = String(args.function);
        if (source.includes("/api/auth/session")) return json({ scope: ACCOUNT });
        if (source.includes("return {value:")) return json({ value: "leftover draft" });
        if (source.includes("ready:!!editor")) return json({ origin: "https://chatgpt.com", path: "/", ready: true, empty: true });
        if (source.includes("send_not_ready")) return json({ submitted: true });
        if (source.includes("path:location.pathname")) return json({ origin: "https://chatgpt.com", path: "/c/" + GPT_NATIVE });
        return json({});
      }
      throw new Error("unexpected action " + name);
    } };
    const receipt = await submitFirstChatMessage(tools, "chatgpt", "hello", ACCOUNT);
    expect(opened).toEqual([]);
    expect(receipt.clicked).toBe(true);
  });
});

describe("first message composer content", () => {
  it("clears a leftover composer value before filling the first message", async () => {
    const fills: string[] = [];
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/?herder_owned=chatgpt)";
      if (name === "take_snapshot") return 'uid=1_42 textbox "Спросить ChatGPT" multiline value=""';
      if (name === "fill") { fills.push(String(args.value)); return "ok"; }
      if (name === "evaluate_script") {
        const source = String(args.function);
        if (source.includes("/api/auth/session")) return json({ scope: ACCOUNT });
        if (source.includes("return {value:")) return json({ value: "leftover draft" });
        if (source.includes("ready:!!editor")) return json({ origin: "https://chatgpt.com", path: "/", ready: true, empty: true });
        if (source.includes("send_not_ready")) return json({ submitted: true });
        if (source.includes("path:location.pathname")) return json({ origin: "https://chatgpt.com", path: "/c/" + GPT_NATIVE });
        return json({});
      }
      throw new Error("unexpected action " + name);
    } };
    await submitFirstChatMessage(tools, "chatgpt", "User prompt", ACCOUNT);
    // The composer is cleared by replacing its content, then the user's own
    // text is written once.
    expect(fills).toEqual(["User prompt"]);
  });
});

describe("owned tab with a leftover composer", () => {
  it("clears the leftover value of its own marked tab instead of refusing to send", async () => {
    const fills: string[] = [];
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/?herder_owned=chatgpt)";
      if (name === "take_snapshot") return 'uid=1_42 textbox "Спросить ChatGPT" multiline value="leftover"';
      if (name === "fill") { fills.push(String(args.value)); return "ok"; }
      if (name === "evaluate_script") {
        const source = String(args.function);
        if (source.includes("/api/auth/session")) return json({ scope: ACCOUNT });
        if (source.includes("ready:!!editor")) return json({ origin: "https://chatgpt.com", path: "/", ready: true, empty: true });
        if (source.includes("send_not_ready")) return json({ submitted: true });
        if (source.includes("path:location.pathname")) return json({ origin: "https://chatgpt.com", path: "/c/" + GPT_NATIVE });
        return json({});
      }
      throw new Error("unexpected action " + name);
    } };
    const receipt = await submitFirstChatMessage(tools, "chatgpt", "User prompt", ACCOUNT);
    expect(receipt.clicked).toBe(true);
    expect(fills).toEqual(["User prompt"]);
  });
});

describe("first message composer replacement", () => {
  it("replaces the whole composer content instead of appending to it", async () => {
    const scripts: string[] = [];
    const tools: ChromePageTools = { call: async (name, args = {}) => {
      if (name === "list_pages") return "7: ChatGPT (https://chatgpt.com/?herder_owned=chatgpt)";
      if (name === "take_snapshot") return 'uid=1_42 textbox "Спросить ChatGPT" multiline value="leftover"';
      if (name === "fill") return "ok";
      if (name === "evaluate_script") {
        const source = String(args.function);
        scripts.push(source);
        if (source.includes("/api/auth/session")) return json({ scope: ACCOUNT });
        if (source.includes("ready:!!editor")) return json({ origin: "https://chatgpt.com", path: "/", ready: true, empty: true });
        if (source.includes("send_not_ready")) return json({ submitted: true });
        if (source.includes("path:location.pathname")) return json({ origin: "https://chatgpt.com", path: "/c/" + GPT_NATIVE });
        return json({});
      }
      throw new Error("unexpected action " + name);
    } };
    await submitFirstChatMessage(tools, "chatgpt", "User prompt", ACCOUNT);
    const replace = scripts.find(source => source.includes("execCommand('delete')"));
    expect(replace).toBeTruthy();
  });
});
