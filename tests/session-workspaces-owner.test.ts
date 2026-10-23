import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it,vi} from "vitest";
import {SessionWorkspaceStore} from "../src/session-workspaces.js";
import {createSessionWorkspaceOwnerUpdater} from "../src/session-workspaces-backfill.js";
it("ingests native evidence once and inherits only explicit same-runtime parent relationships",async()=>{
const d=await mkdtemp(join(tmpdir(),"workspace-owner-"));try{
 const store=new SessionWorkspaceStore(join(d,"store.json"));const id={runtimeHostId:"mac-m1",harness:"minimax-code",nativeSessionId:"parent"};
 await store.declare({...id,mode:"replace",observedAt:"2026-10-23T17:00:00Z",workspaces:[{hostId:"server100",absolutePath:"/repo/a",source:"observed",observedAt:"2026-10-23T17:00:00Z",evidence:"native-tool:1"}]});
 const readEvidence=vi.fn(async()=>[]);const update=createSessionWorkspaceOwnerUpdater({store,readEvidence,now:()=>Date.parse("2026-10-23T18:00:00Z")});const child={...id,nativeSessionId:"child",parentSessionId:"parent",lastActivity:"2026-10-23T17:59:00Z"};
 await update([child]);await update([child]);expect(readEvidence).toHaveBeenCalledTimes(1);expect((await store.read(child))?.workspaces[0]).toMatchObject({hostId:"server100",absolutePath:"/repo/a",evidence:"parent_declaration:parent:v1:native-tool:1"});
 expect(await store.read({...child,runtimeHostId:"another-mac"})).toBeNull();
}finally{await rm(d,{recursive:true,force:true});}});
it("ingests another work area when an already-known native session changes",async()=>{
const d=await mkdtemp(join(tmpdir(),"workspace-owner-update-"));try{
 const store=new SessionWorkspaceStore(join(d,"store.json")),id={runtimeHostId:"mac",harness:"minimax-code",nativeSessionId:"one"};
 await store.declare({...id,mode:"replace",observedAt:"2026-10-23T17:00:00Z",workspaces:[{hostId:"server100",absolutePath:"/repo/a",source:"declared",observedAt:"2026-10-23T17:00:00Z"}]});
 let clock=Date.parse("2026-10-23T18:00:00Z"),phase=0;
 const readEvidence=vi.fn(async()=>phase?[{...id,hostId:"server100",absolutePath:"/repo/b",observedAt:"2026-10-23T18:01:00Z",evidenceRef:"native-msg-b",kind:"native_tool_execution" as const}]:[]);
 const update=createSessionWorkspaceOwnerUpdater({store,readEvidence,now:()=>clock});await update([{...id,lastActivity:"first"}]);phase=1;clock+=61_000;await update([{...id,lastActivity:"second"}]);
 expect((await store.read(id))?.workspaces.map(w=>w.absolutePath)).toEqual(["/repo/a","/repo/b"]);expect(readEvidence).toHaveBeenCalledTimes(2);
}finally{await rm(d,{recursive:true,force:true});}});
it("refreshes inherited work areas when an exact parent declaration changes",async()=>{
const d=await mkdtemp(join(tmpdir(),"workspace-owner-parent-"));try{
 const store=new SessionWorkspaceStore(join(d,"store.json")),id={runtimeHostId:"mac",harness:"minimax-code",nativeSessionId:"parent"};let clock=Date.parse("2026-10-23T18:00:00Z");
 await store.declare({...id,mode:"replace",observedAt:"2026-10-23T17:00:00Z",workspaces:[{hostId:"server100",absolutePath:"/repo/a",source:"declared",observedAt:"2026-10-23T17:00:00Z"}]});
 const child={...id,nativeSessionId:"child",parentSessionId:"parent",lastActivity:"one"};const update=createSessionWorkspaceOwnerUpdater({store,readEvidence:async()=>[],now:()=>clock});await update([child]);
 await store.declare({...id,mode:"replace",observedAt:"2026-10-23T18:01:00Z",expectedVersion:1,workspaces:[{hostId:"server100",absolutePath:"/repo/b",source:"declared",observedAt:"2026-10-23T18:01:00Z"}]});clock+=120_000;await update([{...child,lastActivity:"two"}]);
 expect((await store.read(child))?.workspaces.map(w=>w.absolutePath)).toEqual(["/repo/b"]);
}finally{await rm(d,{recursive:true,force:true});}});
