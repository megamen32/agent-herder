import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectReleaseLeaseStore, terminalReleaseAt } from "../src/project-release-lease.js";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, {recursive:true,force:true}))); });
const owner = { hostId: "host", harness: "test", nativeSessionId: "session-a" };
async function setup() {
 const dir=await mkdtemp(join(tmpdir(),"release-lease-")); dirs.push(dir); let now=1000;
 const store=new ProjectReleaseLeaseStore(join(dir,"leases.json"),()=>now);
 return {store, advance:(ms:number)=>now+=ms};
}
function proof(result:any, who=owner) { return {owner:who, token:result.token, fence:result.lease.fence}; }
describe("project release lease",()=>{
 it("excludes parallel sessions and exposes message target without capability",async()=>{
  const {store}=await setup(); const a=await store.acquire("repo",owner);
  const b=await store.acquire("repo",{...owner,nativeSessionId:"b"}); expect(b.acquired).toBe(false);
  const status=await store.status("repo"); expect(status.contact?.sessionId).toBe("session-a");
  expect(status.remainingSeconds).toBe(300); expect(JSON.stringify(status)).not.toContain((a as any).token);
  expect(await readFile(store.file,"utf8")).not.toContain((a as any).token);
 });
 it("is atomic across independent MCP processes using same authority file",async()=>{
  const {store}=await setup(); const other=new ProjectReleaseLeaseStore(store.file,store.now);
  const values=await Promise.all([store.acquire("p",owner),other.acquire("p",{...owner,nativeSessionId:"b"})]);
  expect(values.filter(v=>v.acquired)).toHaveLength(1);
 });
 it("isolates projects and does not release foreign owners",async()=>{
  const {store}=await setup(); const a=await store.acquire("a",owner),b=await store.acquire("b",{...owner,nativeSessionId:"b"});
  await expect(store.release("a",proof(a,{...owner,nativeSessionId:"b"}))).rejects.toThrow();
  await expect(store.release("a",proof(b))).rejects.toThrow(); expect((await store.status("a")).lease).not.toBeNull();
 });
 it("renews only live matching capability and fence",async()=>{
  const {store,advance}=await setup(); const a=await store.acquire("p",owner,30);advance(10000);
  await store.renew("p",proof(a),60);expect((await store.status("p")).remainingSeconds).toBe(60);
  await expect(store.renew("p",{...proof(a),token:"bad"})).rejects.toThrow();
 });
 it("crash without hook expires and stale holder cannot deploy, renew or release successor",async()=>{
  const {store,advance}=await setup();const a=await store.acquire("p",owner,30);advance(30001);
  const b=await store.acquire("p",{...owner,nativeSessionId:"b"});expect(b.lease.fence).toBe(2);
  for(const method of ["check","renew","release"] as const) await expect(store[method]("p",proof(a))).rejects.toThrow();
  expect((await store.status("p")).lease?.owner.nativeSessionId).toBe("b");
 });
 it.each(["normal end","abort","error","confirmed stop"])("terminal lifecycle %s releases all owned projects only",async()=>{
  const {store}=await setup();await store.acquire("a",owner);await store.acquire("b",owner);await store.acquire("c",{...owner,nativeSessionId:"other"});
  expect(await store.endSession(owner,1000)).toEqual({released:2});expect((await store.status("a")).lease).toBeNull();
  expect((await store.status("c")).lease).not.toBeNull();
 });
 it("late terminal event cannot release a newer lease for same session",async()=>{
  const {store,advance}=await setup();advance(100);await store.acquire("p",owner);
  expect(await store.endSession(owner,1000)).toEqual({released:0});
 });
 it("release/reacquire fence is durable and monotonic",async()=>{
  const {store}=await setup();const a=await store.acquire("p",owner);await store.release("p",proof(a));
  const other=new ProjectReleaseLeaseStore(store.file,store.now);const b=await other.acquire("p",owner);
  expect(b.lease.fence).toBe(2);await expect(other.check("p",proof(a))).rejects.toThrow();
 });
 it("rejects unreasonable TTL rather than permanent reservations",async()=>{
  const {store}=await setup();await expect(store.acquire("p",owner,0)).rejects.toThrow();await expect(store.acquire("p",owner,1801)).rejects.toThrow();
 });
});

it("terminal event timestamp validation never substitutes delivery time",()=>{
 expect(terminalReleaseAt(undefined,2000)).toBeNull();
 expect(terminalReleaseAt("bad",2000)).toBeNull();
 expect(terminalReleaseAt("1970-01-01T00:00:03Z",2000)).toBeNull();
 expect(terminalReleaseAt("1970-01-01T00:00:01Z",2000)).toBe(1000);
});
it("acquisition binds exact deployment target into durable lease",async()=>{
 const {store}=await setup();
 const target={fleetDir:"/release/project",unit:"agent.service"};
 await store.acquire("p",owner,300,target);
 expect((await store.status("p")).lease?.deploymentTarget).toEqual(target);
});

async function holdDeployment(store: ProjectReleaseLeaseStore, unit: string) {
 const path=join(dirname(store.file),"deploy-unit-"+createHash("sha256").update(unit).digest("hex")+".lock");
 const child=spawn("python3",["-u","-c","import os,fcntl,sys; fd=os.open(sys.argv[1],os.O_CREAT|os.O_RDWR,0o600); fcntl.flock(fd,fcntl.LOCK_EX); print('ready'); sys.stdin.read()",path],{stdio:["pipe","pipe","pipe"]});
 await new Promise<void>((resolve,reject)=>{child.stdout.once("data",()=>resolve());child.once("error",reject);child.once("exit",code=>{if(code)reject(new Error("lock holder failed"));});});
 return async()=>{child.stdin.end();await new Promise<void>(resolve=>child.once("exit",()=>resolve()));};
}
it.each(["release","end","expire"])("in-flight %s retains cleanup fence and blocks takeover until OS lock closes",async(reason)=>{
 const {store,advance}=await setup();
 const target={fleetDir:"/fleet",unit:"test.service"};
 const a=await store.acquire("p",owner,30,target);
 const unlock=await holdDeployment(store,target.unit);
 try {
  if(reason==="release") await store.release("p",proof(a));
  if(reason==="end") await store.endSession(owner,1000);
  if(reason==="expire") advance(30001);
  expect((await store.acquire("p",{...owner,nativeSessionId:"next"},30,target)).acquired).toBe(false);
  await expect(store.acquire("other",owner,30,target)).rejects.toThrow("release_target_deployment_in_progress");
  const status=await store.status("p");
  expect(status.deploymentInProgress).toBe(true);expect(status.lease?.fence).toBe(1);expect(status.remainingSeconds).toBe(0);
  await expect(store.renew("p",proof(a))).rejects.toThrow();
  expect((await store.acquire("isolated",owner,30,{fleetDir:"/else",unit:"other.service"})).acquired).toBe(true);
 } finally {await unlock();}
 expect((await store.acquire("p",owner,30,target)).lease.fence).toBe(2);
});
