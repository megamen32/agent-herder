import {expect,it,vi} from "vitest";
import {FleetCabinetService} from "../src/mesh/fleet-service.js";
import {registerFleetNodeTools} from "../src/mesh/fleet-node.js";

it("reads an existing MiniMax session through Fleet without granting native creation",async()=>{
 const hostId="mac",readSession=vi.fn(async()=>({hostId,details:{session:{id:"mvs_old",harness:"minimax-code"}}}));
 const transport={discover:async()=>({servers:[{kind:"child_mcp",server_id:"mcp:shell:mac:AgentHerder",status:"online"}]}),schema:async()=>({tools:[{name:"fleet_node_info"},{name:"mesh_snapshot"}]}),call:async(_target:string,tool:string)=>tool==="fleet_node_info"?{hostId,nativeUser:"user",generation:1,createHarnesses:[]}:{hostId,sessions:[],complete:true},readSession};
 const service=new FleetCabinetService({hosts:[{hostId,label:"Mac M1",nativeUser:"user"}],scope:{profileId:"p",userId:"u"},transportFactory:()=>transport});
 expect(await service.readSession({hostId,harness:"minimax-code",nativeSessionId:"mvs_old"})).toMatchObject({hostId,details:{session:{id:"mvs_old"}}});
 expect(readSession).toHaveBeenCalledWith("mcp:shell:mac:AgentHerder","minimax-code","mvs_old");
 await expect(service.requestSession({hostId,harness:"minimax-code",nativeSessionId:"mvs_old"},{operation:"stop",inputId:"visibility-must-not-stop"})).rejects.toThrow("fleet_session_invalid");
 const tools=new Map<string,any>();registerFleetNodeTools({registerTool:(name:string,schema:any,handler:any)=>tools.set(name,{schema,handler})} as any,{adapters:new Map()});
 expect(tools.get("fleet_session_view").schema.inputSchema.safeParse({harness:"minimax-code",sessionId:"mvs_old"}).success).toBe(true);
 expect(tools.get("fleet_create_session").schema.inputSchema.safeParse({inputId:"a".repeat(64),harness:"minimax-code",name:"x",cwd:"/tmp"}).success).toBe(false);
});
