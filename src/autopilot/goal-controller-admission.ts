import { dirname, join } from "node:path";
import type { AgentSession } from "../types/index.js";

/** Read-only exact-thread check. A native Goal is an active controller, not transport. */
export async function goalControllerAdmission(session: AgentSession): Promise<{ allowed: boolean; reason?: string }> {
  if (session.harness === "opencode" || session.harness === "zcode") return { allowed: true };
  if (session.harness !== "codex") return { allowed: false, reason: "Для этой среды ещё не подтверждён единственный контроллер полной цели." };
  const indexPath = session.meta?.sessionIndexPath;
  if (typeof indexPath !== "string" || !indexPath.startsWith("/")) return { allowed: false, reason: "Не подтверждён источник состояния native Goals этой Codex-сессии." };
  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(join(dirname(indexPath), "state_5.sqlite"), { readOnly: true });
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_goals'").get();
    if (!exists) return { allowed: true };
    const goal = db.prepare("SELECT status FROM thread_goals WHERE thread_id=?").get(session.id);
    if (!goal || goal.status === "completed") return { allowed: true };
    return { allowed: false, reason: "У сессии есть native Codex Goal. Одновременное управление двумя автопилотами запрещено; существующая цель сохранена." };
  } catch { return { allowed: false, reason: "Не удалось проверить native Goals. Продолжение не запущено." }; }
  finally { db?.close(); }
}
