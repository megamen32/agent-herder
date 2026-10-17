import type { HarnessAdapter } from "./types/index.js";

/**
 * Session identity: what a session is called, and how it is addressed.
 *
 * Agent Herder announces this to a session it creates, so an OpenCode 2 agent
 * knows its own name, id and workspace from the first turn instead of guessing.
 * `announce` re-publishes it on demand — for a session created by hand, or after
 * a harness upgrade where the identity entry does not exist yet.
 */
export interface SessionIdentityRequest {
  sessionId: string;
  name?: string;
  announce?: boolean;
}

export interface SessionIdentityResult {
  sessionId: string;
  harness: string;
  name: string;
  cwd: string;
  status?: string;
  /** True when the identity is now part of the session's own instructions. */
  announced?: boolean;
  /** Why an announcement did not happen, when it did not. */
  reason?: string;
}

interface IdentityCapableAdapter extends HarnessAdapter {
  announceIdentity?(input: { name?: string; sessionId: string; cwd?: string }): Promise<boolean>;
  identityOf?(sessionId: string): Promise<{ name: string; sessionId: string; harness: string; cwd: string } | null>;
}

export async function sessionIdentity(
  adapter: HarnessAdapter,
  request: SessionIdentityRequest,
): Promise<SessionIdentityResult | null> {
  const session = await adapter.getSession(request.sessionId).catch(() => null);
  if (!session || session.id !== request.sessionId) return null;

  const result: SessionIdentityResult = {
    sessionId: session.id,
    harness: session.harness,
    name: request.name?.trim() || session.title,
    cwd: session.cwd,
    status: session.status,
  };

  if (!request.announce) return result;

  const capable = adapter as IdentityCapableAdapter;
  if (!capable.announceIdentity) {
    return { ...result, announced: false, reason: `${adapter.name} has no native session-identity channel; send the identity in the first message instead` };
  }
  try {
    const announced = await capable.announceIdentity({ name: result.name, sessionId: session.id, cwd: session.cwd });
    return { ...result, announced, ...(announced ? {} : { reason: "the harness did not accept a session identity" }) };
  } catch (error) {
    return { ...result, announced: false, reason: error instanceof Error ? error.message : String(error) };
  }
}