import { createHash, randomUUID } from "node:crypto";
import type { BrowserChat, BrowserChatDriver } from "./browser-chat.js";
import type { RawTranscriptExport, SessionMessageView } from "../types/index.js";
import { UserIoAgentChannel, userIoAccountScope, type UserIoConfig, type UserIoAgentResult } from "./userio-agent-channel.js";
import { BrowserChatDraftStore } from "./browser-chat-drafts.js";
export type { UserIoConfig } from "./userio-agent-channel.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA = /^[a-f0-9]{64}$/u;
type AgentResult=UserIoAgentResult;
type GptMessage={id:string;role:"user"|"assistant";text:string;status:string;
  end_turn:boolean;create_time:number;update_time:number;phase?:string;model?:string};
type GptRead=AgentResult & {chat_ref?:string;ready?:boolean;
  latest_user?:GptMessage;latest_assistant?:GptMessage|null;messages?:GptMessage[];
  account_scope?:string;snapshot_epoch?:unknown;revision?:unknown;coverage?:unknown;complete?:unknown;limitations?:unknown};

export class UserIoChatGptDriver implements BrowserChatDriver {
  readonly browserFeatures = {nativeConversationIds:true,queueAfterGeneration:false,
    chatCreation:true,accountArchiveViaCdp:false,projects:false};
  readonly passiveInventory = true;
  readonly supportsFirstSendReceipt = true;
  private readonly channel:UserIoAgentChannel;
  private readonly config:UserIoConfig;
  private known:BrowserChat[]=[];
  private verifiedAccountScope:string|undefined;
  private readonly drafts = new BrowserChatDraftStore("chatgpt");
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
    await this.drafts.useScope(undefined);
    await this.channel.verifyPrincipal();
    const nonce=randomUUID();
    const proof=await this.call("gpt_session_proof",{nonce});
    if(proof.present!==true||typeof proof.proof!=="string"||!SHA.test(proof.proof))
      throw new Error("userio_session_proof_unavailable");
    const identity=await this.call("gpt_scope");
    if(typeof identity.account_scope!=="string"||!SHA.test(identity.account_scope))
      throw new Error("userio_account_scope_unavailable");
    if(identity.provider!==undefined||identity.user_id!==undefined||identity.account_id!==undefined) {
      if(typeof identity.provider!=="string"||typeof identity.user_id!=="string"||typeof identity.account_id!=="string"
        ||userIoAccountScope(identity.provider,identity.user_id,identity.account_id)!==identity.account_scope)
        throw new Error("userio_account_scope_identity_mismatch");
    }
    if(identity.account_scope!==this.config.accountScope)
      throw new Error("pinned browser account scope mismatch");
    this.verifiedAccountScope=identity.account_scope;
    await this.drafts.useScope(identity.account_scope);
  }
  async createChat(input:{title?:string}):Promise<BrowserChat> {
    this.assertAccount();
    return this.drafts.create(input.title);
  }
  async archiveChat(id:string):Promise<{ok:boolean;error?:string}> {
    this.assertAccount();
    await this.verifyPinnedAccountScope();
    const draft=this.drafts.get(id);
    if(draft?.state==="pending") { await this.drafts.discard(id); return {ok:true}; }
    if(draft && draft.state!=="admitted") return {ok:false,error:"first_send_outcome_unknown"};
    const native=draft?.remoteId ?? id;
    if(!UUID.test(native))return {ok:false,error:"invalid_chat_ref"};
    try {
      const result=await this.call("gpt_archive",{chat_ref:native,expected_account_scope:this.config.accountScope});
      if(result.archived!==true||result.chat_ref!==native)throw new Error("archive_unconfirmed");
      if(draft)await this.drafts.discard(id,true);
      this.known=this.known.filter(chat=>chat.id!==native);
      return {ok:true};
    }catch{return {ok:false,error:"archive_outcome_unknown"};}
  }
  private assertAccount(){
    if(this.verifiedAccountScope!==this.config.accountScope)
      throw new Error("pinned browser account scope mismatch");
  }
  async reconcileFirstSend(id:string):Promise<{nativeInputMessageId:string}|undefined> {
    await this.verifyPinnedAccountScope();
    const draft=this.drafts.get(id);
    if(!draft || !["sending","uncertain"].includes(draft.state) || !draft.commandId)return undefined;
    const result=await this.channel.result(draft.commandId,"gpt_first_send");
    if(!result)return undefined;
    if(result.admission!=="confirmed"||typeof result.chat_ref!=="string"||!UUID.test(result.chat_ref)||typeof result.native_user_message_id!=="string"||!UUID.test(result.native_user_message_id))throw new Error("invalid_receipt");
    await this.drafts.admit(id,result.chat_ref,result.native_user_message_id);
    return {nativeInputMessageId:result.native_user_message_id};
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
    return this.drafts.merge(this.known);
  }
  listChats(){return this.listObservedChats();}
  getKnownChat(id:string){const draft=this.drafts.get(id);return draft?this.drafts.asChat(draft,this.known.find(c=>c.id===draft.remoteId)):this.known.find(c=>c.id===id)??null;}
  async getChat(id:string){if(id.startsWith("draft:"))return this.getKnownChat(id); if(!UUID.test(id))return null;
    return this.getKnownChat(id)??(await this.listObservedChats()).find(c=>c.id===id)??null;}
  private async read(chatId:string):Promise<GptRead>{
    this.assertAccount();
    chatId=this.drafts.get(chatId)?.remoteId ?? chatId;
    if(!UUID.test(chatId))throw new Error("invalid_chat_ref");
    const value=await this.call("gpt_read",{chat_ref:chatId,
      expected_account_scope:this.config.accountScope});
    if(value.chat_ref!==chatId||(!value.latest_user&&!Array.isArray(value.messages)))
      throw new Error("userio_read_invalid");
    if(value.account_scope!==this.config.accountScope)
      throw new Error("userio_read_account_mismatch");
    if(value.messages!==undefined&&!Array.isArray(value.messages))
      throw new Error("userio_read_invalid");
    return value as GptRead;
  }
  private asMessage(raw:GptMessage):SessionMessageView {
    if(!raw||!UUID.test(raw.id)||!["user","assistant"].includes(raw.role)
      ||typeof raw.text!=="string"||raw.text.length>16000||typeof raw.status!=="string"
      ||typeof raw.end_turn!=="boolean"||!Number.isFinite(raw.create_time)||!Number.isFinite(raw.update_time))
      throw new Error("userio_message_invalid");
    return {id:raw.id,role:raw.role,text:raw.text,parts:[{type:"text",text:raw.text}],
      ...(raw.status?{completionStatus:raw.status}:{}),
      endTurn:raw.end_turn,phase:raw.phase,model:raw.model,
      ...(Number.isFinite(raw.create_time)&&raw.create_time>0
        ?{timestamp:new Date(raw.create_time*1000).toISOString()}:{})};
  }
  async getMessages(chatId:string):Promise<SessionMessageView[]>{
    const data=await this.read(chatId);
    const all=data.messages??[data.latest_user,data.latest_assistant].filter(
      (item):item is GptMessage=>!!item);
    return all.map(item=>this.asMessage(item));
  }
  async getRawTranscript(chatId:string):Promise<RawTranscriptExport>{
    const data=await this.read(chatId);
    chatId=this.drafts.get(chatId)?.remoteId ?? chatId;
    const messages=data.messages??[data.latest_user,data.latest_assistant].filter((m):m is GptMessage=>!!m);
    messages.forEach(message=>this.asMessage(message));
    const complete=Array.isArray(data.messages)&&data.complete===true
      &&typeof data.snapshot_epoch==='string'&&data.snapshot_epoch.length>0
      &&(typeof data.revision==='string'||Number.isSafeInteger(data.revision))
      &&typeof data.coverage==='string'&&data.coverage.length>0
      &&Array.isArray(data.limitations)&&data.limitations.every(v=>typeof v==='string');
    const limitations=Array.isArray(data.limitations)?data.limitations.filter((v):v is string=>typeof v==='string'):[];
    if(!complete)limitations.push('Native snapshot completeness is not established.');
    return {bytes:Buffer.from(JSON.stringify(data)),complete,source:{kind:'native-api',
      location:`https://chatgpt.com/c/${chatId}`,format:'json'},timestampCoverage:complete?'native':'partial',limitations};
  }
  async sendMessage(input:{chatId:string;text:string;waitForCompletion?:boolean}):
      Promise<{assistantText?:string;nativeInputMessageId?:string}>{
    this.assertAccount();
    if(input.chatId.startsWith("draft:")) {
      if(typeof input.text!=="string"||!input.text.trim()||input.text.length>16000)throw new Error("ChatGPT submission rejected before click: send_not_ready");
      const draft=this.drafts.get(input.chatId);
      if(!draft)throw new Error("draft_changed");
      const inputDigest=createHash("sha256").update(input.text).digest("hex");
      if(draft.state==="sending"||draft.state==="uncertain") {
        if(!draft.inputDigest||draft.inputDigest!==inputDigest)throw new Error("First-message submission is uncertain; reconcile without automatic retry");
        const recovered=await this.reconcileFirstSend(input.chatId).catch(()=>undefined);
        if(recovered)return recovered;
        throw new Error("First-message submission is uncertain; reconcile without automatic retry");
      }
      if(draft.state!=="admitted") {
        await this.verifyPinnedAccountScope();
        await this.drafts.startSend(input.chatId,inputDigest);
        try {
          const result=await this.channel.call("gpt_first_send",{text:input.text,expected_account_scope:this.config.accountScope},155000,
            commandId=>this.drafts.recordCommand(input.chatId,commandId));
          if(result.admission!=="confirmed"||typeof result.chat_ref!=="string"||!UUID.test(result.chat_ref)||typeof result.native_user_message_id!=="string"||!UUID.test(result.native_user_message_id))throw new Error("invalid_receipt");
          await this.drafts.admit(input.chatId,result.chat_ref,result.native_user_message_id);
          return {nativeInputMessageId:result.native_user_message_id};
        } catch {
          await this.drafts.markUncertain(input.chatId);
          throw new Error("ChatGPT submission outcome unknown: do not retry automatically");
        }
      }
      input={...input,chatId:draft.remoteId!};
    }
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
      if(result.native_user_message_id!==undefined && (result.admission!=="confirmed" || result.chat_ref!==input.chatId || typeof result.native_user_message_id!=="string" || !UUID.test(result.native_user_message_id)))throw new Error("invalid_receipt");
      return {assistantText:typeof result.reply==="string"?result.reply:undefined,
        ...(typeof result.native_user_message_id==="string"?{nativeInputMessageId:result.native_user_message_id}:{})};
    }catch{
      // The post may have been consumed before the HTTP/readback failed.
      // Never describe this as a safe non-submission or automatically replay it.
      throw new Error("ChatGPT submission outcome unknown: do not retry automatically");
    }
  }
}
