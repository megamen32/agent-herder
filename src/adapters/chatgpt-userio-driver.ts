import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { BrowserChat, BrowserChatDriver } from "./browser-chat.js";
import type { SessionMessageView } from "../types/index.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const INSTANCE = /^browser-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
export type UserIoConfig = {
  endpoint: string; agentId: string; instanceId: string;
  accountScope: string; tokenFile: string;
  fetcher?: typeof fetch;
};
type AgentResult = {ok: boolean; error?: string; [k: string]: unknown};
type GptMessage = {
  id: string; role: "user" | "assistant"; text: string; status: string;
  end_turn: boolean; create_time: number; update_time: number;
  phase?: string; model?: string;
};
type GptRead = AgentResult & {chat_ref?: string; ready?: boolean;
  latest_user?: GptMessage; latest_assistant?: GptMessage | null};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const parseEndpoint = (raw: string): string => {
  let url: URL;
  try {url=new URL(raw);}catch{throw new Error("userio_endpoint_invalid");}
  const localhost = ["127.0.0.1","localhost","[::1]"].includes(url.hostname);
  if ((url.protocol!=="https:" && !(localhost && url.protocol==="http:"))
    || url.pathname!=="/" || url.search || url.hash || url.username || url.password)
    throw new Error("userio_endpoint_invalid");
  return url.origin;
};
const loadToken = async (path: string): Promise<string> => {
  if (!isAbsolute(path)||path.split(/[\\/]+/u).includes("..")||normalize(path)!==path)
    throw new Error("userio_token_file_invalid");
  try {
    const stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.size>8192
      ||stat.size<8||(process.getuid&&stat.uid!==process.getuid()))
      throw new Error("file");
    const data=(await readFile(path,"utf8")).trim();
    const token=data.startsWith("{")
      ? (()=>{const value=JSON.parse(data) as {authorization?:unknown};
        return typeof value.authorization==="string" ? value.authorization.replace(/^Bearer\s+/iu,""):"";})()
      : data;
    if(typeof token!=="string"||token.length<8||token.length>8192||/\s/u.test(token))
      throw new Error("token");
    return token;
  } catch {throw new Error("userio_token_unavailable");}
};
export class UserIoChatGptDriver implements BrowserChatDriver {
  readonly browserFeatures = {nativeConversationIds:true,queueAfterGeneration:false,
    chatCreation:false,accountArchiveViaCdp:false,projects:false};
  readonly passiveInventory = true;
  private readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly config: UserIoConfig;
  private known: BrowserChat[] = [];
  private verifiedAccountScope: string|undefined;
  constructor(config: UserIoConfig){
    this.endpoint=parseEndpoint(config.endpoint);
    if(!/^[A-Za-z0-9_.:-]{1,128}$/u.test(config.agentId)
      ||!INSTANCE.test(config.instanceId)||!SHA.test(config.accountScope)
      ||!isAbsolute(config.tokenFile))throw new Error("userio_profile_invalid");
    this.config=config;
    this.fetcher=config.fetcher??fetch;
  }
  getAccountScope(){return this.verifiedAccountScope;}
  private async request(method: "POST"|"GET",path:string,body?:unknown){
    const token=await loadToken(this.config.tokenFile);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),20000);
    try {
      const response=await this.fetcher(this.endpoint+path,{
        method,headers:{Authorization:"Bearer "+token,
          ...(method==="POST"?{"Content-Type":"application/json"}:{})},
        ...(method==="POST"?{body:JSON.stringify(body)}:{}),
        signal:controller.signal
      });
      if(!response.ok)throw new Error("userio_http_"+response.status);
      return await response.json() as Record<string,unknown>;
    } catch {throw new Error("userio_transport_unavailable");}
    finally {clearTimeout(timer);}
  }
  private async call(action:string,args:Record<string,unknown>={},timeout=135000):Promise<AgentResult>{
    const ack=await this.request("POST","/v1/agent/commands",{
      agent_id:this.config.agentId,agent_instance_id:this.config.instanceId,action,args});
    const id=ack.id;
    if(ack.queued!==true||typeof id!=="string"||!id.startsWith(this.config.agentId+":"))
      throw new Error("userio_command_rejected");
    const deadline=Date.now()+timeout;
    while(Date.now()<deadline){
      await sleep(450);
      const response=await this.request("GET","/v1/agent/results?agent_id="+
        encodeURIComponent(this.config.agentId)+"&limit=200");
      const matches=Array.isArray(response.results)?response.results.filter((v): v is Record<string,unknown>=>
        !!v&&typeof v==="object"&&v.id===id):[];
      if(matches.length>1)throw new Error("userio_duplicate_command_result");
      if(matches.length){
        const record=matches[0]!;
        if(record.action!==action||record.agent_id!==this.config.agentId
          ||!record.result||typeof record.result!=="object")
          throw new Error("userio_command_result_mismatch");
        const value=record.result as AgentResult;
        if(value.ok!==true)throw new Error(
          typeof value.error==="string"&&/^[a-z0-9_]{1,100}$/u.test(value.error)
            ? value.error:"userio_command_failure");
        return value;
      }
    }
    throw new Error("userio_command_outcome_unknown");
  }
  async verifyPinnedAccountScope():Promise<void>{
    this.verifiedAccountScope=undefined;
    // UserIO queues are partitioned by authenticated principal. A valid
    // bearer for another UserIO user silently queues to the wrong partition.
    // Refuse it BEFORE enqueueing a proof or any future write.
    const status=await this.request("GET","/v1/agent/status");
    const agents=Array.isArray(status.agents)?status.agents:[];
    const live=agents.find((item):item is Record<string,unknown>=>
      !!item&&typeof item==="object"
      &&(item as Record<string,unknown>).agent_id===this.config.agentId);
    const online=Array.isArray(live?.instances)?live.instances:[];
    if(!online.includes(this.config.instanceId))
      throw new Error("userio_profile_principal_mismatch");
    const nonce=randomUUID();
    const proof=await this.call("gpt_session_proof",{nonce});
    if(proof.present!==true||typeof proof.proof!=="string"||!SHA.test(proof.proof))
      throw new Error("userio_session_proof_unavailable");
    const identity=await this.call("gpt_scope");
    if(typeof identity.account_scope!=="string"||!SHA.test(identity.account_scope))
      throw new Error("userio_account_scope_unavailable");
    if(identity.account_scope!==this.config.accountScope)
      throw new Error("pinned browser account scope mismatch");
    this.verifiedAccountScope=identity.account_scope;
  }
  private assertAccount(){
    if(this.verifiedAccountScope!==this.config.accountScope)
      throw new Error("pinned browser account scope mismatch");
  }
  async listObservedChats():Promise<readonly BrowserChat[]> {
    this.assertAccount();
    const response=await this.call("gpt_list",{expected_account_scope:this.config.accountScope});
    if(!Array.isArray(response.chats))throw new Error("userio_list_invalid");
    this.known=response.chats.flatMap((c):BrowserChat[]=>{
      if(!c||typeof c!=="object")return [];
      const row=c as Record<string,unknown>;
      if(typeof row.id!=="string"||!UUID.test(row.id))return [];
      const stamp=typeof row.update_time==="number"&&Number.isFinite(row.update_time)
        ?new Date(row.update_time*1000).toISOString():new Date(0).toISOString();
      return [{id:row.id,title:typeof row.title==="string"?row.title.slice(0,160):"ChatGPT",
        unread:false,working:false,updatedAt:stamp,updatedAtSemantics:"remote-update-time"}];
    });
    return this.known;
  }
  listChats(){return this.listObservedChats();}
  getKnownChat(id:string){return this.known.find(c=>c.id===id)??null;}
  async getChat(id:string){if(!UUID.test(id))return null;
    return this.getKnownChat(id)??(await this.listObservedChats()).find(c=>c.id===id)??null;}
  private async read(chatId:string):Promise<GptRead>{
    this.assertAccount();
    if(!UUID.test(chatId))throw new Error("invalid_chat_ref");
    const value=await this.call("gpt_read",{chat_ref:chatId,
      expected_account_scope:this.config.accountScope});
    if(value.chat_ref!==chatId||!value.latest_user)
      throw new Error("userio_read_invalid");
    return value as GptRead;
  }
  private asMessage(raw:GptMessage):SessionMessageView {
    if(!raw||!UUID.test(raw.id)||!["user","assistant"].includes(raw.role)
      ||typeof raw.text!=="string"||raw.text.length>16000)
      throw new Error("userio_message_invalid");
    return {id:raw.id,role:raw.role,text:raw.text,parts:[{type:"text",text:raw.text}],
      ...(raw.status?{completionStatus:raw.status}:{}),
      endTurn:raw.end_turn,phase:raw.phase,model:raw.model,
      ...(Number.isFinite(raw.create_time)&&raw.create_time>0
        ?{timestamp:new Date(raw.create_time*1000).toISOString()}:{})};
  }
  async getMessages(chatId:string):Promise<SessionMessageView[]>{
    const data=await this.read(chatId);
    const all=[data.latest_user,data.latest_assistant].filter(
      (item):item is GptMessage=>!!item);
    return all.map(item=>this.asMessage(item));
  }
  async sendMessage(input:{chatId:string;text:string;waitForCompletion?:boolean}):
      Promise<{assistantText?:string}>{
    this.assertAccount();
    if(!UUID.test(input.chatId)||typeof input.text!=="string"||!input.text.trim()
      ||input.text.length>16000)throw new Error("ChatGPT submission rejected before click: send_not_ready");
    const before=await this.read(input.chatId);
    if(!before.ready||!before.latest_assistant?.end_turn)
      throw new Error("ChatGPT submission rejected before click: send_not_ready");
    await this.verifyPinnedAccountScope();
    try {
      const result=await this.call("gpt_send",{chat_ref:input.chatId,text:input.text,
        mode:"ui",expected_account_scope:this.config.accountScope},155000);
      if(result.chat_url){
        try{const url=new URL(String(result.chat_url));
          if(url.origin!=="https://chatgpt.com"||url.pathname!=="/c/"+input.chatId)
            throw new Error("chat_url_mismatch");
        }catch{throw new Error("chat_url_mismatch");}
      }
      return {assistantText:typeof result.reply==="string"?result.reply:undefined};
    }catch{
      // The post may have been consumed before the HTTP/readback failed.
      // Never describe this as a safe non-submission or automatically replay it.
      throw new Error("ChatGPT submission outcome unknown: do not retry automatically");
    }
  }
}
