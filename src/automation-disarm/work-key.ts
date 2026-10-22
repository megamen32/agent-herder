/**
 * The logical work identity of one agent run.
 *
 * A native session id cannot identify the work: a re-dispatch of the same
 * card mints a fresh id for the same logical work, and `operation_id` is
 * minted fresh for every POST, so neither survives a retry. A work is
 * therefore addressed by the named-session identity `harness\0cwd\0name`,
 * exactly what `named-session.ts` uses, or by the canonical project key when
 * the run is a project dispatch whose session name is derived from the
 * operation id. A repeat of the same work under a new session id resolves to
 * the same key and stays blocked.
 */

/** The logical work key of one named-session run. */
export function sessionWorkKey(harness: string, name: string, cwd: string): string {
  return `${harness}\u0000${cwd}\u0000${name}`;
}

/** The logical work key of one project, independent of any session id. */
export function projectWorkKey(project: string): string {
  return `project\u0000${project}`;
}

/** The parsed shape of a work key, for owner-facing input and diagnostics. */
export type WorkKey =
  | { kind: "session"; harness: string; cwd: string; name: string }
  | { kind: "project"; project: string };

/**
 * Read an owner-supplied work key and bring it to the canonical form.
 *
 * Two shapes are accepted on input. The canonical one is the durable form
 * with real NUL separators, `harness\0cwd\0name` or `project\0key`. The
 * readable one is `harness|cwd|name` or `project|<canonicalProjectKey>`, so an
 * owner does not have to type a NUL byte. Both produce the same canonical key,
 * and the durable file always stores the canonical form.
 */
export function normalizeWorkKeyInput(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  // The canonical form is already canonical.
  if (trimmed.includes("\u0000")) return trimmed;
  const parts = trimmed.split("|");
  if (parts.length === 2 && parts[0]!.trim() === "project") {
    const project = parts[1]!.trim();
    return project ? projectWorkKey(project) : undefined;
  }
  if (parts.length >= 3) {
    const harness = parts[0]!.trim();
    const name = parts[parts.length - 1]!.trim();
    // A workspace path may contain a separator, so only the edges are fixed.
    const cwd = parts.slice(1, -1).join("|").trim();
    if (!harness || !cwd || !name) return undefined;
    return sessionWorkKey(harness, name, cwd);
  }
  return undefined;
}

/** Read a work key back, or `undefined` when the string is not one. */
export function parseWorkKey(workKey: string): WorkKey | undefined {
  const parts = workKey.split("\u0000");
  if (parts.length === 3) {
    return { kind: "session", harness: parts[0] ?? "", cwd: parts[1] ?? "", name: parts[2] ?? "" };
  }
  if (parts.length === 2 && parts[0] === "project") {
    return { kind: "project", project: parts[1] ?? "" };
  }
  return undefined;
}
