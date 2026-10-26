import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A fixture-only control plane. It never imports a native adapter or owner Stop. */
export const QA_CONTROL_PROJECT = "agent-herder-control-qa";
export const QA_CONTROL_ACTOR = "gptadmin:agent-herder-qa-actor";
export const QA_CONTROL_REFERENCES = Object.freeze({
  opencode: "ses_e89e37b55ffe6h15lL2J4lK0qb",
  zcode: "session_529567ea-c12d-457c-97df-846229bf96e4",
});

type FixtureName = keyof typeof QA_CONTROL_REFERENCES;
type Fixture = { nativeReference: string; phase: "awaiting_permission" | "running" | "cancelled" | "stopped"; permission: "pending" | "allow" | "deny" | null; directions: string[] };
type Scenario = { scenarioId: string; project: typeof QA_CONTROL_PROJECT; actor: typeof QA_CONTROL_ACTOR; simulation: true; revision: number; fixtures: Record<FixtureName, Fixture> };
export type QaControlInput = {
  action: "begin" | "read" | "permission" | "steer" | "cancel" | "stop";
  scenarioId: string;
  operationId?: string;
  expectedRevision?: number;
  fixture?: FixtureName;
  choice?: "allow" | "deny";
  text?: string;
};

const initial = (scenarioId: string): Scenario => ({
  scenarioId, project: QA_CONTROL_PROJECT, actor: QA_CONTROL_ACTOR, simulation: true, revision: 0,
  fixtures: {
    opencode: { nativeReference: QA_CONTROL_REFERENCES.opencode, phase: "awaiting_permission", permission: "pending", directions: [] },
    zcode: { nativeReference: QA_CONTROL_REFERENCES.zcode, phase: "running", permission: null, directions: [] },
  },
});

export class QaControlBackend {
  private readonly db: DatabaseSync;

  constructor(path = join(homedir(), ".local/state/agent-herder/qa-control/scenarios.sqlite")) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec("CREATE TABLE IF NOT EXISTS scenarios (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS operations (scenario_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (scenario_id, operation_id))");
  }

  close(): void { this.db.close(); }

  run(input: QaControlInput): { ok: boolean; receipt: string; state?: Scenario; error?: string; productionEffects: [] } {
    const receipt = input.operationId || randomUUID();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(input.scenarioId)) return { ok: false, receipt, error: "Invalid QA scenario ID", productionEffects: [] };
    if (input.action !== "read" && (!input.operationId || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(input.operationId))) {
      return { ok: false, receipt, error: "Stable QA operation ID required", productionEffects: [] };
    }
    const fingerprint = JSON.stringify(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = input.operationId && this.db.prepare("SELECT fingerprint,result FROM operations WHERE scenario_id=? AND operation_id=?").get(input.scenarioId, input.operationId) as { fingerprint: string; result: string } | undefined;
      if (prior) {
        this.db.exec("COMMIT");
        return prior.fingerprint === fingerprint ? JSON.parse(prior.result) : { ok: false, receipt, error: "QA operation ID already used for different input", productionEffects: [] };
      }
      const row = this.db.prepare("SELECT state FROM scenarios WHERE id=?").get(input.scenarioId) as { state: string } | undefined;
      let state: Scenario | undefined = row ? JSON.parse(row.state) : undefined;
      if (input.action === "begin") {
        if (state) throw Error("QA scenario already exists; use read or a new scenario ID");
        const count = (this.db.prepare("SELECT count(*) AS n FROM scenarios").get() as { n: number }).n;
        if (count >= 100) throw Error("QA scenario capacity reached");
        state = initial(input.scenarioId);
        this.db.prepare("INSERT INTO scenarios(id,state) VALUES(?,?)").run(input.scenarioId, JSON.stringify(state));
      } else {
        if (!state) throw Error("QA scenario not found");
        if (input.action !== "read") {
          if (input.expectedRevision !== state.revision) throw Error("QA revision changed; read before acting");
          const fixture = input.fixture && state.fixtures[input.fixture];
          if (!fixture) throw Error("QA fixture not found");
          if (input.action === "permission") {
            if (input.fixture !== "opencode" || fixture.permission !== "pending" || (input.choice !== "allow" && input.choice !== "deny")) throw Error("No matching pending QA permission");
            fixture.permission = input.choice;
            fixture.phase = input.choice === "allow" ? "running" : "cancelled";
          } else if (input.action === "steer") {
            if (fixture.phase !== "running" || !input.text?.trim() || input.text.length > 500) throw Error("QA turn unavailable for direction");
            fixture.directions.push(input.text.trim());
          } else if (input.action === "cancel") {
            if (fixture.phase !== "running") throw Error("No active QA turn to cancel");
            fixture.phase = "cancelled";
          } else if (input.action === "stop") {
            // This is a synthetic fixture transition only. There is no native
            // Stop capability or production session handle in this module.
            if (input.text !== "/stop") throw Error("Only synthetic /stop is available in QA");
            fixture.phase = "stopped";
          }
          state.revision++;
          this.db.prepare("UPDATE scenarios SET state=? WHERE id=?").run(JSON.stringify(state), input.scenarioId);
        }
      }
      const result = { ok: true, receipt, state, productionEffects: [] as [] };
      if (input.operationId) this.db.prepare("INSERT INTO operations(scenario_id,operation_id,fingerprint,result) VALUES(?,?,?,?)").run(input.scenarioId, input.operationId, fingerprint, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      return { ok: false, receipt, error: error instanceof Error ? error.message : String(error), productionEffects: [] };
    }
  }
}
