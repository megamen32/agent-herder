import {Client,InMemoryTransport} from "@modelcontextprotocol/client";
import {afterAll,describe,expect,it,vi} from "vitest";
const fixture=vi.hoisted(()=>({factory:undefined as undefined|(()=>unknown),codex:undefined as undefined|(()=>Promise<any>),minimax:undefined as undefined|(()=>Promise<any>)}));
const endListeners=new Set(process.stdin.rawListeners("end")),termListeners=new Set(process.rawListeners("SIGTERM"));
vi.mock("@modelcontextprotocol/server/stdio",()=>({serveStdio:vi.fn(async(factory:()=>unknown)=>{fixture.factory=factory;})}));
vi.mock("../src/mesh/native-observer.js",()=>({observeCodex:vi.fn((...args:any[])=>fixture.codex!(...args))}));
vi.mock("../src/mesh/native-minimax-code.js",()=>({MINIMAX_CODE_HARNESS:"minimax-code",deliverMinimaxCode:vi.fn(),observeMinimaxCode:vi.fn((...args:any[])=>fixture.minimax!(...args))}));
const session=(hostId:string,harness:string,nativeSessionId:string,lastActivity:string)=>({address:{hostId,harness,nativeSessionId},project:{launchCwd:null,currentCwd:null,source:"unverified"},status:"unknown",title:"t",lastActivity});
let server:any;
async function call(limit:number){
 const client=new Client({name:"mesh-peer-minimax",version:"1"});const [ct,st]=InMemoryTransport.createLinkedPair();
 await server.connect(st);await client.connect(ct);
 try{
  const content=(await client.callTool({name:"mesh_snapshot",arguments:{limit}})).content as Array<{text:string}>;
  return JSON.parse(content[0]!.text);
 }finally{await client.close();}
}
describe("native peer publishes both platforms (focused integration; expected 3s, maximum 30s)",()=>{
 it("merges both sources by address, shares one limit budget and reports a partial source",async()=>{
  fixture.codex=async()=>({sessions:[session("host","codex","c1","2026-10-22T02:00:00.000Z")],complete:true});
  fixture.minimax=async()=>({sessions:[session("host","minimax-code","m1","2026-10-22T03:00:00.000Z")],complete:true});
  await import("../src/mesh/native-peer.js");server=fixture.factory!();
  const snapshot=await call(12);
  expect(snapshot.sessions.map((s:any)=>s.address.harness).sort()).toEqual(["codex","minimax-code"]);
  expect(snapshot.harnesses.find((h:any)=>h.harness==="minimax-code").discovery).toBe("available");
  expect(snapshot.complete).toBe(true);
  // One budget for both platforms, not one per source.
  expect((await call(1)).sessions).toHaveLength(1);
 });
 it("keeps the second platform when the first one is unavailable",async()=>{
  fixture.codex=async()=>{throw new Error("codex store is gone");};
  fixture.minimax=async()=>({sessions:[session("host","minimax-code","m1","2026-10-22T03:00:00.000Z")],complete:true});
  const snapshot=await call(12);
  expect(snapshot.sessions.map((s:any)=>s.address.harness)).toEqual(["minimax-code"]);
  expect(snapshot.complete).toBe(false);
  expect(snapshot.harnesses.find((h:any)=>h.harness==="codex").discovery).toBe("unavailable");
  expect(snapshot.harnesses.find((h:any)=>h.harness==="minimax-code").discovery).toBe("available");
 });
 it("publishes one address once when both sources report it",async()=>{
  fixture.codex=async()=>({sessions:[session("host","codex","c1","2026-10-22T02:00:00.000Z")],complete:true});
  fixture.minimax=async()=>({sessions:[session("host","codex","c1","2026-10-22T04:00:00.000Z")],complete:true});
  const snapshot=await call(12);
  expect(snapshot.sessions).toHaveLength(1);
 });
});
afterAll(async()=>{
 if(server)await server.close();
 for(const listener of process.stdin.rawListeners("end"))if(!endListeners.has(listener))process.stdin.removeListener("end",listener);
 for(const listener of process.rawListeners("SIGTERM"))if(!termListeners.has(listener))process.removeListener("SIGTERM",listener);
});
