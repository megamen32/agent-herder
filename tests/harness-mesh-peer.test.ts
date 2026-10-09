import {Client,InMemoryTransport} from "@modelcontextprotocol/client";
import {afterAll,describe,expect,it,vi} from "vitest";
const fixture=vi.hoisted(()=>({factory:undefined as undefined|(()=>unknown)}));
const endListeners=new Set(process.stdin.rawListeners("end")),termListeners=new Set(process.rawListeners("SIGTERM"));
vi.mock("@modelcontextprotocol/server/stdio",()=>({serveStdio:vi.fn(async(factory:()=>unknown)=>{fixture.factory=factory;})}));
vi.mock("../src/mesh/native-observer.js",()=>({observeCodex:vi.fn(async()=>({sessions:[],complete:false}))}));
describe("native leaf snapshot (focused integration; expected 2s, maximum 15s)",()=>{
 it("returns short capability reasons through the actual MCP envelope without repeated repair plans",async()=>{
  await import("../src/mesh/native-peer.js");const server=fixture.factory!() as any;
  const client=new Client({name:"mesh-compact-regression",version:"1"});const [ct,st]=InMemoryTransport.createLinkedPair();
  try{await server.connect(st);await client.connect(ct);const result=await client.callTool({name:"mesh_snapshot",arguments:{limit:1}});
   const content=result.content as Array<{type:string;text:string}>;const snapshot=JSON.parse(content[0]!.text);
   expect(snapshot.harnesses).toHaveLength(9);expect(snapshot.complete).toBe(false);expect(content[0]!.text).not.toContain("repairPlan");
   expect(snapshot.harnesses.find((h:any)=>h.harness==="opencode").reason).toBe("native_transport_not_registered");
  }finally{await client.close();await server.close();}
 });
});
afterAll(()=>{
 for(const listener of process.stdin.rawListeners("end"))if(!endListeners.has(listener))process.stdin.removeListener("end",listener);
 for(const listener of process.rawListeners("SIGTERM"))if(!termListeners.has(listener))process.removeListener("SIGTERM",listener);
});
