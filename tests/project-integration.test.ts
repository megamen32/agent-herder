import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordProjectLifecycle, integrationProject, resumePendingProjectIntegrations } from "../src/project-integration.js";
import { ProjectReleaseLeaseStore } from "../src/project-release-lease.js";
const dirs:string[]=[];
afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function setup(){
 const dir=await mkdtemp(join(tmpdir(),"integration-hook-"));dirs.push(dir);
 const repo=join(dir,"repo");
 execFileSync("git",["init","-b","main",repo],{stdio:"ignore"});
 execFileSync("git",["-C",repo,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","--allow-empty","-m","init"],{stdio:"ignore"});
 return {repo,store:new ProjectReleaseLeaseStore(join(dir,"leases.json")),project:(await integrationProject(repo)).project};
}
it("uses one durable existing resume_after request and duplicate terminal reports do not wake twice",async()=>{
 const {repo,store,project}=await setup();const wake=vi.fn(async()=>({id:"wait_fixture"} as any));
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"start"},wake,store);
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"turn-end"},wake,store);
 expect(wake).not.toHaveBeenCalled();
 const at=new Date(Date.now()+1).toISOString();
 // Real endpoint rejects future timestamps, wait until observed timestamp is current.
 await new Promise(r=>setTimeout(r,3));
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"end",at},wake,store);
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"end",at},wake,store);
 expect(wake).toHaveBeenCalledTimes(1);
 expect(wake.mock.calls[0]?.[0]).toMatchObject({requestId:expect.stringMatching(/^integration_/),trigger:{kind:"delay",delayMs:1000}});
 expect((await store.integrationStatus(project)).integration?.wakeId).toBe("wait_fixture");
});
it("failed registration keeps recoverable pending responsibility with stable request identity",async()=>{
 const {repo,store,project}=await setup();const wake=vi.fn(async(_input:any)=>{throw new Error("unavailable");});
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"start"},wake,store);
 const at=new Date().toISOString();
 await expect(recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"end",at},wake,store)).rejects.toThrow("unavailable");
 const item=(await store.integrationStatus(project)).integration!;
 expect(item.state).toBe("pending");
 const retry=vi.fn(async(_input:any)=>({id:"wait_recovered"} as any));
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"end",at},retry,new ProjectReleaseLeaseStore(store.file));
 expect(retry.mock.calls[0][0].requestId).toBe(item.id);
});
it("missing terminal timestamp never invents last-worker proof",async()=>{
 const {repo,store}=await setup();const wake=vi.fn();
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"start"},wake,store);
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"end"},wake,store);
 expect(wake).not.toHaveBeenCalled();
});

it("new worker invalidates consumed wake and creates one fresh bounded continuation after ending",async()=>{
 const {repo,store,project}=await setup();const wake=vi.fn(async(_input:any)=>({id:"wait_"+wake.mock.calls.length} as any));
 await recordProjectLifecycle({harness:"test",sessionId:"a",cwd:repo,event:"start"},wake,store);
 await recordProjectLifecycle({harness:"test",sessionId:"a",cwd:repo,event:"end",at:new Date().toISOString()},wake,store);
 const before=(await store.integrationStatus(project)).integration!;
 const owner=before.owner;const lease=await store.acquire(project,owner);
 if(!lease.acquired)throw new Error("fixture acquire failed");
 await store.claimIntegration(project,{owner,token:lease.token,fence:lease.lease.fence},before.id);
 await recordProjectLifecycle({harness:"test",sessionId:"b",cwd:repo,event:"start"},wake,store);
 await resumePendingProjectIntegrations(wake,store);
 expect(wake).toHaveBeenCalledTimes(1);
 const at=new Date().toISOString();
 await recordProjectLifecycle({harness:"test",sessionId:"b",cwd:repo,event:"end",at},wake,store);
 await recordProjectLifecycle({harness:"test",sessionId:"b",cwd:repo,event:"end",at},wake,store);
 expect(wake).toHaveBeenCalledTimes(2);
 expect(wake.mock.calls[0][0].requestId).not.toBe(wake.mock.calls[1][0].requestId);
 expect(wake.mock.calls[1][0].owner.sessionId).toBe("b");
 await expect(store.claimIntegration(project,{owner,token:lease.token,fence:lease.lease.fence},before.id)).rejects.toThrow("not_pending");
});

it("bounded startup replay recovers persisted unscheduled responsibility without terminal-event retry",async()=>{
 const {repo,store,project}=await setup();
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"start"},undefined,store);
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"end",at:new Date().toISOString()},undefined,store);
 const item=(await store.integrationStatus(project)).integration!;
 const wake=vi.fn(async(_input:any)=>({id:"wait_restart"} as any));
 await resumePendingProjectIntegrations(wake,new ProjectReleaseLeaseStore(store.file));
 await resumePendingProjectIntegrations(wake,new ProjectReleaseLeaseStore(store.file));
 expect(wake).toHaveBeenCalledTimes(1);expect(wake.mock.calls[0][0].requestId).toBe(item.id);
});
it("resuming the same ended session marks its worktree active and denies cleanup",async()=>{
 const {repo,store,project}=await setup();
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"start"},undefined,store);
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"end",at:new Date().toISOString()},undefined,store);
 const item=(await store.integrationStatus(project)).integration!;
 const lease=await store.acquire(project,item.owner);if(!lease.acquired)throw new Error("lease");
 const proof={owner:item.owner,token:lease.token,fence:lease.lease.fence};
 await store.claimIntegration(project,proof,item.id);
 await recordProjectLifecycle({harness:"test",sessionId:"s",cwd:repo,event:"turn-start"},undefined,store);
 await expect(store.withIntegrationCleanup(project,proof,item.id,repo,async()=>true)).rejects.toThrow("inactive");
});
