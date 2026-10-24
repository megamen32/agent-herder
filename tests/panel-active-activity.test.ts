import { expect, it } from "vitest";
import { activeActivityIndex, mergeActiveActivity, parseActiveActivity, type ActiveActivityRow } from "../src/web-ui/active-activity.js";
import { readMinimaxThreadGoals } from "../src/adapters/minimax-code-thread-goals.js";
import type { SessionListSession } from "../src/web-ui/session-list.js";

const idleSession = (over: Partial<SessionListSession> = {}): SessionListSession => ({
  id: "mvs_1", harness: "minimax-code", title: "[User] Ответь одним словом: Да", cwd: "/home/roomhacker/.minimax",
  status: "idle", lastActivity: "2026-10-24T09:00:00.000Z", ...over,
});

const working = (over: Partial<ActiveActivityRow> = {}): ActiveActivityRow => ({
  id: "mvs_1", harness: "minimax-code", title: "Ответить одним словом «Да»", runtimeHostId: "roomhacker-server-100",
  status: "running", activity: { state: "active", observedAt: "2026-10-24T09:57:44.990Z", evidence: "native_runtime_turn_lease" },
  workspaces: [{ hostId: "roomhacker-server-100", absolutePath: "/home/roomhacker/.omniroute/minimax-code-workspace" }], ...over,
});

it("the panel shows a proven working session as working and carries its goal",()=>{
  const merged = mergeActiveActivity([idleSession()], [working()], { hostId: "roomhacker-server-100" });
  expect(merged).toHaveLength(1);
  expect(merged[0]!.status).toBe("running");
  expect(merged[0]!.meta?.activityGoal).toBe("Ответить одним словом «Да»");
  expect(merged[0]!.meta?.activityEvidence).toBe("native_runtime_turn_lease");
});

it("a session without proven activity stays idle",()=>{
  const merged = mergeActiveActivity([idleSession()], [], { hostId: "roomhacker-server-100" });
  expect(merged[0]!.status).toBe("idle");
  expect(merged[0]!.meta?.activityGoal).toBeUndefined();
});

it("unproven activity is not dressed up as work",()=>{
  const merged = mergeActiveActivity([idleSession()], [working({ activity: { state: "unknown", evidence: "minimax_control_transport_unavailable" } })], { hostId: "roomhacker-server-100" });
  expect(merged[0]!.status).toBe("idle");
  expect(merged[0]!.meta?.activityGoal).toBeUndefined();
});

it("a working session outside the window of the catalog is still work",()=>{
  const merged = mergeActiveActivity([], [working({ id: "mvs_2" })], { hostId: "roomhacker-server-100" });
  expect(merged).toHaveLength(1);
  expect(merged[0]!.status).toBe("running");
  expect(merged[0]!.title).toBe("Ответить одним словом «Да»");
  expect(merged[0]!.remote).toBe(false);
  expect(merged[0]!.cwd).toBe("/home/roomhacker/.omniroute/minimax-code-workspace");
});

it("the business goal and the business result of the runtime travel with the session",()=>{
  const goals = new Map([["mvs_1", { objective: "Перевести выдачу прав прямо из реестра", status: "running", result: "Проверено на стенде" }]]);
  const merged = mergeActiveActivity([idleSession()], [working()], { hostId: "roomhacker-server-100", goals });
  expect(merged[0]!.meta?.activityGoal).toBe("Перевести выдачу прав прямо из реестра");
  expect(merged[0]!.meta?.activityResult).toBe("Проверено на стенде");
});

it("a session of another machine is matched by its machine",()=>{
  const remote = idleSession({ id: "mvs_3", hostId: "MacBook-Pro-User.local", remote: true });
  const merged = mergeActiveActivity([remote], [working({ id: "mvs_3", runtimeHostId: "MacBook-Pro-User.local" })], { hostId: "roomhacker-server-100" });
  expect(merged[0]!.status).toBe("running");
  const other = mergeActiveActivity([remote], [working({ id: "mvs_3", runtimeHostId: "roomhacker-server-88" })], { hostId: "roomhacker-server-100" });
  expect(other[0]!.status).toBe("idle");
});

it("the answer of the inventory is read as it is and a broken answer is no activity",()=>{
  const snapshot = parseActiveActivity({
    sessions: [
      working(),
      { id: "mvs_9", harness: "codex", title: "afc", activity: { state: "unknown" } },
      { harness: "codex" },
      "not a row",
    ],
    partial: true,
  });
  expect(snapshot.confirmed).toHaveLength(1);
  expect(snapshot.activeCount).toBe(1);
  expect(snapshot.runningCount).toBe(1);
  expect(snapshot.partial).toBe(true);
  expect(parseActiveActivity(null).confirmed).toHaveLength(0);
  expect(parseActiveActivity({ sessions: "broken" }).activeCount).toBe(0);
  expect(activeActivityIndex(snapshot.confirmed).get("roomhacker-server-100|minimax-code|mvs_1")?.id).toBe("mvs_1");
});

it("the reader of the runtime goals reads the real schema of the runtime",async()=>{
  const { mkdtemp, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "herder-thread-goals-")), path = join(root, "runtime-state.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`create table local_runtime_thread_goals(session_id text,objective text,status text,turns_used integer,last_verification text,last_worker_proposal text,status_reason text,created_at_ms integer,updated_at_ms integer);
    insert into local_runtime_thread_goals values('mvs_1','Цель из рантайма','running',2,'Проверено',null,null,1,1792835767000)`);
  db.close();
  try {
    const goals = await readMinimaxThreadGoals(["mvs_1"], path);
    expect(goals).toMatchObject([{ sessionId: "mvs_1", objective: "Цель из рантайма", status: "running", result: "Проверено" }]);
    expect(await readMinimaxThreadGoals(["mvs_absent"], path)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }) }
});

it("a runtime state without the goal table is an error, not an empty goal",async()=>{
  const { mkdtemp, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "herder-thread-goals-empty-")), path = join(root, "runtime-state.sqlite");
  const db = new DatabaseSync(path);
  db.exec("create table local_runtime_sessions(session_id text,title text)");
  db.close();
  try { await expect(readMinimaxThreadGoals(["mvs_1"], path)).rejects.toThrow(); }
  finally { await rm(root, { recursive: true, force: true }) }
});

it("a system prompt is not the goal of a session",()=>{
  const merged = mergeActiveActivity([idleSession()], [working({ title: "[System] \u0422\u0435\u0431\u044f \u0437\u043e\u0432\u0443\u0442 . \u0422\u044b \u0418\u0418-\u043f\u043e\u043c\u043e\u0449\u043d\u0438\u043a \u043a\u043e\u043c\u0430\u043d\u0434\u044b \u043f\u0440\u043e\u0434\u0430\u0436" })], { hostId: "roomhacker-server-100" });
  expect(merged[0]!.meta?.activityGoal).toBeUndefined();
  expect(merged[0]!.status).toBe("running");
});

it("the goal of the runtime is the task of the owner and not its system prompt",async()=>{
  const { mkdtemp, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const root = await mkdtemp(join(tmpdir(), "herder-goal-")), path = join(root, "runtime-state.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`create table local_runtime_sessions(session_id text,title text,workspace_dir text,parent_session_id text,agent_name text,updated_at_ms integer,created_at_ms integer);
    create table local_runtime_session_locks(session_id text,owner_id text,owner_kind text,expires_at_ms integer);
    create table local_runtime_turn_ingress(session_id text,status text,completed_at_ms integer);
    create table local_runtime_session_agent_state(session_id text,terminal_outcome integer);
    create table local_runtime_message_rows(session_id text,role text,data_json text,created_at_ms integer);`);
  // Формат живого рантайма: системный промпт, затем блок пользователя с его запросом.
  const message = ["[System]",
    "Тебя зовут . Ты ИИ-помощник команды продаж и общаешься тепло.",
    "[user]",
    "Контекст предыдущих заказов: не влияет на задачу.",
    "Текущая реплика: Ответь на вопрос по продажам",
  ].join("\n");
  db.prepare("insert into local_runtime_sessions values(?,?,?,?,?,?,?)").run("mvs_1", null, "/work", null, "worker", 1792835767000, 1792835767000);
  db.prepare("insert into local_runtime_session_locks values(?,?,?,?)").run("mvs_1", `turn-lease:${process.pid}:x`, "turn", 17928357670000);
  db.prepare("insert into local_runtime_turn_ingress values(?,?,?)").run("mvs_1", "accepted", null);
  db.prepare("insert into local_runtime_session_agent_state values(?,?)").run("mvs_1", null);
  db.prepare("insert into local_runtime_message_rows values(?,?,?,?)").run("mvs_1", "user", JSON.stringify({ msg_content: message }), 1);
  db.close();
  try {
    const { readMinimaxRuntimeActiveSessions } = await import("../src/adapters/minimax-code-runtime-activity.js");
    const proof = await readMinimaxRuntimeActiveSessions(path);
    expect(proof.sessions).toHaveLength(1);
    expect(proof.sessions[0]!.title).toContain("Ответь на вопрос по продажам");
    expect(proof.sessions[0]!.title).not.toContain("ИИ-помощник команды продаж");
  } finally { await rm(root, { recursive: true, force: true }) }
});
