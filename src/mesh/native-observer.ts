import {open} from "node:fs/promises";
import {join} from "node:path";
import {homedir,hostname} from "node:os";
import type {MeshSession} from "./protocol.js";
/** Reads only native metadata and at most 128 KiB of a rollout tail. Never exports text. */
export async function observeCodex(limit=12,codexDir=join(homedir(),".codex"),hostId=hostname(),nativeSessionId?:string):Promise<{sessions:MeshSession[];complete:boolean}>{
 if(!Number.isInteger(limit)||limit<1||limit>12)throw new Error("Codex discovery limit must be 1..12");
 const {DatabaseSync}=await import("node:sqlite");
 const db=new DatabaseSync(join(codexDir,"state_5.sqlite"),{readOnly:true});
 try{
  db.exec("pragma busy_timeout=1000");
  const rows=(nativeSessionId?db.prepare("select id,cwd,title,updated_at,rollout_path from threads where archived=0 and id=? limit 1").all(nativeSessionId):db.prepare("select id,cwd,title,updated_at,rollout_path from threads where archived=0 order by updated_at desc limit ?").all(limit+1)) as Array<{id:string;cwd:string;title:string;updated_at:number;rollout_path:string}>;
  const sessions:MeshSession[]=[];
  for(const row of rows.slice(0,limit)){
   let launchCwd:string|null=row.cwd||null,currentCwd:string|null=null,status="unknown";
   try{
    // rollout_path comes from the native index; do not accept arbitrary caller paths.
    const file=await open(row.rollout_path,"r");
    try{
     const {size}=await file.stat();const head=Buffer.alloc(Math.min(size,8192));await file.read(head,0,head.length,0);
     const first=JSON.parse(head.toString().split("\n")[0]!);if(first.type==="session_meta"&&typeof first.payload?.cwd==="string")launchCwd=first.payload.cwd;
     const offset=Math.max(0,size-128*1024),tail=Buffer.alloc(Math.min(size,128*1024));await file.read(tail,0,tail.length,offset);
     const lines=tail.toString().split("\n");if(offset)lines.shift();
     for(const line of lines){try{
      const item=JSON.parse(line);
      // turn_context is launch/context metadata, not proof of a tool's workdir.
      if(item.type==="event_msg"){
       if(["task_started","turn_started"].includes(item.payload?.type))status="running";
       if(["task_complete","turn_complete","turn_aborted"].includes(item.payload?.type))status="idle";
      }
     }catch{/* partial record */}}
    }finally{await file.close();}
   }catch{/* native metadata remains discoverable; project/status not fabricated */}
   sessions.push({address:{hostId,harness:"codex",nativeSessionId:row.id},project:{launchCwd,currentCwd,source:currentCwd?"native_turn_context":"unverified"},status,title:(row.title||"").slice(0,160),lastActivity:new Date(row.updated_at*1000).toISOString()});
  }
  return {sessions,complete:rows.length<=limit};
 }finally{db.close();}
}
