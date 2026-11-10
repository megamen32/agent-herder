import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JudgeClient } from "../src/autopilot/index.js";
import {
  V1BrowserAutopilot, type V1BrowserAutopilotOptions, type V1BrowserAutopilotSnapshot,
  type V1BrowserAutopilotState, type V1BrowserAutopilotTarget,
} from "../src/automation/v1-browser-autopilot.js";

const A = { instanceRef: "chatgpt-profile-a", sessionRef: "session:one" };
const B = { instanceRef: "chatgpt-profile-b", sessionRef: "session:one" };
const dirs: string[] = [];
const services: V1BrowserAutopilot[] = [];
const key = (target: V1BrowserAutopilotTarget) => JSON.stringify([target.instanceRef, target.sessionRef]);
function snapshot(target = A): V1BrowserAutopilotSnapshot {
  return { ...target, nativeSessionId: "native-one", cwd: "/workspace/project", status: "idle",
    humanStopHeld: false, revision: "revision-one", messages: [
      { id: "human-one", role: "user", text: "Finish the implementation and verify the result." },
      { id: "assistant-one", role: "assistant", text: "The implementation needs one final check.", phase: "final", completionStatus: "finished_successfully", endTurn: true },
    ] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(initial: V1BrowserAutopilotSnapshot[] = [snapshot()]) {
  const directory = await mkdtemp(join(tmpdir(), "v1-browser-autopilot-"));
  dirs.push(directory);
  const statePath = join(directory, "state.json");
  const current = new Map(initial.map(row => [key(row), structuredClone(row)]));
  const read = vi.fn<V1BrowserAutopilotOptions["read"]>(async target => {
    const row = current.get(key(target));
    if (!row) throw new Error("unavailable");
    return structuredClone(row);
  });
  const canApply = vi.fn<V1BrowserAutopilotOptions["canApply"]>(() => true);
  const decide = vi.fn<JudgeClient["decide"]>(async () => ({ kind: "continue", nextGoal: "Run the final verification." }));
  const createJudge = vi.fn<V1BrowserAutopilotOptions["createJudge"]>(() => ({ decide }));
  const deliver = vi.fn<V1BrowserAutopilotOptions["deliver"]>(async () => ({ status: "confirmed", messageId: "autopilot-one" }));
  const reconcile = vi.fn<V1BrowserAutopilotOptions["reconcile"]>(async () => ({ status: "unknown" }));
  const options: V1BrowserAutopilotOptions = { statePath, read, canApply, createJudge, deliver, reconcile };
  const createService = () => { const service = new V1BrowserAutopilot(options); services.push(service); return service; };
  const service = createService();
  return { service, createService, options, current, read, canApply, decide, createJudge, deliver, reconcile, statePath,
    update(row: V1BrowserAutopilotSnapshot) { current.set(key(row), structuredClone(row)); } };
}
async function cycle(service: V1BrowserAutopilot) { await service.tick(); await service.settle(); }
afterEach(async () => {
  for (const service of services) service.stop();
  await Promise.all(services.map(service => service.settle()));
  await Promise.all(dirs.map(directory => rm(directory, { recursive: true, force: true })));
  services.length = 0; dirs.length = 0;
});

describe("V1 browser autopilot durable consumer", () => {
  it("preserves the complete pair, persists pending before dispatch, and sends once across restart", async () => {
    const row = snapshot();
    row.messages[0]!.text = "Human " + "long user context ".repeat(2_000);
    row.messages[1]!.text = "Assistant " + "long final answer ".repeat(2_000);
    const f = await fixture([row]);
    f.deliver.mockImplementation(async input => {
      const disk = JSON.parse(await readFile(f.statePath, "utf8")) as V1BrowserAutopilotState;
      expect(disk.turns).toHaveLength(1);
      expect(disk.turns[0]).toMatchObject({
        state: "pending", requestKey: input.requestKey, message: input.message, expectedRevision: row.revision,
      });
      return { status: "confirmed", messageId: "autopilot-one", inputId: "original-input-one" };
    });
    const policy = await f.service.setEnabled(A, true);
    await cycle(f.service);
    expect(f.decide.mock.calls[0]![0].hook).toMatchObject({
      last_user_message: row.messages[0]!.text, last_assistant_message: row.messages[1]!.text,
      messages: row.messages.map(({ id, role, text }) => ({ id, role, text })),
    });
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect((await stat(f.statePath)).mode & 0o777).toBe(0o600);
    await cycle(f.service);
    const restarted = f.createService();
    expect((await restarted.setEnabled(A, true)).revision).toBe(policy.revision);
    await cycle(restarted);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect((await restarted.inspect()).generated[0]).toMatchObject({
      messageId: "autopilot-one", inputId: "original-input-one",
    });
  });

  it("reconciles an accepted exact request after restart without another inference or send", async () => {
    const f = await fixture();
    f.deliver.mockResolvedValue({ status: "accepted", receiptRef: "native-task-one" });
    await f.service.setEnabled(A, true);
    await cycle(f.service);
    const original = (await f.service.inspect()).turns[0]!;
    f.reconcile.mockResolvedValue({ status: "confirmed", messageId: "autopilot-one" });
    const restarted = f.createService();
    await cycle(restarted);
    expect(f.reconcile).toHaveBeenCalledWith(expect.objectContaining({
      target: A, requestKey: original.requestKey, receipt: { status: "accepted", receiptRef: "native-task-one" },
    }));
    expect((await restarted.inspect()).turns[0]).toMatchObject({
      state: "confirmed", receipt: { status: "confirmed", receiptRef: "native-task-one" },
    });
    await cycle(restarted);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.decide).toHaveBeenCalledTimes(1);
  });

  it("fences UNKNOWN through restart and new human turns, using only the existing request key", async () => {
    const f = await fixture();
    f.deliver.mockRejectedValue(new Error("transport response lost"));
    await f.service.setEnabled(A, true);
    await cycle(f.service);
    const original = (await f.service.inspect()).turns[0]!;
    expect(original.state).toBe("unknown");
    const changed = snapshot();
    changed.revision = "new-revision";
    changed.messages.push({ id: "human-two", role: "user", text: "Here is a new instruction." },
      { id: "assistant-two", role: "assistant", text: "I have completed the new instruction.", phase: "final", completionStatus: "finished_successfully", endTurn: true });
    f.update(changed);
    const restarted = f.createService();
    await cycle(restarted);
    await cycle(restarted);
    expect(f.reconcile.mock.calls.map(call => call[0].requestKey)).toEqual([original.requestKey, original.requestKey]);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect((await restarted.inspect()).turns).toHaveLength(1);
    f.reconcile.mockResolvedValue({ status: "confirmed", messageId: "autopilot-one" });
    await cycle(restarted);
    expect((await restarted.inspect()).turns[0]!.state).toBe("confirmed");
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });

  it("treats a crash-persisted pending request with no native reference as reconcile-only", async () => {
    const f = await fixture();
    f.deliver.mockResolvedValue({ status: "accepted", receiptRef: "native-task-one" });
    await f.service.setEnabled(A, true);
    await cycle(f.service);
    const disk = JSON.parse(await readFile(f.statePath, "utf8")) as V1BrowserAutopilotState;
    disk.turns[0]!.state = "pending";
    delete disk.turns[0]!.receipt;
    await writeFile(f.statePath, JSON.stringify(disk), { mode: 0o600 });
    const restarted = f.createService();
    await cycle(restarted);
    expect(f.reconcile).toHaveBeenCalledWith(expect.objectContaining({ requestKey: disk.turns[0]!.requestKey }));
    expect((await restarted.inspect()).turns[0]!.state).toBe("unknown");
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.decide).toHaveBeenCalledTimes(1);
  });

  it("holds an interrupted browser judgement across restart and policy toggles, allowing a later native turn", async () => {
    const f = await fixture();
    f.options.holdUnfinishedJudgingOnRestart = true;
    f.decide.mockReturnValue(deferred<unknown>().promise);
    await f.service.setEnabled(A, true); await f.service.tick();
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledTimes(1));
    const crashed = await readFile(f.statePath, "utf8");
    expect(JSON.parse(crashed).turns[0].state).toBe("judging");
    f.service.stop(); await f.service.settle();
    await writeFile(f.statePath, crashed, { mode: 0o600 });
    const restarted = f.createService();
    await cycle(restarted);
    expect((await restarted.inspect()).turns[0]!.state).toBe("judge_unknown");
    await restarted.setEnabled(A, false); await restarted.setEnabled(A, true);
    await cycle(restarted);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
    const changed = snapshot(); changed.revision = "later-native-turn";
    changed.messages.push(
      { id: "human-two", role: "user", text: "Here is the next instruction." },
      { id: "assistant-two", role: "assistant", text: "The next instruction is complete.", phase: "final",
        completionStatus: "finished_successfully", endTurn: true },
    );
    f.update(changed);
    f.decide.mockResolvedValue({ kind: "done", summary: "The new turn is complete." });
    await cycle(restarted);
    expect(f.decide).toHaveBeenCalledTimes(2);
    expect((await restarted.inspect()).turns.map(turn => turn.state)).toEqual(["judge_unknown", "done"]);
  });

  it("holds an interrupted active browser judgement after graceful stop and restart", async () => {
    const f = await fixture();
    f.options.holdUnfinishedJudgingOnRestart = true;
    f.decide.mockReturnValue(deferred<unknown>().promise);
    await f.service.setEnabled(A, true); await f.service.tick();
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledTimes(1));
    f.service.stop(); await f.service.settle();
    expect((await f.service.inspect()).turns[0]!.state).toBe("judge_unknown");
    const restarted = f.createService();
    await cycle(restarted);
    await restarted.setEnabled(A, false); await restarted.setEnabled(A, true);
    await cycle(restarted);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
  });

  it("permits a fresh pure API inference after restart when browser uncertainty fencing is not configured", async () => {
    const f = await fixture();
    f.decide.mockReturnValue(deferred<unknown>().promise);
    await f.service.setEnabled(A, true); await f.service.tick();
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledTimes(1));
    const crashed = await readFile(f.statePath, "utf8");
    f.service.stop(); await f.service.settle();
    await writeFile(f.statePath, crashed, { mode: 0o600 });
    f.decide.mockResolvedValue({ kind: "done", summary: "The repeated inference completed." });
    const restarted = f.createService();
    await cycle(restarted);
    expect(f.decide).toHaveBeenCalledTimes(2);
    expect((await restarted.inspect()).turns[0]!.state).toBe("done");
  });

  it("allows two instances with the same session reference to progress independently", async () => {
    const f = await fixture([snapshot(A), snapshot(B)]);
    const blocked = deferred<unknown>();
    const busyJudge = vi.fn<JudgeClient["decide"]>(() => blocked.promise);
    const fastJudge = vi.fn<JudgeClient["decide"]>(async () => ({ kind: "continue", nextGoal: "Check profile B." }));
    f.createJudge.mockImplementation(({ target }) => ({ decide: target.instanceRef === A.instanceRef ? busyJudge : fastJudge }));
    await f.service.setEnabled(A, true); await f.service.setEnabled(B, true);
    expect(await f.service.tick()).toMatchObject({ started: 2 });
    await vi.waitFor(() => expect(f.deliver).toHaveBeenCalledWith(expect.objectContaining({ target: B })));
    expect(f.deliver).toHaveBeenCalledTimes(1);
    await f.service.settle(B);
    expect((await f.service.inspect()).active).toEqual([A]);
    f.service.stop(A);
    await f.service.settle();
    expect((await f.service.inspect()).turns.find(turn => turn.instanceRef === A.instanceRef)?.state).toBe("cancelled");
    expect((await f.service.inspect()).turns.find(turn => turn.instanceRef === B.instanceRef)?.state).toBe("confirmed");
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });

  it("produces distinct durable request identities for identical native IDs in two exact instances", async () => {
    const f = await fixture([snapshot(A), snapshot(B)]);
    await f.service.setEnabled(A, true); await f.service.setEnabled(B, true);
    await cycle(f.service);
    const requests = f.deliver.mock.calls.map(call => call[0].requestKey);
    expect(requests).toHaveLength(2);
    expect(new Set(requests).size).toBe(2);
  });

  it("discards a decision when a new human arrives, then waits for that human's final reply", async () => {
    const f = await fixture();
    const decision = deferred<unknown>();
    f.decide.mockReturnValue(decision.promise);
    await f.service.setEnabled(A, true);
    await f.service.tick();
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledTimes(1));
    const changed = snapshot();
    changed.revision = "revision-two";
    changed.messages.push({ id: "human-two", role: "user", text: "Stop that plan and use this new goal." });
    f.update(changed);
    decision.resolve({ kind: "continue", nextGoal: "Stale continuation" });
    await f.service.settle();
    expect((await f.service.inspect()).turns[0]!.state).toBe("stale");
    expect(f.deliver).not.toHaveBeenCalled();
    await cycle(f.service);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect((await f.service.inspect()).targets[0]!.observation).toBe("paused_missing_complete_human_assistant_pair");
  });

  it.each(["revision", "hold", "disable"] as const)("fences a %s change during inference", async change => {
    const f = await fixture();
    const decision = deferred<unknown>();
    f.decide.mockReturnValue(decision.promise);
    await f.service.setEnabled(A, true); await f.service.tick();
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledTimes(1));
    if (change === "disable") await f.service.setEnabled(A, false);
    else {
      const changed = snapshot();
      if (change === "hold") changed.humanStopHeld = true;
      else changed.revision = "revision-two";
      f.update(changed);
    }
    decision.resolve({ kind: "continue", nextGoal: "Stale continuation" });
    await f.service.settle();
    expect(f.deliver).not.toHaveBeenCalled();
    expect((await f.service.inspect()).turns[0]!.state).toBe(change === "disable" ? "cancelled" : "stale");
  });

  it("keeps identical enable updates idempotent while a judge is running", async () => {
    const f = await fixture();
    const decision = deferred<unknown>();
    f.decide.mockReturnValue(decision.promise);
    const before = await f.service.setEnabled(A, true);
    await f.service.tick();
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledTimes(1));
    expect(await f.service.setEnabled(A, true)).toMatchObject({ revision: before.revision });
    expect(f.createJudge.mock.calls[0]![0].signal.aborted).toBe(false);
    decision.resolve({ kind: "continue", nextGoal: "Continue the same authorised turn." });
    await f.service.settle();
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });

  it("does not convert a known pre-dispatch cancellation into a permanent UNKNOWN receipt", async () => {
    const f = await fixture();
    f.read.mockImplementation(async target => {
      try {
        const disk = JSON.parse(await readFile(f.statePath, "utf8")) as V1BrowserAutopilotState;
        if (disk.turns[0]?.state === "pending") {
          f.service.stop(target);
          throw new DOMException("Stopped before send", "AbortError");
        }
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") throw error;
      }
      return snapshot(target);
    });
    await f.service.setEnabled(A, true); await cycle(f.service);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect((await f.service.inspect()).turns[0]!.state).toBe("cancelled");
  });

  it("does not retry a failed judge on every tick, but allows explicit disable/enable to retry", async () => {
    const f = await fixture();
    f.decide.mockRejectedValue(new Error("permanent authentication or context failure"));
    await f.service.setEnabled(A, true);
    await cycle(f.service); await cycle(f.service);
    const restarted = f.createService();
    await cycle(restarted);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect((await restarted.inspect()).turns[0]!.state).toBe("failed");
    await restarted.setEnabled(A, false); await restarted.setEnabled(A, true);
    f.decide.mockResolvedValue({ kind: "done", summary: "Completed." });
    await cycle(restarted);
    expect(f.decide).toHaveBeenCalledTimes(2);
    expect((await restarted.inspect()).turns[0]!.state).toBe("done");
  });

  it.each([
    { kind: "done", summary: "The requested work is complete.", notify: true },
    { kind: "human", title: "A user decision is needed", body: "Choose the deployment target.", severity: "medium" },
    { kind: "choice", choices: [
      { choiceId: "a", label: "First", nextGoal: "Use the first plan." },
      { choiceId: "b", label: "Second", nextGoal: "Use the second plan." },
    ] },
  ])("records a $kind decision without sending a user prompt or a notification", async decision => {
    const f = await fixture();
    f.decide.mockResolvedValue(decision);
    await f.service.setEnabled(A, true); await cycle(f.service); await cycle(f.service);
    const turn = (await f.service.inspect()).turns[0]!;
    expect(turn.state).toBe(decision.kind === "done" ? "done" : "blocked");
    if (decision.kind === "done") expect(turn.decision).toMatchObject({ notify: false });
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.decide).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["running", (row: V1BrowserAutopilotSnapshot) => { row.status = "running"; }],
    ["held", (row: V1BrowserAutopilotSnapshot) => { row.humanStopHeld = true; }],
    ["needs input", (row: V1BrowserAutopilotSnapshot) => { row.status = "needs_input"; }],
    ["stopped", (row: V1BrowserAutopilotSnapshot) => { row.status = "stopped"; }],
    ["commentary", (row: V1BrowserAutopilotSnapshot) => { row.messages[1]!.phase = "commentary"; }],
    ["analysis", (row: V1BrowserAutopilotSnapshot) => { row.messages[1]!.phase = "analysis"; }],
    ["missing human", (row: V1BrowserAutopilotSnapshot) => { row.messages.shift(); }],
    ["missing answer", (row: V1BrowserAutopilotSnapshot) => { row.messages.pop(); }],
    ["empty answer", (row: V1BrowserAutopilotSnapshot) => { row.messages[1]!.text = " "; }],
  ] as const)("pauses on %s without inference", async (_name, mutate) => {
    const row = snapshot(); mutate(row);
    const f = await fixture([row]);
    await f.service.setEnabled(A, true); await cycle(f.service);
    expect(f.decide).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
  });

  it.each([
    { completionStatus: "in_progress", endTurn: false },
    { completionStatus: "in_progress", endTurn: true },
    { completionStatus: "finished_successfully", endTurn: false },
    { completionStatus: "error", endTurn: true },
    { completionStatus: "finished_partial", endTurn: true },
    {},
  ])("requires positive completion evidence and rejects contradictory final metadata: %j", async metadata => {
    const row = snapshot();
    delete row.messages[1]!.completionStatus; delete row.messages[1]!.endTurn;
    Object.assign(row.messages[1]!, metadata);
    const f = await fixture([row]);
    await f.service.setEnabled(A, true); await cycle(f.service);
    expect(f.decide).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
    expect((await f.service.inspect()).targets[0]!.observation).toBe("paused_missing_complete_human_assistant_pair");
  });

  it.each([{ completionStatus: "finished_successfully" }, { endTurn: true }])(
    "accepts either explicit successful completion proof when no conflicting proof exists: %j", async metadata => {
      const row = snapshot();
      delete row.messages[1]!.completionStatus; delete row.messages[1]!.endTurn;
      Object.assign(row.messages[1]!, metadata);
      const f = await fixture([row]);
      await f.service.setEnabled(A, true); await cycle(f.service);
      expect(f.decide).toHaveBeenCalledTimes(1); expect(f.deliver).toHaveBeenCalledTimes(1);
    });

  it("fences completion changes even when native authority revision is unchanged", async () => {
    const f = await fixture();
    const decision = deferred<unknown>();
    f.decide.mockReturnValue(decision.promise);
    await f.service.setEnabled(A, true); await f.service.tick();
    await vi.waitFor(() => expect(f.decide).toHaveBeenCalledTimes(1));
    const changed = snapshot();
    changed.messages[1]!.endTurn = false;
    changed.messages[1]!.completionStatus = "in_progress";
    f.update(changed);
    decision.resolve({ kind: "continue", nextGoal: "Do not send while streaming." });
    await f.service.settle();
    expect(f.deliver).not.toHaveBeenCalled();
    expect((await f.service.inspect()).turns[0]!.state).toBe("stale");
  });

  it("does not authorise targets discovered by read or accept a mismatched exact scope", async () => {
    const f = await fixture([snapshot(A), snapshot(B)]);
    await f.service.setEnabled(A, true);
    f.read.mockResolvedValue(snapshot(B));
    await cycle(f.service);
    expect((await f.service.inspect()).targets.map(target => target.instanceRef)).toEqual([A.instanceRef]);
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it("uses original input provenance, not native message IDs as generated input IDs", async () => {
    const f = await fixture();
    f.deliver.mockResolvedValue({ status: "confirmed", inputId: "original-input-one" });
    await f.service.setEnabled(A, true); await cycle(f.service);
    const changed = snapshot();
    changed.revision = "revision-two";
    changed.messages.push(
      { id: "native-id-different", role: "user", text: "Native prompt representation", inputId: "original-input-one" },
      { id: "assistant-two", role: "assistant", text: "The verification passed.", phase: "final", completionStatus: "finished_successfully", endTurn: true },
    );
    f.update(changed);
    f.decide.mockResolvedValue({ kind: "done", summary: "Verified." });
    await cycle(f.service);
    expect(f.decide).toHaveBeenCalledTimes(2);
    expect(f.decide.mock.calls[1]![0].hook.last_user_message).toBe(snapshot().messages[0]!.text);
  });

  it("binds generated native message IDs from a confirmed prompt and continuous unique readback", async () => {
    const f = await fixture();
    f.deliver.mockResolvedValue({ status: "confirmed" });
    await f.service.setEnabled(A, true); await cycle(f.service);
    const changed = snapshot();
    changed.revision = "revision-two";
    changed.messages.push(
      { id: "native-generated", role: "user", text: "Run the final verification." },
      { id: "assistant-two", role: "assistant", text: "The verification passed.", phase: "final", completionStatus: "finished_successfully", endTurn: true },
    );
    f.update(changed);
    f.decide.mockResolvedValue({ kind: "done", summary: "Verified." });
    await cycle(f.service);
    expect(f.decide.mock.calls[1]![0].hook.last_user_message).toBe(snapshot().messages[0]!.text);
    expect((await f.service.inspect()).generated[0]!.messageId).toBe("native-generated");
    const restarted = f.createService();
    await cycle(restarted);
    expect(f.decide).toHaveBeenCalledTimes(2);
  });

  it("waits when the latest generated user prompt has no assistant reply", async () => {
    const f = await fixture();
    await f.service.setEnabled(A, true); await cycle(f.service);
    const changed = snapshot();
    changed.revision = "revision-two";
    changed.messages.push({ id: "autopilot-one", role: "user", text: "Run the final verification." });
    f.update(changed); await cycle(f.service);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect((await f.service.inspect()).targets[0]!.observation).toBe("paused_missing_complete_human_assistant_pair");
  });

  it("carries the last real human beyond the native tail only with a retained continuity anchor", async () => {
    const f = await fixture();
    await f.service.setEnabled(A, true); await cycle(f.service);
    const changed = snapshot();
    changed.revision = "revision-two";
    changed.messages.shift();
    changed.messages.push({ id: "autopilot-one", role: "user", text: "Run the final verification." },
      { id: "assistant-two", role: "assistant", text: "The verification passed.", phase: "final", completionStatus: "finished_successfully", endTurn: true });
    f.update(changed);
    f.decide.mockResolvedValue({ kind: "done", summary: "Verified." });
    const restarted = f.createService();
    await cycle(restarted);
    expect(f.decide.mock.calls[1]![0].hook.last_user_message).toBe(snapshot().messages[0]!.text);
    expect(f.decide.mock.calls[1]![0].hook.last_assistant_message).toBe("The verification passed.");
    const discontinuous = { ...changed, revision: "revision-three", messages: [
      { id: "assistant-three", role: "assistant", text: "A later answer with a missing history window.", phase: "final", completionStatus: "finished_successfully", endTurn: true },
    ] };
    f.update(discontinuous); await cycle(restarted);
    expect(f.decide).toHaveBeenCalledTimes(2);
    expect((await restarted.inspect()).targets[0]!.observation).toBe("paused_missing_complete_human_assistant_pair");
  });

  it("pauses ambiguous text-only generated provenance rather than treating it as a real human", async () => {
    const f = await fixture();
    f.deliver.mockResolvedValue({ status: "confirmed" });
    await f.service.setEnabled(A, true); await cycle(f.service);
    const changed = snapshot();
    changed.revision = "revision-two";
    changed.messages.push(
      { id: "candidate-one", role: "user", text: "Run the final verification." },
      { id: "candidate-two", role: "user", text: "Run the final verification." },
      { id: "assistant-two", role: "assistant", text: "Verification passed.", phase: "final", completionStatus: "finished_successfully", endTurn: true },
    );
    f.update(changed); await cycle(f.service);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect(f.deliver).toHaveBeenCalledTimes(1);
  });

  it("does not classify a later manual quote as generated without original-turn readback", async () => {
    const f = await fixture();
    f.deliver.mockResolvedValue({ status: "confirmed" });
    await f.service.setEnabled(A, true); await cycle(f.service);
    const changed = snapshot();
    changed.revision = "revision-two";
    changed.messages.push(
      { id: "human-two", role: "user", text: "Here is a new manual instruction." },
      { id: "assistant-two", role: "assistant", text: "Acknowledged.", phase: "final", completionStatus: "finished_successfully", endTurn: true },
      { id: "manual-quote", role: "user", text: "Run the final verification." },
      { id: "assistant-three", role: "assistant", text: "The quoted instruction is complete.", phase: "final", completionStatus: "finished_successfully", endTurn: true },
    );
    f.update(changed); await cycle(f.service);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect((await f.service.inspect()).targets[0]!.observation).toBe("paused_missing_complete_human_assistant_pair");
    expect((await f.service.inspect()).generated[0]!.messageId).toBeUndefined();
  });

  it("redacts retained human context and decision text, and never persists raw thrown errors", async () => {
    const row = snapshot();
    row.messages[0]!.text = "Use Bearer fixture-token for verification.";
    const f = await fixture([row]);
    f.decide.mockRejectedValue(new Error("Bearer fixture-token"));
    await f.service.setEnabled(A, true); await cycle(f.service);
    const disk = await readFile(f.statePath, "utf8");
    expect(disk).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
    expect((await f.service.inspect()).targets[0]!.lastHuman?.text).toContain("REDACTED");
    expect((await f.service.inspect()).turns[0]!.reason).toBe("evaluation_unavailable");
  });

  it("fails closed when the durable state is corrupt", async () => {
    const f = await fixture();
    await writeFile(f.statePath, '{"version":1,"targets":[],"turns":[{}],"generated":[]}', { mode: 0o600 });
    await expect(f.service.tick()).rejects.toThrow("invalid_browser_autopilot_state");
    expect(f.read).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
  });
});
