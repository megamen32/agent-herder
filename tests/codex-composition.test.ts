import { expect, it } from "vitest";
import { createCodexAppServerConfig } from "../src/codex-composition.js";
import { CodexAppServerAdapter } from "../src/adapters/codex-app-server.js";
const id="01a1e443-5aa6-73f1-8e27-f5a3448ab78b";
const config={openai_base_url:"http://127.0.0.1:18127/backend-api/codex",features:{enable_request_compression:false}} as const;
it("production composition wires the disabled profile without broadening other threads", async()=>{
 const adapter=new CodexAppServerAdapter(createCodexAppServerConfig({enabled:true,mappings:{[id]:config}})); const i=adapter as any; const calls:any[]=[];
 i.threads.set(id,{id,modelProvider:"openai"}); i.threads.set("other-thread",{id:"other-thread",modelProvider:"openai"}); i.ensureReady=async()=>{}; i.request=async(method:string,params:any)=>{calls.push({method,params});return {thread:{id:params.threadId,modelProvider:"openai"}}};
 expect(await adapter.resumeSession(id)).toMatchObject({ok:false}); expect(calls).toHaveLength(0);
 await adapter.dispose();
});
it("disabled production profile leaves resolver absent",()=>{const c=createCodexAppServerConfig(undefined); expect(c.trustedTransportResolver).toBeUndefined(); expect(c.trustedTransportPreflight).toBeUndefined();});
