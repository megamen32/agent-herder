/**
 * Marker search: pick the one native session an orchestrator meant.
 *
 * The marker is a short correlation string the model invents and quotes back, so
 * a resume never guesses between same-titled sessions. Selection and scoring
 * live here, in the core; where the candidate records come from is the caller's
 * business.
 */
export const MARKER_PATTERN = /^[A-Za-z0-9]{5}$/;

export function validateMarker(marker: unknown, options: { required?: boolean } = {}): string | undefined {
  if (marker === undefined || marker === null || String(marker).trim() === "") {
    if (options.required) {
      throw new Error("marker is required unless session_id is explicit. Pass exactly 5 ASCII alphanumeric chars, e.g. A7kQ2.");
    }
    return undefined;
  }
  const value = String(marker).trim();
  if (!MARKER_PATTERN.test(value)) throw new Error("marker must be exactly 5 ASCII alphanumeric chars [A-Za-z0-9]");
  return value;
}

export function textHas(needle: string | undefined | null, ...values: unknown[]): boolean {
  if (!needle) return false;
  const wanted = String(needle).toLowerCase();
  return values.some((value) => (value === undefined || value === null ? "" : String(value)).toLowerCase().includes(wanted));
}

/** A marker hit outweighs any number of text hits: it is the exact intent. */
export function matchScore(query: string | undefined | null, marker: string | undefined | null, ...values: unknown[]): number {
  let score = 0;
  if (marker && textHas(marker, ...values)) score += 100;
  if (query && textHas(query, ...values)) score += 10;
  return score;
}

export interface SessionCandidate {
  agent: string;
  sessionId: string;
  cwd?: string | null;
  title?: string | null;
  updated?: number | null;
  source?: string | null;
  /** Free-form text the marker may appear in: recent user/assistant bodies. */
  searchableText?: string[];
  extra?: Record<string, unknown>;
  score?: number;
}

export interface SessionSearchCriteria {
  /** Working directory to scope the search to. */
  cwd?: string | null;
  query?: string | null;
  marker?: string | null;
  limit?: number;
}

/**
 * Score, filter and order candidates.
 *
 * Ordering is score first, then recency: a marker match always wins, and among
 * equally confident matches the most recent chat is the one being continued.
 */
export function rankSessions(candidates: SessionCandidate[], criteria: SessionSearchCriteria = {}): SessionCandidate[] {
  const marker = criteria.marker ? validateMarker(criteria.marker) : undefined;
  const limit = Math.max(1, Math.min(criteria.limit ?? 20, 200));
  const scoped = criteria.cwd
    ? candidates.filter((candidate) => !candidate.cwd || sameDirectory(candidate.cwd, criteria.cwd!))
    : candidates;
  const scored = scoped.map((candidate) => {
    const score = matchScore(criteria.query ?? undefined, marker, candidate.title, candidate.cwd, ...(candidate.searchableText ?? []));
    return { ...candidate, score };
  });
  const matched = scored.filter((candidate) => {
    if (marker || criteria.query) return (candidate.score ?? 0) > 0;
    return true;
  });
  matched.sort((left, right) => {
    const byScore = (right.score ?? 0) - (left.score ?? 0);
    if (byScore !== 0) return byScore;
    return (right.updated ?? 0) - (left.updated ?? 0);
  });
  return matched.slice(0, limit);
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => (value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value);
  return normalize(left) === normalize(right);
}

/** The prompt a resumed session receives after a watched job finished. */
export function defaultJobResumePrompt(context: {
  jobId?: string | null;
  logFile?: string | null;
  note?: string | null;
  marker?: string | null;
  state?: string | null;
  returncode?: number | null;
  calledAtMs?: number | null;
}): string {
  const parts = ["Background job finished. Resume the previous task and continue from the result."];
  if (context.marker) parts.push(`Marker: ${context.marker}`);
  if (context.calledAtMs) parts.push(`MCP called_at_ms: ${context.calledAtMs}`);
  if (context.note) parts.push(`Note: ${context.note}`);
  if (context.jobId) parts.push(`Job id: ${context.jobId}`);
  if (context.state) parts.push(`State: ${context.state}`);
  if (context.returncode !== undefined && context.returncode !== null) parts.push(`Return code: ${context.returncode}`);
  if (context.logFile) {
    parts.push(`Log file: ${context.logFile}`);
    parts.push("Inspect the log/status as needed; do not repeat work already completed.");
  }
  return parts.join("\n");
}