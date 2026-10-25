import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../types/index.js";
import { localSessionHostId } from "../types/index.js";

/**
 * Runtime-state proof of MiniMax Code activity.
 *
 * The desktop app publishes its live runtime on a loopback transport, and that
 * transport is the primary proof of an active turn. A host that runs the
 * MiniMax Code runtime without the desktop app (a fleet node that executes
 * turns for other machines) has no such transport: the transport is not
 * published there, so the controller cannot confirm anything.
 *
 * That host still owns the truth about its own turns. The runtime writes a
 * turn lease into its own state before it executes a turn, renews it while the
 * turn runs, and releases it when the turn ends. A live lease plus an open
 * admitted turn plus an unfinished turn state is execution proof that comes
 * from the runtime itself, not from a queued request or from a GUI that
 * optimistically loaded a session.
 *
 * The lease names its owner process, so a lease of a runtime that died is not
 * mistaken for a running turn.
 */

/** State file of the local MiniMax Code runtime. */
export const minimaxRuntimeStatePath = () =>
  process.env.MINIMAX_CODE_RUNTIME_DB || join(homedir(), ".minimax/v2/sqlite/runtime-state.sqlite");

/** Upper bound of the published goal text. */
const MAX_GOAL_LENGTH = 160;

/** A prompt that opens with an instruction of the system, not with the request of the user. */
const SYSTEM_PROMPT_MARKER = /^\s*(?:\[system\]|<system>)/i;

/** The marker that opens the part of the prompt that belongs to the user. */
const USER_PART_MARKER = /^\s*\[user\]\s*$/i;

/** The marker that names the current request inside the part of the user. */
const CURRENT_REQUEST_MARKER = /^\s*Текущая реплика:\s*/im;

/** Blocks that carry context for the model, not the request of the user. */
const SERVICE_BLOCK_MARKER =
  /^(?:Частичная сохранённая память|Частичные L2-сводки|Предыдущий собственный разговор|Предыдущие реплики)/i;

export interface MinimaxRuntimeActiveRow {
  session_id: string;
  owner_id: string;
  expires_at_ms: number;
  title: string | null;
  workspace_dir: string | null;
  parent_session_id: string | null;
  agent_name: string | null;
  updated_at_ms: number | null;
  created_at_ms: number | null;
  open_ingress: number;
  open_agent_state: number;
}

export interface MinimaxRuntimeActiveProof {
  sessions: AgentSession[];
  /** Live leases of the runtime state. */
  leaseCount: number;
  /** Leases whose owner process could not be proven alive. */
  unprovenLeaseCount: number;
  observedAt: string;
  expiresAt: string;
}

/** The lease owner is the runtime process that executes the turn. */
function leaseOwnerPid(ownerId: string): number | null {
  const match = /^turn-lease:(\d+):/.exec(ownerId);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** A process that may not be signalled still exists; only ESRCH means death. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One readable line out of a text, bounded by the published goal length. */
function flattenGoal(text: string): string {
  const flat = text.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > MAX_GOAL_LENGTH ? `${flat.slice(0, MAX_GOAL_LENGTH - 1)}…` : flat;
}

/** The blocks of the user part of a prompt, split at the user marker. */
function userBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (USER_PART_MARKER.test(line)) {
      if (current.length) blocks.push(current);
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length) blocks.push(current);
  return blocks;
}

/** The request of the user inside the blocks of the user part of a prompt. */
function goalFromUserBlocks(blocks: string[][]): string {
  // The current request wins over every context block that only feeds the model.
  for (const block of blocks) {
    const text = block.join("\n");
    const current = CURRENT_REQUEST_MARKER.exec(text);
    if (!current) continue;
    const goal = flattenGoal(text.slice(current.index + current[0].length));
    if (goal) return goal;
  }
  for (const block of blocks) {
    const text = block.join("\n").trim();
    if (!text) continue;
    if (SERVICE_BLOCK_MARKER.test(text)) continue;
    if (/^[[{]/.test(text)) continue;
    const goal = flattenGoal(text);
    if (goal) return goal;
  }
  return "";
}

/**
 * The goal of a session is the request of the user, never the instruction of the system.
 *
 * A prompt that opens with a system instruction carries the request of the user
 * after the user marker. The system part is dropped, so what the panel shows is
 * what the person asked and not the instruction that opened the session.
 */
function goalFromMessage(content: string): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (!SYSTEM_PROMPT_MARKER.test(lines[0] ?? "")) return flattenGoal(lines.join("\n"));
  const userStart = lines.findIndex((line) => USER_PART_MARKER.test(line));
  if (userStart < 0) {
    // No user part: the prompt holds nothing but the instruction of the system.
    const current = CURRENT_REQUEST_MARKER.exec(lines.join("\n"));
    return current ? flattenGoal(lines.join("\n").slice(current.index + current[0].length)) : "";
  }
  return goalFromUserBlocks(userBlocks(lines.slice(userStart + 1)));
}

/** Goal of a session without a title: the prompt that opened the session. */
function readGoal(db: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } }, sessionId: string): string {
  try {
    const row = db
      .prepare(
        "select data_json as data_json from local_runtime_message_rows where session_id = ? and role = 'user' order by created_at_ms asc limit 1",
      )
      .get(sessionId) as { data_json?: string } | undefined;
    if (!row?.data_json) return "";
    const parsed = JSON.parse(row.data_json) as { msg_content?: unknown };
    return typeof parsed.msg_content === "string" ? goalFromMessage(parsed.msg_content) : "";
  } catch {
    return "";
  }
}

/**
 * Read the sessions whose turn the local runtime is executing right now.
 *
 * The state file is opened read-only and never written. A missing table or an
 * unreadable file throws, so the caller can tell "no proof" from "no activity".
 */
export async function readMinimaxRuntimeActiveSessions(
  path = minimaxRuntimeStatePath(),
  options: { now?: number } = {},
): Promise<MinimaxRuntimeActiveProof> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  const now = options.now ?? Date.now();
  try {
    const selected = db.prepare(
      `select l.session_id as session_id, l.owner_id as owner_id, l.expires_at_ms as expires_at_ms,
              s.title as title, s.workspace_dir as workspace_dir, s.parent_session_id as parent_session_id,
              s.agent_name as agent_name, s.updated_at_ms as updated_at_ms, s.created_at_ms as created_at_ms,
              (select count(*) from local_runtime_turn_ingress i
                where i.session_id = l.session_id and i.status = 'accepted' and i.completed_at_ms is null) as open_ingress,
              (select count(*) from local_runtime_session_agent_state a
                where a.session_id = l.session_id and a.terminal_outcome is null) as open_agent_state
         from local_runtime_session_locks l
         left join local_runtime_sessions s on s.session_id = l.session_id
        where l.owner_kind = 'turn' and l.expires_at_ms > ?`,
    ).all(now) as unknown as MinimaxRuntimeActiveRow[];
    const observedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 15_000).toISOString();
    const sessions: AgentSession[] = [];
    let unprovenLeaseCount = 0;
    for (const row of selected) {
      // An admitted turn alone is a candidate; the lease is the execution proof.
      if (row.open_ingress < 1 || row.open_agent_state < 1) continue;
      const pid = leaseOwnerPid(row.owner_id);
      if (pid === null || !processAlive(pid)) {
        unprovenLeaseCount += 1;
        continue;
      }
      // A stored title that opens with a system instruction is not the goal of
      // the session, so the goal is read from the first message of the user.
      const storedTitle = row.title?.trim() || "";
      const titleIsSystem = SYSTEM_PROMPT_MARKER.test(storedTitle);
      const goal = !titleIsSystem && storedTitle ? storedTitle : readGoal(db as never, row.session_id);
      const goalSource = !titleIsSystem && storedTitle ? "runtime_state" : "runtime_first_message";
      sessions.push({
        id: row.session_id, harness: "minimax-code", title: goal || row.session_id,
        status: "running", cwd: row.workspace_dir || "", hostId: localSessionHostId(),
        lastActivity: new Date(row.updated_at_ms || row.created_at_ms || now).toISOString(),
        needsPermission: false,
        meta: {
          activityEvidence: "native_runtime_turn_lease", activityObservedAt: observedAt, activityExpiresAt: expiresAt,
          liveStatus: "running", nativeAgentName: row.agent_name,
          ...(row.parent_session_id ? { parentSessionId: row.parent_session_id, lineageKind: "subagent" } : { lineageKind: row.agent_name ? "root" : "unknown" }),
          ...(goal ? { goalSource } : { metadataUnavailable: true }),
        },
      });
    }
    return { sessions, leaseCount: selected.length, unprovenLeaseCount, observedAt, expiresAt };
  } finally {
    db.close();
  }
}
