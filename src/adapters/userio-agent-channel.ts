import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

const INSTANCE = /^browser-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA = /^[a-f0-9]{64}$/u;
export type UserIoConfig = {
  endpoint:string; agentId:string; instanceId:string; accountScope:string;
  tokenFile:string; fetcher?:typeof fetch;
};
export type UserIoAgentResult = {ok:boolean;error?:string;[k:string]:unknown};
const sleep = (ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const endpoint=(value:string)=>{
  let url:URL;try{url=new URL(value);}catch{throw new Error("userio_endpoint_invalid");}
  const loopback=["127.0.0.1","localhost","[::1]"].includes(url.hostname);
  if((url.protocol!=="https:"&&!(loopback&&url.protocol==="http:"))
    ||url.pathname!=="/"||url.search||url.hash||url.username||url.password)
    throw new Error("userio_endpoint_invalid");
  return url.origin;
};
const token=async(path:string)=>{
  if(!isAbsolute(path)||path.split(/[\\/]+/u).includes("..")||normalize(path)!==path)
    throw new Error("userio_token_file_invalid");
  try{
    const stat=await lstat(path);
    if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0
      ||stat.size<8||stat.size>8192||(process.getuid&&stat.uid!==process.getuid()))
      throw new Error("file");
    const raw=(await readFile(path,"utf8")).trim();
    const result=raw.startsWith("{")?(()=>{
      const obj=JSON.parse(raw) as {authorization?:unknown};
      return typeof obj.authorization==="string"
        ?obj.authorization.replace(/^Bearer\s+/iu,""):"";
    })():raw;
    if(!result||result.length>8192||/\s/u.test(result))throw new Error("token");
    return result;
  }catch{throw new Error("userio_token_unavailable");}
};
export class UserIoAgentChannel {
  private readonly url:string;
  private readonly fetcher:typeof fetch;
  readonly config:UserIoConfig;
  constructor(config:UserIoConfig){
    this.url=endpoint(config.endpoint);
    if(!/^[A-Za-z0-9_.:-]{1,128}$/u.test(config.agentId)
      ||!INSTANCE.test(config.instanceId)||!SHA.test(config.accountScope)
      ||!isAbsolute(config.tokenFile))throw new Error("userio_profile_invalid");
    this.config=config;
    this.fetcher=config.fetcher??fetch;
  }
  private async request(method:"GET"|"POST",path:string,body?:unknown):Promise<Record<string,unknown>>{
    const secret=await token(this.config.tokenFile);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),20000);
    try{
      const reply=await this.fetcher(this.url+path,{
        method,headers:{Authorization:"Bearer "+secret,...(method==="POST"
          ?{"Content-Type":"application/json"}:{})},
        ...(method==="POST"?{body:JSON.stringify(body)}:{}),
        signal:controller.signal,
      });
      if(!reply.ok)throw new Error("userio_http_"+reply.status);
      return await reply.json() as Record<string,unknown>;
    }catch{throw new Error("userio_transport_unavailable");}
    finally{clearTimeout(timer);}
  }
  async verifyPrincipal():Promise<void>{
    const status=await this.request("GET","/v1/agent/status");
    const agents=Array.isArray(status.agents)?status.agents:[];
    const live=agents.find((v):v is Record<string,unknown>=>
      !!v&&typeof v==="object"&&(v as Record<string,unknown>).agent_id===this.config.agentId);
    const online=Array.isArray(live?.instances)?live.instances:[];
    if(!online.includes(this.config.instanceId))
      throw new Error("userio_profile_principal_mismatch");
  }
  async call(action:string,args:Record<string,unknown>={},timeoutMs=135000):Promise<UserIoAgentResult>{
    if(!/^[a-z][a-z0-9_]{0,63}$/u.test(action)
      ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>360000)
      throw new Error("userio_command_invalid");
    await this.verifyPrincipal();
    const ack=await this.request("POST","/v1/agent/commands",{
      agent_id:this.config.agentId,agent_instance_id:this.config.instanceId,action,args});
    const id=ack.id;
    if(ack.queued!==true||typeof id!=="string"||!id.startsWith(this.config.agentId+":"))
      throw new Error("userio_command_rejected");
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      await sleep(450);
      const results=await this.request("GET","/v1/agent/results?agent_id="+
        encodeURIComponent(this.config.agentId)+"&limit=200");
      const matching=Array.isArray(results.results)?results.results.filter(
        (v):v is Record<string,unknown>=>!!v&&typeof v==="object"&&v.id===id):[];
      if(matching.length>1)throw new Error("userio_duplicate_command_result");
      if(matching.length){
        const record=matching[0]!;
        if(record.action!==action||record.agent_id!==this.config.agentId
          ||!record.result||typeof record.result!=="object")
          throw new Error("userio_command_result_mismatch");
        const result=record.result as UserIoAgentResult;
        if(result.ok!==true)throw new Error(
          typeof result.error==="string"&&/^[a-z0-9_]{1,100}$/u.test(result.error)
            ?result.error:"userio_command_failure");
        return result;
      }
    }
    throw new Error("userio_command_outcome_unknown");
  }
}
