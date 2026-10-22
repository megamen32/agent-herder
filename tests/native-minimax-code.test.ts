import {describe,expect,it} from "vitest";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
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
 if(options.transcript)await writeFile(join(dir,"messages.jsonl"),options.transcript);
 return dir;
}

describe("native MiniMax Code observation (focused integration; expected 3s, maximum 30s)",()=>{
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
