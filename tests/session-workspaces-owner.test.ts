import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect,it,vi} from "vitest";
import {SessionWorkspaceStore} from "../src/session-workspaces.js";
import {createSessionWorkspaceOwnerUpdater,createMavisWorkspaceEvidenceReader} from "../src/session-workspaces-backfill.js";
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

it("uses native transport proof for A+B and ignores path-only metadata without erasing A",async()=>{
const d=await mkdtemp(join(tmpdir(),"workspace-transport-"));try{
 const store=new SessionWorkspaceStore(join(d,"store.json")),id={runtimeHostId:"mac",harness:"minimax-code",nativeSessionId:"one"};
 await store.declare({...id,mode:"replace",observedAt:"2026-10-23T17:00:00Z",workspaces:[{hostId:"server100",absolutePath:"/repo/a",source:"declared",observedAt:"2026-10-23T17:00:00Z"}]});
 let clock=Date.parse("2026-10-23T18:00:00Z"),phase=0;
 const readEvidence=createMavisWorkspaceEvidenceReader({workHostForSession:async()=>"server100",control:{getMessages:async()=>({ok:true,body:{messages:[{timestamp:Date.parse("2026-10-23T18:01:00Z"),msg_id:"proof",tool_calls:[{tool_name:"bash",tool_call_args:phase?{target:"mcp:shell:server100:Shell",cwd:"/repo/b"}:{cwd:"/Users/user/proj"}}]}]}})}});
 const update=createSessionWorkspaceOwnerUpdater({store,readEvidence,now:()=>clock});await update([{...id,lastActivity:"one"}]);expect((await store.read(id))?.workspaces.map(w=>w.absolutePath)).toEqual(["/repo/a"]);
 phase=1;clock+=61_000;await update([{...id,lastActivity:"two"}]);expect((await store.read(id))?.workspaces.map(w=>w.absolutePath)).toEqual(["/repo/a","/repo/b"]);
}finally{await rm(d,{recursive:true,force:true});}});
it("continues other identities after reader failure and retries unchanged failed identity after cooldown",async()=>{
const d=await mkdtemp(join(tmpdir(),"workspace-retry-"));try{
 const store=new SessionWorkspaceStore(join(d,"store.json"));let clock=Date.parse("2026-10-23T18:00:00Z"),failed=true;
 const a={runtimeHostId:"mac",harness:"minimax-code",nativeSessionId:"a",lastActivity:"same"},b={...a,nativeSessionId:"b"};
 const readEvidence=vi.fn(async(session:typeof a)=>{if(session.nativeSessionId==="a"&&failed){failed=false;throw new Error("native temporarily unavailable");}return [{...session,hostId:"server100",absolutePath:"/repo/"+session.nativeSessionId,observedAt:"2026-10-23T17:00:00Z",evidenceRef:"native-proof",kind:"native_tool_execution" as const}];});
 const update=createSessionWorkspaceOwnerUpdater({store,readEvidence,now:()=>clock});await expect(update([a,b])).resolves.toBeUndefined();expect(await store.read(a)).toBeNull();expect((await store.read(b))?.workspaces[0].absolutePath).toBe("/repo/b");
 await update([a,b]);expect(readEvidence).toHaveBeenCalledTimes(2);clock+=61_000;await update([a,b]);expect(readEvidence).toHaveBeenCalledTimes(3);expect((await store.read(a))?.workspaces[0].absolutePath).toBe("/repo/a");
}finally{await rm(d,{recursive:true,force:true});}});
import {activeWorkspaceIdentity} from '../src/active-session-inventory.js';
import type {AgentSession} from '../src/types/index.js';
it('normalizes native Codex/OpenCode parent fields before inheritance while preserving explicit child overrides',async()=>{
 const d=await mkdtemp(join(tmpdir(),'workspace-parent-fields-'));try{const store=new SessionWorkspaceStore(join(d,'store.json'));const at='2026-10-23T17:00:00Z';const p={runtimeHostId:'owner',harness:'codex',nativeSessionId:'p'};const place={hostId:'code',absolutePath:'/actual',source:'declared'as const,observedAt:at};await store.declare({...p,mode:'replace',observedAt:at,workspaces:[place]});
 const rows=['a','b','empty','own'].map((id,i)=>activeWorkspaceIdentity({id,harness:'codex',lastActivity:at,meta:i===0?{parentThreadId:'p'}:{parentID:'p'}}as AgentSession,'owner'));await store.declare({...rows[2],mode:'replace',observedAt:at,workspaces:[]});await store.declare({...rows[3],mode:'replace',observedAt:at,workspaces:[{...place,absolutePath:'/child'}]});const update=createSessionWorkspaceOwnerUpdater({store,readEvidence:async()=>[]});await update(rows);expect((await store.read(rows[0]))?.workspaces[0].absolutePath).toBe('/actual');expect((await store.read(rows[1]))?.workspaces[0].absolutePath).toBe('/actual');expect((await store.read(rows[2]))?.workspaces).toEqual([]);expect((await store.read(rows[3]))?.workspaces.map(w=>w.absolutePath)).toEqual(['/child']);}finally{await rm(d,{recursive:true,force:true});}
});
