import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCadenceRuntime } from "../src/cadence-runtime.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { HarnessAdapter } from "../src/types/index.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "herder-process-dispatch-"));
  roots.push(root);
  const session = { id: "session", harness: "codex", cwd: root, title: "isolated",
    status: "idle", needsPermission: false, lastActivity: new Date().toISOString(), meta: { nativeStateObserved: true } };
  const adapter = { type: "codex", name: "fixture", getSession: vi.fn(async () => session),
    sendMessage: vi.fn(async () => ({ ok: true, admitted: true })) } as unknown as HarnessAdapter;
  const adapters = new Map([["codex", adapter]]);
  const held = { value: false };
  const processWaits = { blocks: vi.fn(async () => held.value) };
  const cadenceSupervisor = {
    isAutomationHeld: vi.fn(async () => false),
    sendMessage: vi.fn(async () => ({ ok: true, admitted: true })),
  };
  const path = join(root, "cadence.json");
  const runtime = createCadenceRuntime(adapters, cadenceSupervisor, path, processWaits);
  return { root, session, adapter, adapters, held, processWaits, cadenceSupervisor, path, runtime };
}

describe("process wait fences at cadence and native admission", () => {
  it("keeps a waiting cadence scheduled and advances it once after the canonical gate clears", async () => {
    const f = await fixture();
    const row = await f.runtime.schedule({ sessionId: "session", requestId: "cadence" });
    await writeFile(f.path, JSON.stringify([{ ...row, nextAt: new Date(0).toISOString() }]));
    f.held.value = true;
    await f.runtime.sweep();
    expect(f.cadenceSupervisor.sendMessage).not.toHaveBeenCalled();
    expect((await f.runtime.list())[0]).toMatchObject({ state: "scheduled", sequence: 0 });
    f.held.value = false;
    await f.runtime.sweep();
    expect(f.cadenceSupervisor.sendMessage).toHaveBeenCalledTimes(1);
    expect((await f.runtime.list())[0]).toMatchObject({ state: "scheduled", sequence: 1 });
  });

  it("honors HumanStop as a permanent pause even while a process wait is active", async () => {
    const f = await fixture();
    const row = await f.runtime.schedule({ sessionId: "session", requestId: "cadence" });
    f.held.value = true;
    f.cadenceSupervisor.isAutomationHeld.mockResolvedValue(true);
    await f.runtime.sweep();
    f.held.value = false;
    f.cadenceSupervisor.isAutomationHeld.mockResolvedValue(false);
    await writeFile(f.path, JSON.stringify((await f.runtime.list()).map(item => ({ ...item, nextAt: new Date(0).toISOString() }))));
    await f.runtime.sweep();
    expect((await f.runtime.list())[0]).toMatchObject({ id: row.id, state: "paused", reason: "HumanStop" });
    expect(f.cadenceSupervisor.sendMessage).not.toHaveBeenCalled();
  });

  it("defers a wait armed after cadence preflight without losing the scheduled occurrence", async () => {
    const f = await fixture();
    const row = await f.runtime.schedule({ sessionId: "session", requestId: "cadence" });
    await writeFile(f.path, JSON.stringify([{ ...row, nextAt: new Date(0).toISOString() }]));
    f.processWaits.blocks.mockReset();
    f.processWaits.blocks.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await f.runtime.sweep();
    expect(f.cadenceSupervisor.sendMessage).not.toHaveBeenCalled();
    expect((await f.runtime.list())[0]).toMatchObject({ state: "scheduled", result: { status: "deferred", notSubmitted: true } });
  });

  it("defers a final supervisor process fence without treating it as lost native ACK", async () => {
    const f = await fixture();
    const row = await f.runtime.schedule({ sessionId: "session", requestId: "cadence" });
    await writeFile(f.path, JSON.stringify([{ ...row, nextAt: new Date(0).toISOString() }]));
    f.cadenceSupervisor.sendMessage.mockResolvedValue({
      ok: false, notSubmitted: true, nonRetryable: true, error: "process_wait_active",
    } as never);
    await f.runtime.sweep();
    expect((await f.runtime.list())[0]).toMatchObject({ state: "scheduled", result: { status: "deferred" } });
  });

  it("blocks native automatic sends while allowing an explicit human message", async () => {
    const f = await fixture();
    const humanStops = { isHeld: vi.fn(async () => false), observe: vi.fn(async () => false) };
    const supervisor = new SessionSupervisor(f.adapters, { convert: vi.fn() } as never, undefined, {
      processWaits: f.processWaits, humanStopStore: humanStops as never, autoResumeFailedSessions: false,
    });
    vi.spyOn(supervisor as any, "releaseHumanStop").mockResolvedValue(undefined);
    vi.spyOn(supervisor as any, "publishSessionChanged").mockImplementation(() => {});
    f.held.value = true;
    expect(await supervisor.sendMessage("codex", "session", { origin: "automation", message: "automatic" }))
      .toMatchObject({ ok: false, notSubmitted: true, error: "process_wait_active" });
    expect(f.adapter.sendMessage).not.toHaveBeenCalled();
    expect(f.adapter.getSession).not.toHaveBeenCalled();
    f.processWaits.blocks.mockClear();
    expect(await supervisor.sendMessage("codex", "session", { origin: "human", message: "human" }))
      .toMatchObject({ ok: true });
    expect(f.adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.processWaits.blocks).not.toHaveBeenCalled();
  });

  it("rechecks the wait after an asynchronous fleet admission callback", async () => {
    const f = await fixture();
    const admissionGate = vi.fn(async () => { f.held.value = true; return { allowed: true as const }; });
    const supervisor = new SessionSupervisor(f.adapters, { convert: vi.fn() } as never, undefined, {
      processWaits: f.processWaits, admissionGate, autoResumeFailedSessions: false,
    });
    expect(await supervisor.sendMessage("codex", "session", { origin: "automation", message: "automatic" }))
      .toMatchObject({ ok: false, notSubmitted: true, error: "process_wait_active" });
    expect(admissionGate).toHaveBeenCalledTimes(1);
    expect(f.adapter.sendMessage).not.toHaveBeenCalled();
    expect(f.adapter.getSession).not.toHaveBeenCalled();
  });
});
