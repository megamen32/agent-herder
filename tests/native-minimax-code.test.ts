import {MinimaxCodeAdapter} from "../src/adapters/minimax-code.js";
import {describe,expect,it} from "vitest";
import {mkdtemp,mkdir,writeFile,rm,utimes} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {observeMinimaxCode} from "../src/mesh/native-minimax-code.js";

const encode=(id:string)=>Buffer.from(id).toString("base64url");

/** One dated session directory of the MiniMax Code local runtime store. */
async function session(root:string,id:string,options:{at?:number;created?:number;record?:Record<string,unknown>;transcript?:string;day?:string}={}){
 const day=join(root,options.day??"2026/10/22");
 await mkdir(day,{recursive:true});
 const dir=join(day,`02-16-26-516-session_${encode(id)}`);
 await mkdir(dir,{recursive:true});
 await writeFile(join(dir,"manifest.json"),JSON.stringify({schemaVersion:1,sessionId:id,createdAtMs:options.created??1000,updatedAtMs:options.at??2000,source:"local-runtime",layout:"v2-final-dated-session"}));
 if(options.record)await writeFile(join(dir,"snapshot.json"),JSON.stringify({schemaVersion:1,sessionId:id,record:options.record,displayMessages:[{role:"user",text:"SECRET TRANSCRIPT"}]}));
 if(options.transcript){await writeFile(join(dir,"messages.jsonl"),options.transcript);await utimes(join(dir,"messages.jsonl"),(options.at??2000)/1000,(options.at??2000)/1000);}
 return dir;
}

describe("native MiniMax Code observation (focused integration; expected 3s, maximum 30s)",()=>{
 it("keeps the newest day visible when the store exceeds the enumeration budget",async()=>{
  const root=await mkdtemp(join(tmpdir(),"herder-minimax-budget-"));try{
   const old=join(root,"2026/10/01");await mkdir(old,{recursive:true});
   for(let n=0;n<4096;n+=64)await Promise.all(Array.from({length:64},(_,i)=>mkdir(join(old,`00-00-00-000-session_${encode("mvs_old_"+(n+i))}`))));
   await session(root,"mvs_latest",{at:Date.UTC(2026,9,23),day:"2026/10/23"});
   const observed=await observeMinimaxCode(1,root,"host");
   expect(observed.sessions[0]?.address.nativeSessionId).toBe("mvs_latest");
   expect(observed.complete).toBe(false);
   const adapter=new MinimaxCodeAdapter({sessionStore:root});
   expect((await adapter.listSessions({limit:1}))[0]?.id).toBe("mvs_latest");
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it("does not hide a new empty session behind the metadata window",async()=>{
  const root=await mkdtemp(join(tmpdir(),"herder-minimax-observer-"));try{
   for(let n=0;n<97;n++)await session(root,`mvs_old_${n}`,{at:1000,day:"2026/10/09",transcript:"PRIVATE"});
   await session(root,"mvs_new_empty",{at:5000,day:"2026/10/23"});
   const observed=await observeMinimaxCode(1,root,"mac");
   expect(observed.sessions[0]?.address.nativeSessionId).toBe("mvs_new_empty");
   expect(observed.complete).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it("ranks an active old session ahead of newer directories without reading its transcript",async()=>{
  const root=await mkdtemp(join(tmpdir(),"herder-minimax-observer-"));try{
   const active=await session(root,"mvs_active",{at:1000,day:"2026/10/09",transcript:"PRIVATE"});
   await utimes(join(active,"messages.jsonl"),5,5);
   await session(root,"mvs_new",{at:3000,day:"2026/10/23"});
   const observed=await observeMinimaxCode(1,root,"mac");
   expect(observed.sessions[0]).toMatchObject({address:{nativeSessionId:"mvs_active"},lastActivity:new Date(5000).toISOString()});
   expect(JSON.stringify(observed)).not.toContain("PRIVATE");
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it("reads native metadata, keeps the store status and exports no transcript",async()=>{
  const root=await mkdtemp(join(tmpdir(),"herder-minimax-observer-"));try{
   await session(root,"mvs_one",{at:5000,created:1000,record:{sessionId:"mvs_one",workspaceDir:"/work/project",title:"Fix the parser",status:"running"},transcript:"{\"message\":{\"role\":\"user\",\"content\":\"SECRET TRANSCRIPT\"}}\n"});
   await session(root,"mvs_two",{at:9000,created:2000});
   const observed=await observeMinimaxCode(12,root,"mac");
   expect(observed.sessions.map(s=>s.address.nativeSessionId)).toEqual(["mvs_two","mvs_one"]);
   expect(observed.sessions[0]).toMatchObject({address:{hostId:"mac",harness:"minimax-code",nativeSessionId:"mvs_two"},status:"unknown",project:{launchCwd:null,currentCwd:null,source:"unverified"}});
   expect(observed.sessions[1]).toMatchObject({status:"running",title:"Fix the parser",project:{launchCwd:"/work/project",currentCwd:"/work/project",source:"native_session_store"},createdAt:new Date(1000).toISOString()});
   expect(JSON.stringify(observed)).not.toContain("SECRET");
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it("keeps a session discoverable when the store states nothing",async()=>{
  const root=await mkdtemp(join(tmpdir(),"herder-minimax-observer-"));try{
   await session(root,"mvs_plain",{at:4000});
   const observed=await observeMinimaxCode(12,root,"mac");
   expect(observed.sessions).toHaveLength(1);
   expect(observed.sessions[0]?.status).toBe("unknown");
   expect(observed.sessions[0]?.project.source).toBe("unverified");
   expect(observed.sessions[0]?.lastActivity).toBe(new Date(4000).toISOString());
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it("bounds the discovery limit and reports the truncation",async()=>{
  const root=await mkdtemp(join(tmpdir(),"herder-minimax-observer-"));try{
   for(let n=0;n<3;n++)await session(root,`mvs_${n}`,{at:1000+n,day:`2026/10/2${n}`});   const observed=await observeMinimaxCode(2,root,"mac");
   expect(observed.sessions).toHaveLength(2);
   expect(observed.complete).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it("publishes one address once, even when the store repeats the session",async()=>{
  const root=await mkdtemp(join(tmpdir(),"herder-minimax-observer-"));try{
   await session(root,"mvs_same",{at:1000});
   await session(root,"mvs_same",{at:2000,day:"2026/10/23"});
   const observed=await observeMinimaxCode(12,root,"mac");
   expect(observed.sessions).toHaveLength(1);
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it("reads one exact native session and refuses a missing store",async()=>{
  const root=await mkdtemp(join(tmpdir(),"herder-minimax-observer-"));try{
   await session(root,"mvs_one",{at:1000});
   await session(root,"mvs_two",{at:2000});
   const exact=await observeMinimaxCode(12,root,"mac","mvs_one");
   expect(exact.sessions.map(s=>s.address.nativeSessionId)).toEqual(["mvs_one"]);
   await expect(observeMinimaxCode(12,join(root,"absent"),"mac")).rejects.toThrow(/session store not found/);
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
