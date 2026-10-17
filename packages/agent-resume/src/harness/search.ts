import type { HarnessClient, HarnessKind } from "./client.js";
import { OpenCodeClient } from "./opencode/client.js";
import { rankSessions, validateMarker, type SessionCandidate, type SessionSearchCriteria } from "./marker-search.js";
import { claudeSessionSource, codexSessionSource, type SessionSource } from "./session-sources.js";

/**
 * Session discovery: the core answers "which session did you mean?" for every
 * harness it supports, so an orchestrator never repeats that knowledge.
 */
export interface SessionSearchDeps {
  sources: SessionSource[];
  /** Native clients that can add fresh candidates on top of stored sources. */
  clients?: HarnessClient[];
}

export async function searchSessions(deps: SessionSearchDeps, criteria: SessionSearchCriteria & { agent?: string } = {}): Promise<SessionCandidate[]> {
  const marker = criteria.marker ? validateMarker(criteria.marker) : undefined;
  const limit = Math.max(1, Math.min(criteria.limit ?? 20, 200));
  const candidates: SessionCandidate[] = [];
  for (const source of deps.sources) {
    if (criteria.agent && source.agent !== criteria.agent) continue;
    try {
      candidates.push(...await source.list({ cwd: criteria.cwd ?? null, limit, marker: marker ?? null }));
    } catch {
      // One unreadable store must not hide the sessions the other sources know.
    }
  }
  for (const client of deps.clients ?? []) {
    if (criteria.agent && client.kind !== criteria.agent) continue;
    candidates.push(...await listFromClient(client, criteria, marker, limit));
  }
  return rankSessions(candidates, { ...criteria, marker, limit });
}

async function listFromClient(
  client: HarnessClient,
  criteria: SessionSearchCriteria,
  marker: string | undefined,
  limit: number,
): Promise<SessionCandidate[]> {
  try {
    const sessions = await client.listSessions({ cwd: criteria.cwd ?? undefined, limit });
    const candidates: SessionCandidate[] = [];
    for (const session of sessions) {
      const searchableText = marker ? await markerText(client, session.id, marker) : [];
      candidates.push({
        agent: client.kind,
        sessionId: session.id,
        cwd: session.cwd,
        title: session.title,
        updated: session.lastActivity ? Date.parse(session.lastActivity) : null,
        source: `${client.kind}-client`,
        searchableText,
      });
      if (candidates.length >= limit) break;
    }
    return candidates;
  } catch {
    return [];
  }
}

/** Recent user/assistant text of one live session, used only when a marker is given. */
async function markerText(client: HarnessClient, sessionId: string, marker: string): Promise<string[]> {
  try {
    const messages = await client.getMessages(sessionId, 12);
    const hits: string[] = [];
    for (const message of messages ?? []) {
      const text = message.text ?? "";
      if (text.includes(marker)) hits.push(text.slice(0, 500));
    }
    return hits;
  } catch {
    return [];
  }
}

export interface DefaultSearchDepsOptions {
  home?: string;
  opencodeUrl?: string;
  opencodePassword?: string;
  clients?: HarnessClient[];
}

/** Sources and clients for a host, honouring an explicit OpenCode endpoint. */
export function defaultSessionSearchDeps(options: DefaultSearchDepsOptions = {}): SessionSearchDeps {
  const clients: HarnessClient[] = [];
  const opencodeUrl = options.opencodeUrl ?? process.env.OPENCODE_URL;
  if (opencodeUrl) {
    clients.push(new OpenCodeClient({
      baseUrl: opencodeUrl,
      ...(options.opencodePassword ?? process.env.OPENCODE_SERVER_PASSWORD
        ? { password: options.opencodePassword ?? process.env.OPENCODE_SERVER_PASSWORD! }
        : {}),
    }));
  }
  for (const client of options.clients ?? []) clients.push(client);
  return {
    sources: [codexSessionSource(options.home ? { home: options.home } : {}), claudeSessionSource(options.home ? { home: options.home } : {})],
    clients,
  };
}

export const SUPPORTED_SEARCH_AGENTS: readonly HarnessKind[] = ["opencode", "codex", "claude"];