/**
 * The environment that a harness process may see.
 *
 * A harness process is spawned with the environment of the herder, and the
 * environment of the herder carries the secrets of the contour: the token of
 * the lever of the owner, the tokens of the connections of the other
 * products, the keys of the providers. A spawned agent must not see them: the
 * right to use a key is not the right to read it.
 *
 * The rule is deny by default. A variable reaches a spawned process only when
 * the owner named it in the allowlist, or when the caller of the spawn named
 * it on purpose; the secrets of the herder are never in it. The values
 * themselves are never written anywhere by this module.
 *
 * THE SEAM WHERE THE RULE IS IN FORCE.
 *
 * The module is the rule of the allowlist, and the rule is in force at the
 * seam that builds the environment of a spawned process:
 *
 *   - src/workload-launcher.ts — buildDetachedWorkloadCommand, the launcher
 *     that every adapter shares (src/adapters/acp.ts:340,
 *     src/adapters/fast-agent.ts:155, src/adapters/codex-app-server.ts:2073
 *     and the other callers of the launcher).
 *
 * The launcher calls this module for every workload it spawns, so the
 * adapters do not have to call it themselves: a spawned agent sees the names
 * of the allowlist and never the secrets of the herder. The owner names the
 * allowlist, and the rule of the deny wins over what the owner names.
 */

/** The names that never reach a spawned process, whatever the allowlist says. */
export const ALWAYS_FORBIDDEN_ENV: readonly string[] = [
  "AGENT_HERDER_DISARM_TOKEN",
  "NOTICEPLACE_HEALTH_LAUNCH_TOKEN",
  "NOTIFY_CENTER_TOKEN",
  "NOTIFY_CENTER_EVENT_URL",
  "NOTIFY_CENTER_PROJECT",
  "NOTIFY_CENTER_RECIPIENT",
  "AGENT_RESUME_HERMES_TOKEN",
  "AGENT_RESUME_HERMES_ENDPOINT",
  "OMNIROUTE_API_KEY",
  "MINIMAX_API_KEY",
  "MCP_TELEGRAM_BEARER",
  "SSS_API_KEY",
];

/** The names that reach a spawned process when the owner allows them. */
export const DEFAULT_ALLOWED_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "TZ",
  "SHELL",
  "USER",
  "AGENT_HERDER_WEB_HOST",
  "AGENT_HERDER_WEB_PORT",
];

/**
 * The environment of a spawned process.
 *
 * Only the names of the allowlist pass. The secrets of the contour never
 * pass, even when the allowlist names them: the rule of the deny wins.
 */
export function harnessEnv(
  source: Record<string, string | undefined>,
  allowed: readonly string[] = DEFAULT_ALLOWED_ENV,
): Record<string, string> {
  const permitted = new Set(allowed);
  const forbidden = new Set(ALWAYS_FORBIDDEN_ENV);
  const result: Record<string, string> = {};
  for (const name of Object.keys(source)) {
    if (forbidden.has(name)) continue;
    if (!permitted.has(name)) continue;
    const value = source[name];
    if (value === undefined) continue;
    result[name] = value;
  }
  return result;
}

/**
 * The environment of a spawned process, built from two sources.
 *
 * `background` is the environment of the herder that a workload would
 * inherit: only the names of the allowlist pass it. The secrets of the herder
 * are in the background, and they never pass.
 *
 * `caller` is the environment that the caller of the spawn built on purpose.
 * Its names pass even when the allowlist does not name them, because the
 * caller named them on purpose: the data home of a project app-server
 * (CODEX_HOME) is such a name, and the seam must not take it away from the
 * process that has to use it.
 *
 * The rule of the deny wins over both: a name of ALWAYS_FORBIDDEN_ENV never
 * reaches a spawned process, not even when the caller set it.
 */
export function harnessWorkloadEnv(
  background: NodeJS.ProcessEnv,
  caller?: NodeJS.ProcessEnv,
  allowed: readonly string[] = DEFAULT_ALLOWED_ENV,
): Record<string, string> {
  const forbidden = new Set(ALWAYS_FORBIDDEN_ENV);
  const permitted = new Set(allowed);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(caller ?? background)) {
    if (value === undefined) continue;
    if (forbidden.has(name)) continue;
    if (permitted.has(name)) {
      result[name] = value;
      continue;
    }
    // A name that the caller changed against the background is the caller's own.
    if (background[name] !== value) result[name] = value;
  }
  return result;
}

/**
 * The names of the allowlist that the owner named and that are allowed.
 *
 * The answer names the variables, never their values: the panel shows what
 * a spawned process will see without showing what it is.
 */
export function harnessEnvNames(
  allowed: readonly string[] = DEFAULT_ALLOWED_ENV,
): { allowed: string[]; refused: string[] } {
  const forbidden = new Set(ALWAYS_FORBIDDEN_ENV);
  return {
    allowed: allowed.filter((name) => !forbidden.has(name)),
    refused: allowed.filter((name) => forbidden.has(name)),
  };
}
