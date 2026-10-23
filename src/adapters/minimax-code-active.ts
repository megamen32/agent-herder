import type { AgentSession } from "../types/index.js";
import { localSessionHostId } from "../types/index.js";
import type { MinimaxCodeControl } from "./minimax-code-control.js";

export interface MinimaxActiveReceipt {
  exhaustive: boolean;
  observedAt: string;
  expiresAt: string;
  source: "minimax-native-runtime-status";
  totalSessions: number;
  pages: number;
}
interface NativeSession {
  session_id: string; agent_name?: string; title?: string; workspace_dir?: string;
  parent_session_id?: string; updated_at?: number; created_at?: number;
  status?: { status_type?: number; error_code?: number };
  model?: { model_id?: string };
}
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("minimax_active_response_invalid");
  return value as Record<string, any>;
};

/** Metadata only: native Started is the GUI's busy state, even with retained error fields. */
export async function readMinimaxActiveSessions(control: Pick<MinimaxCodeControl, "call">): Promise<{ sessions: AgentSession[]; receipt: MinimaxActiveReceipt }> {
  const request = async (path: string) => {
    const response = await control.call("GET", path);
    if (!response.ok) throw new Error(response.error || "minimax_active_runtime_unavailable");
    return object(response.body);
  };
  const owners = await request("/agent");
  if (!Array.isArray(owners.agents)) throw new Error("minimax_active_agents_invalid");
  const rows = new Map<string, NativeSession>();
  let pages = 0;
  await Promise.all(owners.agents.map(async (owner: unknown) => {
    const name = object(owner).name;
    if (typeof name !== "string" || !name) throw new Error("minimax_active_agent_invalid");
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "200", include_hidden: "true" });
      if (cursor) query.set("cursor", cursor);
      const page = await request(`/agent/${encodeURIComponent(name)}/session?${query}`);
      pages += 1;
      if (!Array.isArray(page.sessions) || typeof page.has_more !== "boolean") throw new Error("minimax_active_page_invalid");
      for (const row of page.sessions) {
        const session = object(row) as NativeSession;
        if (typeof session.session_id !== "string" || !session.session_id) throw new Error("minimax_active_identity_invalid");
        if (!session.status || ![0, 1, 2, 3].includes(session.status.status_type!)) throw new Error("minimax_active_status_unknown");
        rows.set(session.session_id, session);
      }
      cursor = page.has_more ? page.next_cursor : undefined;
      if (page.has_more && (typeof cursor !== "string" || !cursor || seen.has(cursor))) throw new Error("minimax_active_cursor_invalid");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }));
  const observedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 15_000).toISOString();
  const receipt: MinimaxActiveReceipt = { exhaustive: true, observedAt, expiresAt, source: "minimax-native-runtime-status", totalSessions: rows.size, pages };
  const sessions: AgentSession[] = [...rows.values()].filter(row => row.status?.status_type === 1).map(row => ({
    id: row.session_id, harness: "minimax-code", title: row.title || row.session_id,
    status: "running", cwd: row.workspace_dir || "", hostId: localSessionHostId(),
    lastActivity: new Date(row.updated_at || row.created_at || 0).toISOString(),
    needsPermission: false, model: row.model?.model_id,
    lineage: { kind: row.parent_session_id ? "subagent" : "root", ...(row.parent_session_id ? { parentId: row.parent_session_id } : {}), role: row.agent_name },
    meta: { activityEvidence: receipt.source, activityObservedAt: observedAt, activityExpiresAt: expiresAt,
      liveStatus: "running", nativeStatusType: 1, nativeAgentName: row.agent_name,
      ...(row.parent_session_id ? { parentSessionId: row.parent_session_id, lineageKind: "subagent" } : { lineageKind: "root" }),
      ...(row.status?.error_code === undefined ? {} : { retainedNativeErrorCode: row.status.error_code }) },
  }));
  return { sessions, receipt };
}
