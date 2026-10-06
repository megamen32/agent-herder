import { randomUUID } from "node:crypto";
import type { AgentSession, HarnessAdapter } from "./types/index.js";
import { getHumanStopStore } from "./human-stop-store.js";

export const HUMAN_STOP_MESSAGE = "Чат явно остановлен. Автопродолжение заблокировано; требуется новое сообщение человека или явное продолжение.";

export async function automaticDeliveryHeld(session: AgentSession, humanRequested = false, adapter?: HarnessAdapter): Promise<boolean> {
  if (session.harness !== "codex" && session.harness !== "zcode") return false;
  const store = getHumanStopStore();
  const current = adapter ? await adapter.getSession(session.id) : undefined;
  await store.observe(current ?? session);
  if (humanRequested) await store.release(session.harness, session.id);
  return store.isHeld(session.harness, session.id);
}

export async function holdManualStop(session: AgentSession): Promise<void> {
  if (session.harness !== "codex" && session.harness !== "zcode") return;
  const turnId = typeof session.meta?.activeTurnId === "string" ? session.meta.activeTurnId
    : typeof session.meta?.nativeTurnId === "string" ? session.meta.nativeTurnId : undefined;
  await getHumanStopStore().hold(session, {
    id: `explicit-stop:${randomUUID()}`, at: new Date().toISOString(), reason: "explicit-stop", ...(turnId ? { turnId } : {}),
  });
}
