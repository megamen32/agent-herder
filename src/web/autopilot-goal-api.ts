import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { HarnessAdapter } from "../types/index.js";
import { GoalStore, type GoalIdentity, type GoalSnapshot } from "../autopilot/goal-store.js";
import type { AutopilotSessionStore, AutopilotHarness } from "../autopilot/session-store.js";
import { resolveAutopilotStateDir } from "../autopilot/state-dir.js";
import { getHumanStopStore } from "../human-stop-store.js";
import { goalControllerAdmission } from "../autopilot/goal-controller-admission.js";

const HARNESSES = new Set(["codex", "opencode", "claude", "hermes", "zcode"]);
const defaultStore = new GoalStore(resolveAutopilotStateDir());
export type GoalApiResult = { status: number; body: Record<string, unknown> };

/** Invoked only after the ordinary authenticated owner API boundary. No alternate auth. */
export async function autopilotGoalApi(input: {
  harness: string; sessionId: string; cwd: string; method: string; body?: Record<string, unknown>;
  adapters: Map<string, HarnessAdapter>; sessionStore?: AutopilotSessionStore;
  store?: GoalStore; judgeModel?: string;
  kick?: (identity: GoalIdentity, goal: GoalSnapshot) => unknown;
}): Promise<GoalApiResult> {
  const store = input.store ?? defaultStore;
  const identity = { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd || "/") };
  const judge = { model: input.judgeModel || "настроенная контрольная модель", transport: "configured-openai-compatible", subscription: false };
  if (!HARNESSES.has(input.harness) || !input.sessionId.trim() || !input.cwd.startsWith("/")) return bad("Нужны поддерживаемая среда, точная сессия и абсолютный путь проекта.");
  const adapter = input.adapters.get(input.harness);
  const native = input.harness === "zcode"
    ? (await adapter?.listSessions({ cwd: identity.cwd }))?.find(s => s.id === identity.sessionId)
    : await adapter?.getSession(identity.sessionId);
  if (!native || native.id !== identity.sessionId || native.harness !== identity.harness || resolve(native.cwd) !== identity.cwd
    || (native.hostId && native.hostId.toLowerCase() !== hostname().toLowerCase())) {
    return { status: 409, body: { available: false, error: "Точная сессия на этой машине не подтверждена. Цель не изменена." } };
  }
  let goal: GoalSnapshot | null = await readOptionalGoal(store, identity);
  if (input.method === "GET") return { status: 200, body: { available: true, goal, judge } };
  if (input.method !== "PUT" || !input.sessionStore) return { status: 503, body: { available: false, error: "Управление целью недоступно." } };
  const body = input.body ?? {};
  const action = body.action;
  try {
    if (action !== "stop") {
      const admission = await goalControllerAdmission(native);
      if (!admission.allowed) return bad(admission.reason || "Контроллер цели не подтверждён.");
    }
    if (action === "stop") {
      if (goal) goal = await store.stop(identity);
      await input.sessionStore.set({ ...identity, harness: identity.harness as AutopilotHarness }, false);
    } else if (action === "resume") {
      if (!goal) return bad("Сначала сохраните полную цель.");
      if (await getHumanStopStore().isHeld(identity.harness, identity.sessionId)) return bad("Сессия явно остановлена. Сначала возобновите её штатной кнопкой.");
      goal = await store.resume(identity);
      await input.sessionStore.set({ ...identity, harness: identity.harness as AutopilotHarness }, true);
    } else if (action === "arm" || action === "amend") {
      const text = action === "arm" ? body.objective : body.text;
      if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 128 * 1024) return bad("Введите полную цель или уточнение размером до 128 КиБ.");
      if (typeof body.inputId !== "string" || !body.inputId.trim() || body.inputId.length > 512) return bad("Для сохранения нужен уникальный идентификатор запроса.");
      const eventId = createHash("sha256").update(`human-goal-ui\0${identity.harness}\0${identity.sessionId}\0${body.inputId}`).digest("hex");
      const refs = parseGoalRefs(body.refs);
      if (action === "arm") {
        if (goal) {
          const original = goal.primaryEvents[0];
          if (original?.eventId !== eventId || original.text !== text) return bad("У этой сессии уже есть цель. Добавьте уточнение, сохранив исходное поручение.");
        } else {
          if (await getHumanStopStore().isHeld(identity.harness, identity.sessionId)) return bad("Сессия явно остановлена. Сначала возобновите её штатной кнопкой.");
          const baseline = await adapter?.getSessionMessages?.(identity.sessionId, 1);
          if (!baseline) return bad("Не удалось подтвердить исходное состояние истории этой сессии.");
          const nativeCursor = baseline.at(-1)?.id;
          if (baseline.length && !nativeCursor) return bad("Среда не сообщила точный курсор истории. Цель не включена.");
          goal = await store.arm({ identity, goal: { eventId, text, refs }, requirements: [{ id: "original-goal", text, sourceEventIds: [eventId] }],
            ...(nativeCursor ? { nativeCursor } : {}) });
          await input.sessionStore.set({ ...identity, harness: identity.harness as AutopilotHarness }, true);
        }
      } else {
        if (!goal || !goal.armed) return bad("Сначала включите сохранённую цель этой сессии.");
        const duplicate = goal.primaryEvents.find(e => e.eventId === eventId);
        if (duplicate && duplicate.text !== text) return bad("Идентификатор уже принадлежит другому уточнению.");
        goal = (await store.acceptHumanEvent(identity, { eventId, text, refs })).snapshot;
      }
    } else return bad("Неизвестное действие с целью.");
    let job: unknown;
    if (goal?.armed && !goal.completed && native.status !== "running" && native.status !== "needs_input" && !native.needsPermission && action !== "stop") {
      job = input.kick?.(identity, goal);
    }
    return { status: 200, body: { available: true, goal, judge, ...(job ? { job } : {}) } };
  } catch (error) { return bad(error instanceof Error ? error.message : "Не удалось сохранить цель."); }
}

export async function readOptionalGoal(store: GoalStore, identity: GoalIdentity): Promise<GoalSnapshot | null> {
  try { return await store.snapshot(identity); }
  catch (error) { if (error instanceof Error && error.message === "goal is not armed for this session") return null; throw error; }
}
/** A durable input fence precedes the existing native admission. Agent ingress never calls this. */
export async function recordGoalHumanInput(input: { harness: string; sessionId: string; cwd: string; text: string; inputId?: string; hasImages?: boolean }): Promise<void> {
  const identity = { harness: input.harness, sessionId: input.sessionId, cwd: resolve(input.cwd) };
  const goal = await readOptionalGoal(defaultStore, identity);
  if (!goal?.armed || goal.stopped) return;
  const eventId = `human-message-ui:${input.inputId || randomUUID()}`;
  await defaultStore.acceptHumanEvent(identity, { eventId, text: input.text,
    ...(input.hasImages ? { refs: [{ uri: `herder-image://${encodeURIComponent(input.harness)}/${encodeURIComponent(input.sessionId)}/${encodeURIComponent(eventId)}`, label: "Изображение из пользовательского сообщения; нужен доступ к исходному материалу" }] } : {}),
  });
}
export async function stopGoalForSession(target: { harness: string; sessionId: string; cwd: string }): Promise<void> {
  const goal = await readOptionalGoal(defaultStore, target);
  if (goal && !goal.stopped) await defaultStore.stop(target);
}
function bad(error: string): GoalApiResult { return { status: 400, body: { available: false, error } }; }
function parseGoalRefs(value: unknown): Array<{ uri: string; label?: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("Можно указать до восьми файлов результата.");
  return value.map(item => {
    if (!item || typeof item !== "object" || typeof item.uri !== "string" || item.uri.length > 2048) throw new Error("Неверная ссылка на файл результата.");
    const url = new URL(item.uri);
    if (url.protocol !== "file:" || url.username || url.password || (url.hostname && url.hostname !== "localhost") || url.search || url.hash) throw new Error("Для проверки укажите локальный файл результата.");
    return { uri: url.href, ...(typeof item.label === "string" ? { label: item.label.slice(0, 256) } : {}) };
  });
}
