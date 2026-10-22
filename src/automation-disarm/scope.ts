import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { parseWorkKey } from "./work-key.js";

/**
 * The catch-all scope.
 *
 * A record with this scope covers every automatic launch, whatever project the
 * request comes from. It is the coarse half of the lever: a project scope is a
 * finer boundary inside it, and a finer boundary wins.
 */
export const ALL_SCOPES = "*";

/**
 * The canonical form of one scope path.
 *
 * The owner names a project by its path, and the runtime names it by the
 * canonical directory of the request. Both sides are brought to the same
 * canonical form before they are compared, so a symlinked path and its target
 * are one scope and not two. A path that does not exist yet is kept as the
 * absolute path it already is: the owner may forbid a project before its
 * directory is created.
 */
export async function canonicalScopePath(path: string): Promise<string> {
  const absolute = isAbsolute(path) ? path : resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    return absolute.replace(/\/+$/, "") || sep;
  }
}

/**
 * Does one scope cover one directory?
 *
 * The scope is the root of a project, so the directory of the request is
 * covered when it is the scope itself or lies inside it. The catch-all scope
 * covers everything.
 */
export function scopeCovers(scope: string, directory: string | undefined): boolean {
  if (scope === ALL_SCOPES) return true;
  if (!directory) return false;
  if (directory === scope) return true;
  const root = scope.endsWith(sep) ? scope : `${scope}${sep}`;
  return directory.startsWith(root);
}

/**
 * The directory one work key belongs to.
 *
 * A named session carries its canonical working directory, and a project
 * dispatch carries the project path. Both are the project a run belongs to,
 * which is what a scope is about: the lever is addressed by project and
 * directory, never by session id.
 */
export function workKeyDirectory(workKey: string): string | undefined {
  const parsed = parseWorkKey(workKey);
  if (!parsed) return undefined;
  if (parsed.kind === "session") return parsed.cwd || undefined;
  return parsed.project || undefined;
}

/**
 * The scope one work key belongs to.
 *
 * A session key belongs to the scope of its working directory. A project key
 * belongs to the scope of the project path, when the project is named by a
 * path. A project that is named by a name and not by a path has no directory
 * of its own, so it belongs to the catch-all scope.
 */
export function scopeOfWorkKey(workKey: string): string {
  const parsed = parseWorkKey(workKey);
  if (!parsed) return ALL_SCOPES;
  if (parsed.kind === "session") return parsed.cwd || ALL_SCOPES;
  return isAbsolute(parsed.project) ? parsed.project : ALL_SCOPES;
}

/**
 * How specific one scope is.
 *
 * The catch-all scope is the least specific one, and a path is more specific
 * the deeper it lies. Two records of one scope are ordered by their work keys:
 * a record that names exact works is the finer boundary of the two.
 */
export function scopeSpecificity(scope: string, hasWorkKeys: boolean): number {
  const byScope = scope === ALL_SCOPES ? 0 : scope.length;
  return byScope * 2 + (hasWorkKeys ? 1 : 0);
}
