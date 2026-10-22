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
 * the owner named it in the allowlist, and the secrets of the herder are
 * never in it. The values themselves are never written anywhere by this
 * module.
 *
 * REQUIREMENT TO THE CONTOUR OF THE ADAPTERS.
 *
 * The module is the rule of the allowlist, and the rule is not in force
 * while the adapters spawn a process with the whole environment of the
 * herder. Two places do that today, and they are the places that must call
 * this module:
 *
 *   - src/adapters/acp.ts:343 — the process of the adapter of the ACP is
 *     spawned with the environment of the herder;
 *   - src/adapters/fast-agent.ts:157 — the process of the fast agent is
 *     spawned with the environment of the herder.
 *
 * The workload launcher that they share is src/workload-launcher.ts:105: it
 * is the seam where the environment of a spawned process is built, and the
 * allowlist of this module belongs there.
 *
 * The files of the adapters are not the files of this change: the requirement
 * is recorded here so that it lives in the code and not only in the body of
 * a commit. Until the adapters call this module, a spawned agent can still
 * read the secrets of the herder, and the isolation of the secrets of the
 * contour is not in force.
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
