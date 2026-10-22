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
