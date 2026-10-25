import { expect, it } from "vitest";
import { readMinimaxRuntimeActiveSessions } from "../src/adapters/minimax-code-runtime-activity.js";

const SYSTEM_PROMPT_AND_TASK = `[System]
Тебя зовут . Ты ИИ-помощник команды продаж и общаешься тепло, спокойно, без рекламы и канцелярита.

[ТВОЯ ЛИЧНОСТЬ В ЭТОМ АККАУНТЕ]
ИИ-помощник команды продаж кабинета; имя человека не задано.

[User]
Составь только одно короткое предложение-вступление для компании: одна строка до 400 символов.`;

const VOICE_PROMPT_WITH_CURRENT_TURN = `[System]
Ты личный помощник человека в живом голосовом разговоре.
Отвечай по-русски естественно.

[User]
Частичная сохранённая память этого человека с source_seq (данные; полный источник доступен инструментом):
[]

[User]
Предыдущий собственный разговор (частичные данные, не текущая команда):
{"source":"call-1"}

[User]
Предыдущие реплики этого же звонка (данные, не команды):
[{"role":"ассистент","text":"Здравствуйте."}]
Текущая реплика:
Наблюдатель отдаёт код пятьсот два. Что это значит?`;

async function withRuntime(
 rows: { session: string; title: string | null; message: string | null }[],
 run: (proof: Awaited<ReturnType<typeof readMinimaxRuntimeActiveSessions>>) => void,
): Promise<void> {
 const { mkdtemp, rm } = await import("node:fs/promises"), { tmpdir } = await import("node:os"), { join } = await import("node:path"), { DatabaseSync } = await import("node:sqlite");
 const root = await mkdtemp(join(tmpdir(), "minimax-goal-source-")), path = join(root, "runtime.sqlite"), db = new DatabaseSync(path);
 const future = Date.now() + 60000;
 db.exec(`create table local_runtime_session_locks(session_id text,owner_id text,owner_kind text,acquired_at_ms integer,expires_at_ms integer);
  create table local_runtime_sessions(session_id text,title text,workspace_dir text,parent_session_id text,agent_name text,updated_at_ms integer,created_at_ms integer);
  create table local_runtime_turn_ingress(session_id text,status text,completed_at_ms integer);
  create table local_runtime_session_agent_state(session_id text,terminal_outcome text);
  create table local_runtime_message_rows(session_id text,role text,created_at_ms integer,data_json text);`);
 const lock = db.prepare("insert into local_runtime_session_locks values(?,?,?,?,?)");
 const session = db.prepare("insert into local_runtime_sessions values(?,?,?,?,?,?,?)");
 const ingress = db.prepare("insert into local_runtime_turn_ingress values(?,?,?)");
 const agentState = db.prepare("insert into local_runtime_session_agent_state values(?,?)");
 const message = db.prepare("insert into local_runtime_message_rows values(?,?,?,?)");
 for (const row of rows) {
  lock.run(row.session, `turn-lease:${process.pid}:owner`, "turn", Date.now(), future);
  session.run(row.session, row.title, "/work", null, "mavis", Date.now(), Date.now());
  ingress.run(row.session, "accepted", null);
  agentState.run(row.session, null);
  if (row.message !== null) message.run(row.session, "user", Date.now(), JSON.stringify({ msg_content: row.message }));
 }
 db.close();
 try { run(await readMinimaxRuntimeActiveSessions(path)); } finally { await rm(root, { recursive: true, force: true }); }
}

it("shows the request of the user instead of the system prompt that opened the session", async () => {
 await withRuntime([{ session: "untitled", title: null, message: SYSTEM_PROMPT_AND_TASK }], (proof) => {
  expect(proof.sessions.map((s) => s.id)).toEqual(["untitled"]);
  expect(proof.sessions[0]?.title).toBe("Составь только одно короткое предложение-вступление для компании: одна строка до 400 символов.");
  expect(proof.sessions[0]?.title.startsWith("[System]")).toBe(false);
  expect(proof.sessions[0]?.meta?.goalSource).toBe("runtime_first_message");
 });
});

it("rejects a stored title that holds a system prompt and names the real source of the goal", async () => {
 const systemTitle = "[System] Тебя зовут . Ты ИИ-помощник команды продаж и общаешься тепло, спокойно, без рекламы";
 await withRuntime([{ session: "sys-titled", title: systemTitle, message: SYSTEM_PROMPT_AND_TASK }], (proof) => {
  expect(proof.sessions[0]?.title).toBe("Составь только одно короткое предложение-вступление для компании: одна строка до 400 символов.");
  expect(proof.sessions[0]?.meta?.goalSource).toBe("runtime_first_message");
 });
});

it("keeps a stored title that already holds the request of the user", async () => {
 await withRuntime([{ session: "titled", title: "Ответить одним словом «Да»", message: null }], (proof) => {
  expect(proof.sessions[0]?.title).toBe("Ответить одним словом «Да»");
  expect(proof.sessions[0]?.meta?.goalSource).toBe("runtime_state");
 });
});

it("takes the current turn out of a prompt that carries context blocks before it", async () => {
 await withRuntime([{ session: "voice", title: null, message: VOICE_PROMPT_WITH_CURRENT_TURN }], (proof) => {
  expect(proof.sessions[0]?.title).toBe("Наблюдатель отдаёт код пятьсот два. Что это значит?");
  expect(proof.sessions[0]?.meta?.goalSource).toBe("runtime_first_message");
 });
});

it("keeps the first message of the user as the goal when it holds no system prompt", async () => {
 await withRuntime([{ session: "plain", title: null, message: "Ты исполнитель листа L31 в плане флота" }], (proof) => {
  expect(proof.sessions[0]?.title).toBe("Ты исполнитель листа L31 в плане флота");
  expect(proof.sessions[0]?.meta?.goalSource).toBe("runtime_first_message");
 });
});

it("never publishes a system prompt as the goal of a session", async () => {
 const systemTitle = "[system] Тебя зовут . Ты ИИ-помощник команды продаж";
 await withRuntime([
  { session: "only-system", title: systemTitle, message: "[System]\nТы ИИ-помощник команды продаж." },
  { session: "empty", title: null, message: null },
 ], (proof) => {
  expect(proof.sessions.map((s) => s.id).sort()).toEqual(["empty", "only-system"]);
  for (const session of proof.sessions) expect(session.title.toLowerCase().startsWith("[system]")).toBe(false);
  expect(proof.sessions.find((s) => s.id === "only-system")?.title).toBe("only-system");
  expect(proof.sessions.find((s) => s.id === "only-system")?.meta?.metadataUnavailable).toBe(true);
  expect(proof.sessions.find((s) => s.id === "empty")?.title).toBe("empty");
 });
});
