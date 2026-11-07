import {createServer} from "node:http";
import {once} from "node:events";
import {PassThrough} from "node:stream";
import {it,expect} from "vitest";
import {makeConfiguredAdapter,serveOpenCodeAhap} from "../src/ahap-opencode-runner.js";

for (const family of ["v2","v22"] as const) it(`pins ${family} before one fresh Start and uses its real payload`,async()=>{
  const calls: Array<{method:string,path:string,body?:any}>=[]; let sent = false;
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[]; for await(const c of req) chunks.push(Buffer.from(c));
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
    const path=new URL(req.url!,"http://localhost").pathname;
    calls.push({method:req.method!,path,body});
    const json=(status:number,data:unknown)=>{res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(data));};
    if(path==="/api/config") return family==="v2"?json(200,[{path:"/api/session",type:"object"}]):json(404,{});
    if(path==="/api/health") return json(200,{healthy:true});
    if(path==="/global/health") return json(200,null);
    if(req.method==="POST" && path===(family==="v2"?"/api/session":"/session")) return json(200,{id:"ses_test",title:"worker",directory:"/tmp/work",time:{created:1,updated:1}});
    if(req.method==="POST" && path===(family==="v2"?"/api/session/ses_test/prompt":"/session/ses_test/message")) { sent=true; return json(200,family==="v2"?{id:"msg_ABC"}:{ok:true}); }
    if(path.endsWith("/ses_test/message")) return json(200,sent?[{id:"msg_ABC",info:{id:"msg_ABC",role:"user"},parts:[{type:"text",text:"hello"}]}]:[]);
    return json(405,{});
  });
  server.listen(0,"127.0.0.1");await once(server,"listening"); const address=server.address(); if(!address || typeof address==="string")throw Error();
  try{
    const selected=await makeConfiguredAdapter(`http://127.0.0.1:${address.port}`);
    expect(selected.family).toBe(family); const adapter=selected.adapter;
    const input=new PassThrough(),output=new PassThrough(),chunks:string[]=[];output.setEncoding("utf8");output.on("data",(c:string)=>chunks.push(c));
    const done=serveOpenCodeAhap(adapter,input,output, selected.family);
    const requests=[{jsonrpc:"2.0",id:1,method:"initialize",params:{harness:"opencode",ahapVersion:"0.1"}},{jsonrpc:"2.0",id:2,method:"createSession",params:{options:{name:"worker",cwd:"/tmp/work"}}},{jsonrpc:"2.0",id:3,method:"sendMessage",params:{id:"ses_test",options:{message:"hello",queue:false,start:true,activeTurnOnly:true,inputId:"key"}}},{jsonrpc:"2.0",id:4,method:"shutdown"}];
    input.end(requests.map(x=>JSON.stringify(x)).join("\n")+"\n");await done;
    const response=chunks.join("").trim().split("\n").map(x=>JSON.parse(x));
    expect(response[0].result.capabilities.nativeProtocol).toBe(family);
    expect(response[1].result.id).toBe("ses_test");
    const create=calls.find(c=>c.method==="POST" && c.path.endsWith("/session")); expect(create?.path).toBe(family==="v2"?"/api/session":"/session");
    const send=calls.filter(c=>c.method==="POST").at(-1)!;
    expect(send.path).toBe(family==="v2"?"/api/session/ses_test/prompt":"/session/ses_test/message");
    expect(send.body).toEqual(family==="v2"?{text:"hello",delivery:"queue",metadata:{agentHerderInputId:"key"}}:{parts:[{type:"text",text:"hello"}]});
    expect(response[2].result).toMatchObject({admitted:true,nativeInputMessageId:"msg_ABC"});
  } finally {server.close();}
});

it("rejects an unrecognized probe without sending a mutation", async()=>{
  const methods:string[]=[];const server=createServer((req,res)=>{methods.push(req.method!);res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify("unexpected"));});
  server.listen(0,"127.0.0.1");await once(server,"listening");const addr=server.address();if(!addr||typeof addr==="string")throw Error();
  try {await expect(makeConfiguredAdapter(`http://127.0.0.1:${addr.port}`)).rejects.toThrow("unrecognized OpenCode API config");expect(methods).toEqual(["GET"]);} finally {server.close();}
});

it("does not switch families or replay after a v2 create 405",async()=>{
 const calls:string[]=[]; const server=createServer((req,res)=>{calls.push(`${req.method} ${req.url}`);if(req.method==="GET"&&req.url==="/api/config"){res.writeHead(200,{"content-type":"application/json"});res.end('[{"path":"/api/session","type":"object"}]');}else{res.writeHead(405);res.end();}});
 server.listen(0,"127.0.0.1");await once(server,"listening");const addr=server.address();if(!addr||typeof addr==="string")throw Error();
 try {const selected=await makeConfiguredAdapter(`http://127.0.0.1:${addr.port}`);const input=new PassThrough(),output=new PassThrough(),chunks:string[]=[];output.setEncoding("utf8");output.on("data",(c:string)=>chunks.push(c));const done=serveOpenCodeAhap(selected.adapter,input,output,selected.family);input.end([{jsonrpc:"2.0",id:1,method:"initialize",params:{harness:"opencode",ahapVersion:"0.1"}},{jsonrpc:"2.0",id:2,method:"createSession",params:{options:{name:"worker",cwd:"/tmp/work"}}},{jsonrpc:"2.0",id:3,method:"shutdown"}].map(x=>JSON.stringify(x)).join("\n")+"\n");await done;expect(chunks.join("")).toContain('"outcome":"unknown"');expect(calls.filter(x=>x.startsWith("POST "))).toEqual(["POST /api/session"]);}finally{server.close();}
});

it("accepts literal JSON null but rejects malformed HTTP 200 before mutations",async()=>{
 let body="null";const calls:string[]=[];const server=createServer((req,res)=>{calls.push(`${req.method} ${req.url}`);res.writeHead(200,{"content-type":"application/json"});res.end(body);});
 server.listen(0,"127.0.0.1");await once(server,"listening");const addr=server.address();if(!addr||typeof addr==="string")throw Error();
 const url=`http://127.0.0.1:${addr.port}`;
 try {expect((await makeConfiguredAdapter(url)).family).toBe("v22");body="<html>not JSON</html>";await expect(makeConfiguredAdapter(url)).rejects.toThrow("invalid OpenCode API config JSON");expect(calls).toEqual(["GET /api/config","GET /api/config"]);}finally{server.close();}
});

it("requires JSON object health before accepting a 404 as v22",async()=>{
 let health:unknown=null;const calls:string[]=[];const server=createServer((req,res)=>{calls.push(`${req.method} ${req.url}`);res.writeHead(req.url==="/api/config"?404:200,{"content-type":"application/json"});res.end(JSON.stringify(req.url==="/api/config"?{}:health));});
 server.listen(0,"127.0.0.1");await once(server,"listening");const addr=server.address();if(!addr||typeof addr==="string")throw Error();const url=`http://127.0.0.1:${addr.port}`;
 try{await expect(makeConfiguredAdapter(url)).rejects.toThrow("unverified OpenCode v22 health");health={healthy:true};expect((await makeConfiguredAdapter(url)).family).toBe("v22");expect(calls.every(x=>x.startsWith("GET "))).toBe(true);}finally{server.close();}
});
