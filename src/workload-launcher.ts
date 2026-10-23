import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DEFAULT_ALLOWED_ENV, harnessWorkloadEnv } from "./web/settings-harness-env.js";

export interface DetachedWorkloadOptions extends SpawnOptions {
  /** Short harness/workload label used only for the transient systemd scope name. */
  label: string;
  /** Optional systemd scope limits for a bounded child workload. */
  resourceProperties?: string[];
  /** Mandatory Linux guard for the shared ZCode SDK/native descendant tree. */
  resourceGuard?: "zcode-shared";
  /**
   * The names of the variables that a spawned workload is allowed to see.
   * The default is the allowlist of the product; the secrets of the herder
   * never pass, whatever this list names.
   */
  allowedEnv?: readonly string[];
}

export interface IsolatedWorkloadCommand {
  command: string;
  args: string[];
  options: SpawnOptions;
  unitName?: string;
  isolated: boolean;
}


/** Reviewed shared native-tree budget; swap is temporary until the host swapoff rollout. */
export const ZCODE_SHARED_RESOURCE_PROPERTIES = [
  "MemoryHigh=32212254720", "MemoryMax=36507222016", "MemorySwapMax=2147483648",
  "CPUQuota=1600%", "TasksMax=4096",
];

/** Runs inside the requested scope, before any SDK/native payload is executed. */
export const ZCODE_SHARED_RESOURCE_CHECK = `
fail() { printf '%s\\n' 'ZCode resource guard unavailable or mismatched' >&2; exit 75; }
group=
while IFS=: read -r hierarchy controllers candidate; do
  if [ "$hierarchy" = 0 ] && [ -z "$controllers" ]; then group=$candidate; fi
done < /proc/self/cgroup
case "$group" in /*) ;; *) fail ;; esac
case "$group" in *..*) fail ;; esac
base=/sys/fs/cgroup$group
read -r high < "$base/memory.high" || fail
read -r maximum < "$base/memory.max" || fail
read -r swap < "$base/memory.swap.max" || fail
read -r tasks < "$base/pids.max" || fail
read -r quota period < "$base/cpu.max" || fail
[ "$high" = 32212254720 ] && [ "$maximum" = 36507222016 ] &&
[ "$swap" = 2147483648 ] && [ "$tasks" = 4096 ] || fail
[ "$period" -gt 0 ] && [ "$quota" -gt 0 ] &&
case "$quota:$period" in *[!0-9:]*|:*|*:) fail ;; esac
[ "$period" -gt 0 ] && [ "$quota" -gt 0 ] &&
[ "$quota" -le "$((period * 16))" ] || fail
exec "$@"
`;

function runtimeBusEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined) return env;
  const runtime = env.XDG_RUNTIME_DIR || `/run/user/${uid}`;
  return {
    ...env,
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtime}/bus`,
  };
}

/**
 * The names that runtimeBusEnv owns: the bus of the user session, through
 * which a workload talks back to the herder. They pass the filter of the
 * allowlist, and the rule of the deny still wins over them.
 */
const RUNTIME_BUS_ENV_NAMES = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

/**
 * The environment of a spawned workload.
 *
 * The background of the herder is filtered by the allowlist of the product,
 * and the names that the caller of the spawn set on purpose are kept: the
 * data home of a project app-server (CODEX_HOME) is one of them, and the
 * project app-server must not fall back to the data home of the herder. The
 * secrets of the herder never pass, not even when the caller named them.
 */
function workloadEnv(
  source: NodeJS.ProcessEnv | undefined,
  allowed: readonly string[],
): Record<string, string> {
  return harnessWorkloadEnv(process.env, source ?? process.env, [...allowed, ...RUNTIME_BUS_ENV_NAMES]);
}

function safeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workload";
}

export function buildDetachedWorkloadCommand(
  command: string,
  args: string[],
  options: DetachedWorkloadOptions,
): IsolatedWorkloadCommand {
  const { label, env, resourceProperties = [], resourceGuard, allowedEnv = DEFAULT_ALLOWED_ENV, ...spawnOptions } = options;
  const isolationDisabled = process.env.AGENT_HERDER_WORKLOAD_ISOLATION === "off" || process.env.VITEST === "true";
  if (resourceGuard && (isolationDisabled || process.platform !== "linux")) {
    throw new Error("ZCode shared resource guard requires Linux systemd isolation");
  }
  if (resourceGuard && resourceProperties.length) {
    throw new Error("ZCode shared resource guard does not accept budget overrides");
  }
  if (isolationDisabled || process.platform !== "linux") {
    return {
      command,
      args,
      options: { ...spawnOptions, env: workloadEnv(env, allowedEnv), detached: true, stdio: spawnOptions.stdio ?? "ignore" },
      isolated: false,
    };
  }

  const unitName = `agent-herder-${safeLabel(label)}-${randomUUID().slice(0, 8)}`;
  return {
    command: "systemd-run",
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${unitName}`,
      ...(resourceGuard ? ZCODE_SHARED_RESOURCE_PROPERTIES : resourceProperties)
        .flatMap((property) => ["--property", property]),
      ...(resourceGuard
        ? ["/bin/sh", "-c", ZCODE_SHARED_RESOURCE_CHECK, "zcode-resource-guard", command, ...args]
        : [command, ...args]),
    ],
    options: {
      ...spawnOptions,
      env: workloadEnv(runtimeBusEnv(env ?? process.env), allowedEnv),
      detached: true,
      stdio: spawnOptions.stdio ?? "ignore",
    },
    unitName: `${unitName}.scope`,
    isolated: true,
  };
}

/**
 * Launch a fire-and-forget agent workload in its own transient user scope.
 * This keeps long-running agent descendants (including docker/pytest trees)
 * outside agent-herder.service's control group, so restarting Herder does not
 * block on or kill independently running work.
 */
export function spawnDetachedWorkload(
  command: string,
  args: string[],
  options: DetachedWorkloadOptions,
): ChildProcess {
  const child = spawnIsolatedWorkload(command, args, options);
  child.unref();
  return child;
}

/**
 * Launch an adapter-owned process in an independent transient scope while
 * retaining its stdio and lifecycle handle. Persistent app servers must not
 * share the control plane cgroup: their sessions and MCP descendants can be
 * much larger than the supervisor itself.
 */
export function spawnIsolatedWorkload(
  command: string,
  args: string[],
  options: DetachedWorkloadOptions,
): ChildProcess {
  const launch = buildDetachedWorkloadCommand(command, args, options);
  return spawn(launch.command, launch.args, launch.options);
}
