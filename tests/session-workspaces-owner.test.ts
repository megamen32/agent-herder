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
