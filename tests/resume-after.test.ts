import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeAfterService, type ResumeAfterOptions } from "../src/resume-after.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, {recursive:true,force:true}))); });
const owner = { harness: "codex", sessionId: "parent" };
const a = { harness: "codex", sessionId: "a" };
const b = { harness: "opencode", sessionId: "b" };
async function fixture(overrides: Partial<ResumeAfterOptions> = {}) {
  await mkdir(join(process.cwd(), ".tmp"), {recursive:true});
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
  it("holds only waiting records captured at startup while new waits still resume once", async () => {
    await mkdir(join(process.cwd(), ".tmp"), {recursive:true});
    const directory = await mkdtemp(join(process.cwd(), ".tmp/resume-after-hold-")); dirs.push(directory);
    const deliver = vi.fn(async () => ({status:"accepted" as const}));
    let originalOwnerBusy = true;
    const original = new ResumeAfterService({directory, deliver, isHeld:async()=>false,
      isBusy:async ref=>ref.sessionId==="parent"?originalOwnerBusy:false});
    const legacy = await original.register({owner,dependencies:[a],message:"legacy task",requestId:"legacy"});
    await done(original,a);
    const legacyBytes = JSON.stringify(await original.get(legacy.id));
    originalOwnerBusy = false;
    const resumed = new ResumeAfterService({directory, deliver, isHeld:async()=>false, isBusy:async()=>false,
      holdExistingWaitingAtStartup:true});
    expect(await resumed.captureStartupHold()).toBe(1);
    await resumed.sweep();
    expect(JSON.stringify(await resumed.get(legacy.id))).toBe(legacyBytes);
    expect(deliver).not.toHaveBeenCalled();
    for (const event of [
      {kind:"turn.started",turnId:"new-turn"},
      {kind:"turn.completed",turnId:"new-turn"},
      {kind:"session.deleted",turnId:"new-turn"},
    ]) {
      await resumed.observe({harness:a.harness,sessionId:a.sessionId,kind:event.kind,at:new Date().toISOString(),data:{turnId:event.turnId}});
      expect(JSON.stringify(await resumed.get(legacy.id))).toBe(legacyBytes);
    }
    expect(deliver).not.toHaveBeenCalled();

    const fresh = await resumed.register({owner:{harness:"codex",sessionId:"new-owner"},dependencies:[b],message:"fresh task",requestId:"fresh"});
    await resumed.observe({harness:b.harness,sessionId:b.sessionId,kind:"turn.completed",at:new Date().toISOString(),data:{turnId:"fresh-turn"}});
    await resumed.sweep();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await resumed.get(fresh.id))?.state).toBe("resumed");
    expect((await resumed.get(legacy.id))?.state).toBe("waiting");
  });
  it("still honors HumanStop for an explicitly held legacy wait", async () => {
    await mkdir(join(process.cwd(), ".tmp"), {recursive:true});
    const directory = await mkdtemp(join(process.cwd(), ".tmp/resume-after-hold-stop-")); dirs.push(directory);
    let held = false;
    const deliver = vi.fn(async () => ({status:"accepted" as const}));
    let originalOwnerBusy = true;
    const original = new ResumeAfterService({directory, deliver, isHeld:async()=>false,
      isBusy:async ref=>ref.sessionId==="parent"?originalOwnerBusy:false});
    const legacy = await original.register({owner,dependencies:[a],requestId:"legacy-stop"});
    await done(original,a);
    const resumed = new ResumeAfterService({directory, deliver, isHeld:async()=>held, isBusy:async()=>false,
      holdExistingWaitingAtStartup:true});
    expect(await resumed.captureStartupHold()).toBe(1);
    held = true;
    await resumed.observe({harness:owner.harness,sessionId:owner.sessionId,kind:"turn.completed",at:new Date().toISOString(),data:{automationStop:true,turnId:"owner-turn"}});
    expect((await resumed.get(legacy.id))?.state).toBe("cancelled");
    expect(deliver).not.toHaveBeenCalled();
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

  /**
   * A startup hold must not outlive the wait's own deadline.
   *
   * The hold exists to protect specific old expectations during a rollout: a
   * wait that was already `waiting` when the process started stays untouched.
   * But a wait carries its own schedule, and that schedule keeps running while
   * the process lives. A delay wake whose deadline passed *after* the restart
   * was therefore held forever and never fired, even though its owner sat idle
   * and the wait was long due.
   *
   * The live defect: `wait_313f407ec732f2a8beb36fb0d33700d8` (owner
   * `ses_e783d3ac0ffegdglHA2p8k3wls`, delay 600000, due 2026-10-29T19:37:19Z)
   * stayed `waiting` forever because Herder restarted at 19:44:35Z, after the
   * wait was registered, and the startup hold captured it. A wait registered
   * after that same restart fired normally — the hold was the only difference.
   */
  it("releases a held wait once its own scheduled time has passed", async () => {
    await mkdir(join(process.cwd(), ".tmp"), {recursive:true});
    const directory = await mkdtemp(join(process.cwd(), ".tmp/resume-after-hold-deadline-")); dirs.push(directory);
    const deliver = vi.fn(async () => ({status:"accepted" as const}));
    let now = Date.parse("2026-10-29T19:27:00.000Z");
    const service = new ResumeAfterService({directory, deliver, isHeld:async()=>false, isBusy:async()=>false,
      holdExistingWaitingAtStartup:true, now:()=>now});

    // The wait is registered before the restart and comes due after it.
    // A delay wake, exactly like the live defect: no dependency, its own
    // deadline decides when it is due.
    const wait = await service.register({owner,trigger:{kind:"delay",delayMs:600_000},message:"delayed wake",requestId:"held-deadline"});

    // The process starts: the wait exists and is captured by the hold.
    expect(await service.captureStartupHold()).toBe(1);
    await service.sweep();
    expect(deliver).not.toHaveBeenCalled();

    // Its own deadline passes. The hold protects the rollout, not the clock.
    now = Date.parse("2026-10-29T20:00:00.000Z");
    await service.sweep();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await service.get(wait.id))?.state).toBe("resumed");
  });
  it("rejects a dependency whose harness cannot prove native completion", async () => {
    const {service}=await fixture({validateDependency:async(ref)=>{
      if(ref.harness!=="codex") throw new Error(`Harness ${ref.harness} does not publish native turn events, so a resume-after dependency on it can never confirm completion`);
    }});
    await expect(service.register({owner,dependencies:[{harness:"claude",sessionId:"c"}]})).rejects.toThrow(/claude/);
    await expect(service.register({owner,dependencies:[a]})).resolves.toBeTruthy();
  });
});
