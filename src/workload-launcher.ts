import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface DetachedWorkloadOptions extends SpawnOptions {
  /** Short harness/workload label used only for the transient systemd scope name. */
  label: string;
}

export interface IsolatedWorkloadCommand {
  command: string;
  args: string[];
  options: SpawnOptions;
  unitName?: string;
  isolated: boolean;
}

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

function safeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "workload";
}

export function buildDetachedWorkloadCommand(
  command: string,
  args: string[],
  options: DetachedWorkloadOptions,
): IsolatedWorkloadCommand {
  const { label, env, ...spawnOptions } = options;
  const isolationDisabled = process.env.AGENT_HERDER_WORKLOAD_ISOLATION === "off" || process.env.VITEST === "true";
  if (isolationDisabled || process.platform !== "linux") {
    return {
      command,
      args,
      options: { ...spawnOptions, env, detached: true, stdio: spawnOptions.stdio ?? "ignore" },
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
      command,
      ...args,
    ],
    options: {
      ...spawnOptions,
      env: runtimeBusEnv(env || process.env),
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
  const launch = buildDetachedWorkloadCommand(command, args, options);
  const child = spawn(launch.command, launch.args, launch.options);
  child.unref();
  return child;
}
