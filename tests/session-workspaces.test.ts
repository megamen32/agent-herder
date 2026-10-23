import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionWorkspaceStore, sessionWorkspaceKey } from "../src/session-workspaces.js";
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
const id={runtimeHostId:"mac-m1",harness:"codex",nativeSessionId:"native-1"};
const at="2026-10-23T17:00:00.000Z", later="2026-10-23T17:01:00.000Z";
const place=(absolutePath:string,hostId="server-100",observedAt=at)=>({hostId,absolutePath,source:"declared" as const,observedAt});
async function store(){const d=await mkdtemp(join(tmpdir(),"session-workspaces-"));dirs.push(d);return new SessionWorkspaceStore(join(d,"places.json"));}
describe("actual code workspace ledger",()=>{
 it("keeps multiple projects and work hosts across restart without guessing runtime paths",async()=>{const s=await store();expect(await s.read(id)).toBeNull(); await s.declare({...id,mode:"replace",observedAt:at,workspaces:[place("/repo/tgc"),place("/repo/lhc"),place("/Users/user/project","mac-m1")]});const records=await new SessionWorkspaceStore(s.filePath).readMany([id]);expect(records.get(sessionWorkspaceKey(id))?.workspaces).toHaveLength(3);});
 it("isolates identical native IDs across runtime hosts and harnesses",async()=>{const s=await store();await s.declare({...id,mode:"replace",observedAt:at,workspaces:[place("/repo/a")]});expect(await s.read({...id,runtimeHostId:"server-100"})).toBeNull();expect(await s.read({...id,harness:"zcode"})).toBeNull();});
 it("merges observations, rejects stale updates and CAS conflicts, explicitly clears unknown",async()=>{const s=await store();await s.declare({...id,mode:"replace",observedAt:at,workspaces:[place("/repo/a")]});const r=await s.declare({...id,mode:"union",observedAt:later,workspaces:[place("/repo/b")]});expect(r.workspaces).toHaveLength(2);await expect(s.declare({...id,mode:"replace",observedAt:at,workspaces:[]})).rejects.toThrow(/Stale/);await expect(s.declare({...id,mode:"replace",observedAt:"2026-10-23T17:02:00Z",expectedVersion:1,workspaces:[]})).rejects.toThrow(/version/);expect((await s.declare({...id,mode:"replace",observedAt:"2026-10-23T17:02:00Z",expectedVersion:2,workspaces:[]})).workspaces).toEqual([]);});
 it("requires explicit work host and absolute path, never defaults to Mac GUI host",async()=>{const s=await store();await expect(s.declare({...id,mode:"replace",observedAt:at,workspaces:[place("/repo","")]})).rejects.toThrow(/hostId/);await expect(s.declare({...id,mode:"replace",observedAt:at,workspaces:[place("~/minimax")]})).rejects.toThrow(/absolute/);});
 it("refreshes an already-loaded index after another process declares",async()=>{const a=await store(),b=new SessionWorkspaceStore(a.filePath);expect(await a.read(id)).toBeNull();await b.declare({...id,mode:"replace",observedAt:at,workspaces:[place("/repo/a")]});expect((await a.read(id))?.workspaces[0].absolutePath).toBe("/repo/a");});
 it("does not lose other session records when independent processes write",async()=>{const a=await store(), b=new SessionWorkspaceStore(a.filePath);await Promise.all([a.declare({...id,mode:"replace",observedAt:at,workspaces:[place("/repo/a")]}),b.declare({...id,nativeSessionId:"native-2",mode:"replace",observedAt:at,workspaces:[place("/repo/b")]})]);expect((await new SessionWorkspaceStore(a.filePath).readMany([id,{...id,nativeSessionId:"native-2"}])).size).toBe(2);});
});
