import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeAfterService, type ResumeAfterOptions } from "../src/resume-after.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, {recursive:true,force:true}))); });
const owner = { harness: "codex", sessionId: "parent" };
const a = { harness: "codex", sessionId: "a" };
const b = { harness: "opencode", sessionId: "b" };
async function fixture(overrides: Partial<ResumeAfterOptions> = {}) {
  const directory = await mkdtemp(join(process.cwd(), ".tmp/resume-after-")); dirs.push(directory);
  const deliver = vi.fn(async () => ({status:"accepted" as const}));
  const service = new ResumeAfterService({directory, deliver, isHeld:async()=>false, isBusy:async()=>false, ...overrides});
  return {service, deliver, directory};
}
function done(service: ResumeAfterService, ref=a, kind="turn.completed") {
  return service.observe({harness:ref.harness,sessionId:ref.sessionId,kind,at:new Date().toISOString()});
}

describe("resume after exact sessions", () => {
  it("waits for all dependencies and resumes exactly once", async () => {
    const {service,deliver}=await fixture();
    const wait=await service.register({owner,dependencies:[a,b],message:"merge and verify",requestId:"all-of"});
    await done(service,a); expect(deliver).not.toHaveBeenCalled();
    await done(service,b); await done(service,b); await service.sweep();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toMatchObject({owner,message:"merge and verify",id:wait.id});
    expect((await service.get(wait.id))?.state).toBe("resumed");
  });
  it("does not turn idle, permission prompts or a lost process into completion", async () => {
    const {service,deliver}=await fixture();
    await service.register({owner,dependencies:[a]});
    for (const kind of ["session.updated","permission.requested","process.disconnected"]) await done(service,a,kind);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("persists completed dependencies across restart without duplicate delivery", async () => {
    const f=await fixture(); const wait=await f.service.register({owner,dependencies:[a,b],requestId:"restart"});
    await done(f.service,a);
    const restored=new ResumeAfterService({directory:f.directory,deliver:f.deliver,isHeld:async()=>false,isBusy:async()=>false});
    await done(restored,b); await restored.sweep();
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect((await restored.register({owner,dependencies:[a,b],requestId:"restart"})).id).toBe(wait.id);
    expect((await restored.get(wait.id))?.state).toBe("resumed");
  });
  it("waits while the owner has useful running work; human stop cancels the wake", async () => {
    let busy=true; let held=false;
    const {service,deliver}=await fixture({isBusy:async()=>busy,isHeld:async()=>held});
    const wait=await service.register({owner,dependencies:[a]});
    await done(service); expect(deliver).not.toHaveBeenCalled();
    busy=false; held=true; await service.sweep();
    expect(deliver).not.toHaveBeenCalled(); expect((await service.get(wait.id))?.state).toBe("cancelled");
  });
  it("preserves unknown delivery rather than replaying a native action", async () => {
    const f=await fixture({deliver:async()=>({status:"ambiguous",reason:"connection dropped"})});
    const wait=await f.service.register({owner,dependencies:[a]});
    await done(f.service); await f.service.sweep();
    expect((await f.service.get(wait.id))?.state).toBe("delivery_unknown");
  });
  it("rejects self-dependencies, conflicting retry ids and cycles", async () => {
    const {service}=await fixture();
    await expect(service.register({owner,dependencies:[owner]})).rejects.toThrow();
    await service.register({owner,dependencies:[a],requestId:"same"});
    await expect(service.register({owner,dependencies:[b],requestId:"same"})).rejects.toThrow();
    await expect(service.register({owner:a,dependencies:[owner]})).rejects.toThrow(/cycle/i);
  });
  it("a new turn invalidates an earlier completion before the join", async () => {
    const {service,deliver}=await fixture();
    await service.register({owner,dependencies:[a,b]});
    await done(service,a); await done(service,a,"turn.started"); await done(service,b);
    expect(deliver).not.toHaveBeenCalled();
    await done(service,a); expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("ignores late completion from before a newer started turn", async () => {
    const {service,deliver}=await fixture();
    const wait=await service.register({owner,dependencies:[a,b]});
    const at=Date.parse(wait.createdAt);
    await service.observe({...a,kind:"turn.started",at:new Date(at+3000).toISOString()});
    await service.observe({...a,kind:"turn.completed",at:new Date(at+1000).toISOString()});
    await service.observe({...b,kind:"turn.completed",at:new Date(at+3000).toISOString()});
    expect(deliver).not.toHaveBeenCalled();
    await service.observe({...a,kind:"turn.completed",at:new Date(at+4000).toISOString()});
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("does not conflate the same id in different harnesses", async () => {
    const {service,deliver}=await fixture();
    await service.register({owner,dependencies:[a]});
    await done(service,{harness:"opencode",sessionId:"a"});
    expect(deliver).not.toHaveBeenCalled();
    await done(service,a);expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("rejects a dependency whose harness cannot prove native completion", async () => {
    const {service}=await fixture({validateDependency:async(ref)=>{
      if(ref.harness!=="codex") throw new Error(`Harness ${ref.harness} does not publish native turn events, so a resume-after dependency on it can never confirm completion`);
    }});
    await expect(service.register({owner,dependencies:[{harness:"claude",sessionId:"c"}]})).rejects.toThrow(/claude/);
    await expect(service.register({owner,dependencies:[a]})).resolves.toBeTruthy();
  });
});
