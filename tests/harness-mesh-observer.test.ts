import {describe,expect,it} from "vitest";
import {DatabaseSync} from "node:sqlite";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {observeCodex} from "../src/mesh/native-observer.js";
describe("native metadata observation (focused integration; expected 3s, maximum 30s)",()=>{
 it("reads native IDs and latest observed cwd, bounds result, omits transcript",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"herder-mesh-native-test-"));try{
   const rollout=join(dir,"r.jsonl");await writeFile(rollout,[{type:"session_meta",payload:{cwd:"/launch"}},{type:"turn_context",payload:{cwd:"/actual"}},{type:"event_msg",payload:{type:"task_complete",last_agent_message:"SECRET TRANSCRIPT"}}].map(x=>JSON.stringify(x)).join("\n")+"\n");
   const db=new DatabaseSync(join(dir,"state_5.sqlite"));
   db.exec("create table threads(id text,cwd text,title text,updated_at integer,rollout_path text,archived integer)");
   for(let n=0;n<3;n++)db.prepare("insert into threads values(?,?,?,?,?,0)").run(`native-${n}`,"/index","test",100+n,rollout);db.close();
   const r=await observeCodex(2,dir,"88");expect(r.complete).toBe(false);expect(r.sessions.map(s=>s.address.nativeSessionId)).toEqual(["native-2","native-1"]);
   expect(r.sessions[0]?.project).toEqual({launchCwd:"/launch",currentCwd:null,source:"unverified"});expect(JSON.stringify(r)).not.toContain("SECRET");
  }finally{await rm(dir,{recursive:true,force:true});}
 });
});
