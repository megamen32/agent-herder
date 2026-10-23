import {expect,it,vi} from "vitest";
import {registerSessionTools} from "../src/mcp/session-tools.js";
import {HerderEventBus} from "../src/herder-events.js";
import {HerderJobRegistry} from "../src/herder-jobs.js";

it("reads a selected remote MiniMax session instead of returning a local null",async()=>{
 const hostId="MacBook-Pro-User.local",session={id:"mvs_existing",harness:"minimax-code",hostId,status:"idle",title:"agent-herder",cwd:"/Users/user/.minimax",lastActivity:"2026-10-23T00:30:00Z",needsPermission:false,lastMessage:"Остановил поставки"};
 const readSession=vi.fn(async()=>({hostId,details:{session}})),localRead=vi.fn(async()=>null),tools=new Map<string,any>(),events=new HerderEventBus();
 const adapter={type:"minimax-code",getSession:localRead};
 const adapterForSession=vi.fn(async()=>({kind:"ordinary" as "ordinary"|"deny"}));
 registerSessionTools({registerTool:(name:string,schema:any,handler:any)=>tools.set(name,{schema,handler})} as any,{adapters:new Map([["minimax-code",adapter as any]]),jobs:new HerderJobRegistry(events),events,transport:{readSession} as any,integratorRuntime:{adapterForSession} as any});
 const tool=tools.get("agent_info"),args=tool.schema.inputSchema.parse({hostId,harness:"minimax-code",sessionId:"mvs_existing"});
 const result=await tool.handler(args);
 expect(result.structuredContent.session).toMatchObject(session);
 expect(readSession).toHaveBeenCalledWith("mcp:shell:MacBook-Pro-User.local:AgentHerder","minimax-code","mvs_existing");
 expect(localRead).not.toHaveBeenCalled();
 readSession.mockResolvedValueOnce({hostId:"server-44",details:{session}});
 await expect(tool.handler(args)).rejects.toThrow("remote_session_identity_mismatch");
 readSession.mockResolvedValueOnce({hostId,details:{session:{...session,hostId:"server-44"}}});
 await expect(tool.handler(args)).rejects.toThrow("remote_session_identity_mismatch");
 readSession.mockClear();adapterForSession.mockResolvedValueOnce({kind:"deny"});
 await expect(tool.handler(args)).rejects.toThrow("project_session_scope_unavailable");
 expect(readSession).not.toHaveBeenCalled();
 expect(adapterForSession).toHaveBeenLastCalledWith({hostId,harness:"minimax-code",nativeSessionId:"mvs_existing"});
});
