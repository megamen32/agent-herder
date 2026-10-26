import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QA_CONTROL_ACTOR, QA_CONTROL_PROJECT, QA_CONTROL_REFERENCES, QaControlBackend } from "../src/qa-control.js";

describe("isolated QA control backend", () => {
  it("holds permission, direction, cancel and synthetic /stop inside one test project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "herder-qa-control-"));
    const backend = new QaControlBackend(join(directory, "state.sqlite"));
    const scenarioId = "qa-herder-20261026-001";
    try {
      expect((await stat(join(directory, "state.sqlite"))).mode & 0o777).toBe(0o600);
      const begin = backend.run({ action: "begin", scenarioId, operationId: "qa-begin-0001" });
      expect(begin).toMatchObject({ ok: true, productionEffects: [], state: { project: QA_CONTROL_PROJECT, actor: QA_CONTROL_ACTOR, simulation: true, revision: 0 } });
      expect(begin.state?.fixtures.opencode.nativeReference).toBe(QA_CONTROL_REFERENCES.opencode);
      expect(begin.state?.fixtures.zcode.nativeReference).toBe(QA_CONTROL_REFERENCES.zcode);
      expect(QA_CONTROL_ACTOR).not.toContain("540308572");

      const permission = { action: "permission" as const, scenarioId, operationId: "qa-permission-0001", expectedRevision: 0, fixture: "opencode" as const, choice: "allow" as const };
      expect(backend.run(permission)).toMatchObject({ ok: true, productionEffects: [], state: { revision: 1, fixtures: { opencode: { permission: "allow", phase: "running" } } } });
      expect(backend.run(permission)).toMatchObject({ ok: true, state: { revision: 1 } });
      expect(backend.run({ action: "steer", scenarioId, operationId: "qa-steer-0001", expectedRevision: 1, fixture: "zcode", text: "Fixture direction only" })).toMatchObject({ ok: true, productionEffects: [], state: { revision: 2, fixtures: { zcode: { directions: ["Fixture direction only"] } } } });
      expect(backend.run({ action: "cancel", scenarioId, operationId: "qa-cancel-0001", expectedRevision: 2, fixture: "zcode" })).toMatchObject({ ok: true, productionEffects: [], state: { revision: 3, fixtures: { zcode: { phase: "cancelled" } } } });
      expect(backend.run({ action: "stop", scenarioId, operationId: "qa-stop-0001", expectedRevision: 3, fixture: "opencode", text: "/stop" })).toMatchObject({ ok: true, productionEffects: [], state: { revision: 4, fixtures: { opencode: { phase: "stopped" } } } });
      expect(backend.run({ action: "read", scenarioId })).toMatchObject({ ok: true, productionEffects: [], state: { revision: 4 } });
      expect(backend.run({ action: "steer", scenarioId, operationId: "qa-stale-0001", expectedRevision: 1, fixture: "zcode", text: "stale" })).toMatchObject({ ok: false, productionEffects: [] });
    } finally {
      backend.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
