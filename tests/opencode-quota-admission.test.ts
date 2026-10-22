import { createServer } from "node:http";
import { expect,it } from "vitest";
import { OpenCodeClient } from "../packages/agent-resume/src/harness/opencode/client.js";
import { normalizeSendAdmission } from "../src/adapters/quota-failure.js";
it("preserves explicit native pre-admission quota proof but never invents it from HTTP429",async()=>{
 let body:unknown={notSubmitted:true,error:{code:"quota_exhausted",message:"Weekly quota exhausted"}};
 const server=createServer((req,res)=>{res.setHeader("content-type","application/json");if(req.method==="POST"){res.statusCode=429;res.end(JSON.stringify({data:body}));}else res.end(JSON.stringify({data:[]}));});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address() as {port:number};
 const client=new OpenCodeClient({baseUrl:`http://127.0.0.1:${address.port}`,protocol:"v2"});
 const adapter={sendMessage:async(id:string,_options:unknown)=>normalizeSendAdmission(await client.send(id,{message:"fixture",delivery:"queue"}))};
 try{
  expect(await adapter.sendMessage("fixture",{message:"fixture",queue:true})).toMatchObject({admission:"not_submitted",quotaFailure:{classification:"quota_exhausted"}});
  body={error:{code:"quota_exhausted",message:"Weekly quota exhausted"}};
  const unknown=await adapter.sendMessage("fixture",{message:"fixture",queue:true});expect(unknown.admission).toBe("unknown");expect(unknown.quotaFailure).toBeUndefined();
  body={notSubmitted:true,admitted:true,nativeInputMessageId:"msg_native",error:{code:"quota_exhausted"}};
  const accepted=await adapter.sendMessage("fixture",{message:"fixture",queue:true});expect(accepted.admission).toBe("accepted");expect(accepted.notSubmitted).not.toBe(true);expect(accepted.quotaFailure).toBeUndefined();
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
