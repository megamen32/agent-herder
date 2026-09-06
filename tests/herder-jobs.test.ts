import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("HerderJobRegistry", () => {
  it("owns long-running state independently from an MCP transport", async () => {
    const events = new HerderEventBus();
    const seen: string[] = [];
    events.subscribe((event) => seen.push(`${event.action}:${event.uri}`));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const jobs = new HerderJobRegistry(events);

    const started = jobs.start({
      kind: "fixture",
      ownerSessionId: "agent-1",
      run: async ({ progress }) => {
        progress(0.5, "halfway");
        await gate;
        return { ok: true };
      },
    });
    await tick();

    expect(jobs.get(started.id)).toMatchObject({ state: "running", progress: 0.5, ownerSessionId: "agent-1" });
    expect(seen).toContain(`created:herder://jobs/${encodeURIComponent(started.id)}`);
    release();
    await tick();
    await tick();
    expect(jobs.get(started.id)).toMatchObject({ state: "completed", progress: 1, result: { ok: true } });
  });

  it("persists history and marks in-flight jobs interrupted after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-herder-jobs-"));
    const persistencePath = join(dir, "jobs.json");
    try {
      const jobs = new HerderJobRegistry(new HerderEventBus(), { persistencePath });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = jobs.start({ kind: "persistent-fixture", run: async ({ progress }) => { progress(0.4, "working"); await gate; return { ok: true }; } });
      await tick();
      expect(jobs.get(started.id)).toMatchObject({ state: "running", progress: 0.4 });

      const restored = new HerderJobRegistry(new HerderEventBus(), { persistencePath });
      expect(restored.get(started.id)).toMatchObject({ state: "interrupted", error: "interrupted by service restart" });
      release();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("shows cancellation-in-progress until the runner actually acknowledges abort", async () => {
    const jobs = new HerderJobRegistry(new HerderEventBus());
    let release!: () => void;
    const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
    const started = jobs.start({
      kind: "fixture",
      run: async ({ signal }) => {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        await cleanupGate;
        throw new Error("cancelled");
      },
    });
    await tick();
    expect(jobs.cancel(started.id)).toMatchObject({ state: "cancelling", statusMessage: "Cancellation requested" });
    expect(jobs.get(started.id)).toMatchObject({ state: "cancelling" });
    release();
    await tick();
    await tick();
    expect(jobs.get(started.id)).toMatchObject({ state: "cancelled", statusMessage: "Cancelled" });
  });
});
