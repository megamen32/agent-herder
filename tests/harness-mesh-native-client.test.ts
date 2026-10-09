import {describe,expect,it,vi} from "vitest";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import {WebSocketServer} from "ws";
import {NativeCodexClient} from "../src/mesh/native-codex.js";
async function fixture(run:(client:NativeCodexClient,wss:WebSocketServer,calls:string[])=>Promise<void>,behavior?:(r:any,socket:any)=>boolean){
 const dir=await mkdtemp(join(tmpdir(),"herder-mesh-ws-")),path=join(dir,"native.sock"),server=createServer(),wss=new WebSocketServer({server}),calls:string[]=[];
 wss.on("connection",socket=>socket.on("message",data=>{const r=JSON.parse(data.toString());calls.push(r.method);if(behavior?.(r,socket))return;if(r.id){if(r.method==="turn/steer")socket.close();else socket.send(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{ok:true}}));}}));
 await new Promise<void>(resolve=>server.listen(path,resolve));const client=new NativeCodexClient(path,1000);
 try{await run(client,wss,calls);}finally{vi.useRealTimers();client.close();for(const c of wss.clients)c.close();await new Promise<void>(resolve=>wss.close(()=>server.close(()=>resolve())));await rm(dir,{recursive:true,force:true});}
}
describe("existing native socket lifecycle (focused integration; expected 5s, maximum 30s)",()=>{
 it("a second connect after WS open waits for the held initialize response",async()=>{
  let release!:()=>void,opened!:()=>void;const waiting=new Promise<void>(resolve=>opened=resolve);
  await fixture(async(client,_wss,calls)=>{
   const first=client.connect();await waiting;let secondDone=false;const second=client.connect().then(()=>secondDone=true);
   await new Promise<void>(resolve=>setImmediate(resolve));expect(secondDone).toBe(false);expect(calls.filter(x=>x==="initialize")).toHaveLength(1);
   release();await Promise.all([first,second]);expect(secondDone).toBe(true);
  },(r,socket)=>{if(r.method!=="initialize")return false;release=()=>socket.send(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{ok:true}}));opened();return true;});
 });
 it("a failed initialize resets only the connection and performs a fresh metadata handshake",async()=>{
  let rejected=false;
  await fixture(async(client,_wss,calls)=>{
   await expect(client.connect()).rejects.toThrow("init rejected");await client.connect();await client.request("thread/read",{threadId:"n",includeTurns:false});
   expect(calls.filter(x=>x==="initialize")).toHaveLength(2);
  },(r,socket)=>{if(r.method==="initialize"&&!rejected){rejected=true;socket.send(JSON.stringify({jsonrpc:"2.0",id:r.id,error:{code:-32600,message:"init rejected"}}));return true;}return false;});
 });
 it("single-flights initialization and never kills the writer after 180 seconds",async()=>fixture(async(client,wss,calls)=>{
  await Promise.all([client.connect(),client.connect()]);expect(calls.filter(x=>x==="initialize")).toHaveLength(1);
  vi.useFakeTimers();await vi.advanceTimersByTimeAsync(180001);expect(wss.clients.size).toBe(1);vi.useRealTimers();
  expect(await client.request("thread/read",{threadId:"n",includeTurns:false})).toEqual({ok:true});
 }));
 it("resets disconnected identity and reconnects metadata without replaying mutation",async()=>fixture(async(client,_wss,calls)=>{
  await client.connect();await expect(client.request("turn/steer",{threadId:"n",expectedTurnId:"t"})).rejects.toThrow();
  await Promise.all([client.connect(),client.connect()]);await client.request("thread/read",{threadId:"n",includeTurns:false});
  expect(calls.filter(x=>x==="initialize")).toHaveLength(2);expect(calls.filter(x=>x==="turn/steer")).toHaveLength(1);
 }));
 it("fails closed without a documented shared socket",async()=>{await expect(new NativeCodexClient(undefined).connect()).rejects.toThrow("native_shared_transport_unavailable");});
});
