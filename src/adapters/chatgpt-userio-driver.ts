import { randomUUID } from "node:crypto";
import type { BrowserChat, BrowserChatDriver } from "./browser-chat.js";
import type { SessionMessageView } from "../types/index.js";
import { UserIoAgentChannel, type UserIoConfig, type UserIoAgentResult } from "./userio-agent-channel.js";
export type { UserIoConfig } from "./userio-agent-channel.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA = /^[a-f0-9]{64}$/u;
type AgentResult=UserIoAgentResult;
type GptMessage={id:string;role:"user"|"assistant";text:string;status:string;
  end_turn:boolean;create_time:number;update_time:number;phase?:string;model?:string};
type GptRead=AgentResult & {chat_ref?:string;ready?:boolean;
  latest_user?:GptMessage;latest_assistant?:GptMessage|null};

export class UserIoChatGptDriver implements BrowserChatDriver {
  readonly browserFeatures = {nativeConversationIds:true,queueAfterGeneration:false,
    chatCreation:false,accountArchiveViaCdp:false,projects:false};
  readonly passiveInventory = true;
  private readonly channel:UserIoAgentChannel;
  private readonly config:UserIoConfig;
  private known:BrowserChat[]=[];
  private verifiedAccountScope:string|undefined;
  constructor(config:UserIoConfig){
    this.channel=new UserIoAgentChannel(config);
    this.config=config;
  }
  getAccountScope(){return this.verifiedAccountScope;}
  private call(action:string,args:Record<string,unknown>={},timeout=135000){
    return this.channel.call(action,args,timeout);
  }
  async verifyPinnedAccountScope():Promise<void>{
    this.verifiedAccountScope=undefined;
    await this.channel.verifyPrincipal();
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
