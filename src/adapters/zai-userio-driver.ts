import { randomUUID } from "node:crypto";
import type { BrowserChat, BrowserChatDriver } from "./browser-chat.js";
import type { SessionMessageView } from "../types/index.js";
import { UserIoAgentChannel, type UserIoConfig } from "./userio-agent-channel.js";

const REF=/^[a-f0-9-]{12,80}$/iu;
const SCOPE=/^[a-f0-9]{64}$/u;
type NativeZaiMessage={id:string;role:"user"|"assistant";text:string;
  timestamp?:number;model?:string;done?:boolean};
export class ZaiUserIoDriver implements BrowserChatDriver{
  readonly browserFeatures={nativeConversationIds:true,queueAfterGeneration:false,
    chatCreation:false,accountArchiveViaCdp:false,projects:false};
  readonly passiveInventory=true;
  private readonly channel:UserIoAgentChannel;
  private readonly config:UserIoConfig;
  private known:BrowserChat[]=[];
  private accountScope:string|undefined;
  constructor(config:UserIoConfig){
    this.config=config;
    this.channel=new UserIoAgentChannel(config);
  }
  getAccountScope(){return this.accountScope;}
  async verifyPinnedAccountScope(expectedScope=this.config.accountScope):Promise<void>{
    this.accountScope=undefined;
    await this.channel.verifyPrincipal();
    const reply=await this.channel.call("zai_scope");
    if(typeof reply.account_scope!=="string"||!SCOPE.test(reply.account_scope))
      throw new Error("zai_userio_account_unavailable");
    if(reply.account_scope!==expectedScope)
      throw new Error("pinned browser account scope mismatch");
    this.accountScope=reply.account_scope;
  }
  private check(){
    if(this.accountScope!==this.config.accountScope)
      throw new Error("pinned browser account scope mismatch");
  }
  private ref(input:string){
    const native=input.startsWith("route:")?input.slice(6):input;
    if(!REF.test(native))throw new Error("zai_invalid_chat_ref");
    return native;
  }
  async listChats():Promise<readonly BrowserChat[]>{
    this.check();
    const result=await this.channel.call("zai_list",{
      expected_account_scope:this.config.accountScope});
    if(!Array.isArray(result.chats)||result.account_scope!==this.config.accountScope)
      throw new Error("zai_userio_list_invalid");
    this.known=result.chats.flatMap((value):BrowserChat[]=>{
      if(!value||typeof value!=="object")return [];
      const v=value as Record<string,unknown>;
      if(typeof v.id!=="string"||!REF.test(v.id))return [];
      const updated=Number(v.updated_at);
      const time=Number.isFinite(updated)&&updated>0
        ?new Date(updated<1e12?updated*1000:updated).toISOString():new Date(0).toISOString();
      return [{id:"route:"+v.id,
        title:typeof v.title==="string"?v.title.slice(0,160):"Z.AI conversation",
        updatedAt:time,updatedAtSemantics:"remote-update-time",
        unread:v.unread===true,working:v.last_run_status==="running",
        ...(v.last_run_status==="running"?{workingSource:"native-last-run" as const}:{})}];
    });
    return this.known;
  }
  listObservedChats(){return this.listChats();}
  getKnownChat(chatId:string){return this.known.find(c=>c.id===chatId)??null;}
  async getChat(chatId:string){
    const id=this.ref(chatId);
    return this.getKnownChat("route:"+id)
      ??(await this.listChats()).find(c=>c.id==="route:"+id)??null;
  }
  private async read(chatId:string){
    this.check();
    const id=this.ref(chatId);
    const result=await this.channel.call("zai_read",{
      chat_ref:id,expected_account_scope:this.config.accountScope});
    if(result.chat_ref!==id||!Array.isArray(result.messages))
      throw new Error("zai_userio_read_invalid");
    return result;
  }
  async getMessages(chatId:string):Promise<SessionMessageView[]>{
    const result=await this.read(chatId);
    return (result.messages as unknown[]).flatMap((raw):SessionMessageView[]=>{
      if(!raw||typeof raw!=="object")return [];
      const m=raw as Record<string,unknown>;
      if(typeof m.id!=="string"||!REF.test(m.id)
        ||(m.role!=="user"&&m.role!=="assistant")
        ||typeof m.text!=="string"||m.text.length>16000)return [];
      const timestamp=Number(m.timestamp);
      return [{id:m.id,role:m.role,text:m.text,
        parts:[{type:"text",text:m.text}],
        ...(typeof m.model==="string"&&m.model?{model:m.model}:{}),
        ...(m.done===true?{completionStatus:"finished_successfully",endTurn:true}:{}),
        ...(Number.isFinite(timestamp)&&timestamp>0
          ?{timestamp:new Date(timestamp<1e12?timestamp*1000:timestamp).toISOString()}:{})}];
    });
  }
  async sendMessage(input:{chatId:string;text:string;waitForCompletion?:boolean}):
      Promise<{assistantText?:string}>{
    this.check();
    const chat_ref=this.ref(input.chatId);
    if(typeof input.text!=="string"||!input.text.trim()||input.text.length>16000)
      throw new Error("ZAI submission rejected before click: send_not_ready");
    const before=await this.read(input.chatId);
    if(before.ready!==true)throw new Error("ZAI submission rejected before click: send_not_ready");
    await this.verifyPinnedAccountScope();
    try{
      const result=await this.channel.call("zai_send",{
        chat_ref,expected_account_scope:this.config.accountScope,
        text:input.text,request_id:randomUUID()
      },195000);
      if(result.admission!=="confirmed"
        ||typeof result.native_user_message_id!=="string"
        ||!REF.test(result.native_user_message_id)
        ||result.chat_ref!==chat_ref)
        throw new Error("zai_send_receipt_invalid");
      return {};
    }catch{
      // The browser may have clicked before the command's acknowledgement
      // was lost. We cannot safely prove a pre-click refusal here.
      throw new Error("ZAI submission outcome unknown: do not retry automatically");
    }
  }
}
