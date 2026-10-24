import { afterEach, describe, expect, it, vi } from "vitest";
import type { Readable } from "node:stream";

import { buildDetachedWorkloadCommand, spawnIsolatedWorkload, type DetachedWorkloadOptions } from "../src/workload-launcher.js";
import { ALWAYS_FORBIDDEN_ENV, DEFAULT_ALLOWED_ENV } from "../src/web/settings-harness-env.js";

/**
 * The environment of a spawned workload.
 *
 * The rule of the allowlist is in force at the seam that builds the
 * environment of a spawned process: the secrets of the herder never reach a
 * workload, the bus of the herder always does, and the names that the caller
 * of the spawn set on purpose reach the workload as well.
 */

const originalIsolation = process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
const originalVitest = process.env.VITEST;

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalIsolation === undefined) delete process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
  else process.env.AGENT_HERDER_WORKLOAD_ISOLATION = originalIsolation;
  if (originalVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = originalVitest;
});

/** The value of every secret of the contour; the value never leaves the test. */
const SECRET_VALUES: Record<string, string> = {
  AGENT_HERDER_DISARM_TOKEN: "the-lever-token",
  NOTICEPLACE_HEALTH_LAUNCH_TOKEN: "the-health-token",
  NOTIFY_CENTER_TOKEN: "the-center-token",
  NOTIFY_CENTER_EVENT_URL: "https://notify-center.invalid/hook",
  NOTIFY_CENTER_PROJECT: "the-project",
  NOTIFY_CENTER_RECIPIENT: "the-recipient",
  AGENT_RESUME_HERMES_TOKEN: "the-hermes-token",
  AGENT_RESUME_HERMES_ENDPOINT: "https://hermes.invalid",
  OMNIROUTE_API_KEY: "the-omniroute-key",
  MINIMAX_API_KEY: "the-minimax-key",
  MCP_TELEGRAM_BEARER: "the-telegram-bearer",
  SSS_API_KEY: "the-sss-key",
};

/** The names of the bus of the user session, which runtimeBusEnv owns. */
const BUS_NAMES = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

/** The data home that a project app-server names for itself. */
const PROJECT_CODEX_HOME = "/tmp/the-project-codex-home";

function build(
  env: Record<string, string> | undefined,
  allowedEnv?: readonly string[],
  isolated = true,
  ownedEnv?: readonly string[],
): ReturnType<typeof buildDetachedWorkloadCommand> {
  if (isolated) {
    delete process.env.VITEST;
    delete process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
  } else {
    process.env.AGENT_HERDER_WORKLOAD_ISOLATION = "off";
  }
  const options: DetachedWorkloadOptions = { label: "harness-env", env };
  if (allowedEnv) options.allowedEnv = allowedEnv;
  if (ownedEnv) options.ownedEnv = ownedEnv;
  return buildDetachedWorkloadCommand("/usr/bin/example-agent", ["run"], options);
}

function environmentOf(launch: ReturnType<typeof buildDetachedWorkloadCommand>): NodeJS.ProcessEnv {
  return launch.options.env as NodeJS.ProcessEnv;
}

/** The environment that a real spawned child sees. */
async function spawnedEnvironment(
  env: NodeJS.ProcessEnv | undefined,
  ownedEnv?: readonly string[],
): Promise<Record<string, string | undefined>> {
  const child = spawnIsolatedWorkload(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
    label: "harness-env-probe",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...(ownedEnv ? { ownedEnv } : {}),
  });
  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout as Readable) chunks.push(Buffer.from(chunk as Buffer));
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, string | undefined>;
}

describe("the environment of a spawned workload", () => {
  it("names every secret of the contour", () => {
    expect(Object.keys(SECRET_VALUES).sort()).toEqual([...ALWAYS_FORBIDDEN_ENV].sort());
  });

  it("cuts every secret of the herder out of the workload", () => {
    const launch = build({ PATH: "/usr/bin", ...SECRET_VALUES });
    const environment = environmentOf(launch);
    for (const name of ALWAYS_FORBIDDEN_ENV) expect(environment[name]).toBeUndefined();
    expect(environment.PATH).toBe("/usr/bin");
  });

  it("cuts the secrets of the herder when the caller names no environment", () => {
    vi.stubEnv("NOTIFY_CENTER_TOKEN", "the-center-token");
    vi.stubEnv("OMNIROUTE_API_KEY", "the-omniroute-key");
    const environment = environmentOf(build(undefined));
    expect(environment.NOTIFY_CENTER_TOKEN).toBeUndefined();
    expect(environment.OMNIROUTE_API_KEY).toBeUndefined();
  });

  it("gives the workload only the names of the allowlist of the product", () => {
    vi.stubEnv("OWNER_VARIABLE", "yes");
    const environment = environmentOf(build(undefined));
    for (const name of Object.keys(environment)) {
      expect([...DEFAULT_ALLOWED_ENV, ...BUS_NAMES]).toContain(name);
    }
  });

  it("keeps the name that the caller set on purpose for the workload", () => {
    const environment = environmentOf(build({ PATH: "/usr/bin", CODEX_HOME: PROJECT_CODEX_HOME }));
    expect(environment.CODEX_HOME).toBe(PROJECT_CODEX_HOME);
    expect(environment.PATH).toBe("/usr/bin");
  });

  it("keeps the name of the caller even when the allowlist does not name it", () => {
    const environment = environmentOf(build({ PATH: "/usr/bin", CODEX_APP_SERVER_DATA_HOME: PROJECT_CODEX_HOME }));
    expect(environment.CODEX_APP_SERVER_DATA_HOME).toBe(PROJECT_CODEX_HOME);
  });

  it("cuts the background of the herder around the names of the caller", () => {
    vi.stubEnv("OWNER_VARIABLE", "yes");
    const environment = environmentOf(build({ PATH: "/usr/bin", CODEX_HOME: PROJECT_CODEX_HOME }));
    expect(environment.OWNER_VARIABLE).toBeUndefined();
    expect(environment.CODEX_HOME).toBe(PROJECT_CODEX_HOME);
  });

  it("gives the workload only the names that the owner named", () => {
    const environment = environmentOf(build({ PATH: "/usr/bin", OWNER_VARIABLE: "yes" }, ["OWNER_VARIABLE"]));
    expect(environment.OWNER_VARIABLE).toBe("yes");
    expect(environment.PATH).toBe("/usr/bin");
  });

  it("lets the deny of the herder win over the allowlist of the owner", () => {
    const environment = environmentOf(build(
      { PATH: "/usr/bin", NOTIFY_CENTER_TOKEN: "the-center-token" },
      [...DEFAULT_ALLOWED_ENV, "NOTIFY_CENTER_TOKEN"],
    ));
    expect(environment.NOTIFY_CENTER_TOKEN).toBeUndefined();
  });

  it("lets the deny of the herder win over the name that the caller set", () => {
    const environment = environmentOf(build({
      PATH: "/usr/bin",
      CODEX_HOME: PROJECT_CODEX_HOME,
      OMNIROUTE_API_KEY: "the-omniroute-key",
      MINIMAX_API_KEY: "the-minimax-key",
      NOTIFY_CENTER_TOKEN: "the-center-token",
      NOTICEPLACE_HEALTH_LAUNCH_TOKEN: "the-health-token",
      AGENT_HERDER_DISARM_TOKEN: "the-lever-token",
    }));
    expect(environment.CODEX_HOME).toBe(PROJECT_CODEX_HOME);
    expect(environment.OMNIROUTE_API_KEY).toBeUndefined();
    expect(environment.MINIMAX_API_KEY).toBeUndefined();
    expect(environment.NOTIFY_CENTER_TOKEN).toBeUndefined();
    expect(environment.NOTICEPLACE_HEALTH_LAUNCH_TOKEN).toBeUndefined();
    expect(environment.AGENT_HERDER_DISARM_TOKEN).toBeUndefined();
  });

  it("keeps the data home that the caller addressed when the background names the same value", () => {
    // The background of the herder names the same value as the app instance:
    // the address of the caller must survive it, or the app-server falls back
    // to the home directory of the user.
    vi.stubEnv("CODEX_HOME", PROJECT_CODEX_HOME);
    const environment = environmentOf(build(
      { PATH: "/usr/bin", CODEX_HOME: PROJECT_CODEX_HOME },
      undefined,
      true,
      ["CODEX_HOME"],
    ));
    expect(environment.CODEX_HOME).toBe(PROJECT_CODEX_HOME);
  });

  it("keeps no secret of the herder when the caller addresses the data home", () => {
    vi.stubEnv("CODEX_HOME", PROJECT_CODEX_HOME);
    const environment = environmentOf(build(
      { PATH: "/usr/bin", CODEX_HOME: PROJECT_CODEX_HOME, ...SECRET_VALUES },
      undefined,
      true,
      ["CODEX_HOME"],
    ));
    expect(environment.CODEX_HOME).toBe(PROJECT_CODEX_HOME);
    for (const name of ALWAYS_FORBIDDEN_ENV) expect(environment[name]).toBeUndefined();
  });

  it("spawns a child that sees the data home that the caller addressed against the same background", async () => {
    vi.stubEnv("CODEX_HOME", PROJECT_CODEX_HOME);
    const environment = await spawnedEnvironment(
      { ...process.env, CODEX_HOME: PROJECT_CODEX_HOME, ...SECRET_VALUES },
      ["CODEX_HOME"],
    );
    expect(environment.CODEX_HOME).toBe(PROJECT_CODEX_HOME);
    for (const name of ALWAYS_FORBIDDEN_ENV) expect(environment[name]).toBeUndefined();
  });

  it("does not hand the owned names to the process as an option of the spawn", () => {
    expect(build({ PATH: "/usr/bin" }, undefined, true, ["CODEX_HOME"]).options).not.toHaveProperty("ownedEnv");
  });

  it("keeps the bus of the herder that the workload talks back through", () => {
    const environment = environmentOf(build({
      PATH: "/usr/bin",
      XDG_RUNTIME_DIR: "/run/user/4242",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/4242/bus",
    }));
    expect(environment.XDG_RUNTIME_DIR).toBe("/run/user/4242");
    expect(environment.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/4242/bus");
  });

  it("gives the workload the bus of the user session when the caller names none", () => {
    const environment = environmentOf(build({ PATH: "/usr/bin" }));
    expect(environment.XDG_RUNTIME_DIR).toMatch(/^\/run\/user\/\d+$/);
    expect(environment.DBUS_SESSION_BUS_ADDRESS).toContain("/bus");
  });

  it("applies the rule to the plain spawn as well", () => {
    const environment = environmentOf(build({ PATH: "/usr/bin", ...SECRET_VALUES }, undefined, false));
    for (const name of ALWAYS_FORBIDDEN_ENV) expect(environment[name]).toBeUndefined();
    expect(environment.PATH).toBe("/usr/bin");
  });

  it("keeps the name of the caller in the plain spawn as well", () => {
    const environment = environmentOf(build({ PATH: "/usr/bin", CODEX_HOME: PROJECT_CODEX_HOME }, undefined, false));
    expect(environment.CODEX_HOME).toBe(PROJECT_CODEX_HOME);
    expect(environment.OMNIROUTE_API_KEY).toBeUndefined();
  });

  it("keeps the bus of the caller in the plain spawn as well", () => {
    const environment = environmentOf(build({
      PATH: "/usr/bin",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/the-bus",
    }, undefined, false));
    expect(environment.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/tmp/the-bus");
  });

  it("carries no value of a secret into the launch", () => {
    const text = JSON.stringify(build({ PATH: "/usr/bin", ...SECRET_VALUES }));
    for (const value of Object.values(SECRET_VALUES)) expect(text).not.toContain(value);
  });

  it("does not hand the allowlist to the process as an option of the spawn", () => {
    expect(build({ PATH: "/usr/bin" }, ["PATH"]).options).not.toHaveProperty("allowedEnv");
  });

  it("does not widen the allowlist of the product", () => {
    expect(DEFAULT_ALLOWED_ENV).not.toContain("CODEX_HOME");
    for (const name of DEFAULT_ALLOWED_ENV) expect(name.startsWith("CODEX_APP_SERVER_")).toBe(false);
    expect(DEFAULT_ALLOWED_ENV).not.toContain("CODEX_APP_SERVER_LOG");
    expect(DEFAULT_ALLOWED_ENV).not.toContain("CODEX_APP_SERVER_THREAD_COUNT");
    expect(DEFAULT_ALLOWED_ENV).not.toContain("CODEX_APP_SERVER_NUMERIC_TIMESTAMPS");
  });

  it("spawns a child that sees no secret of the herder", async () => {
    const environment = await spawnedEnvironment({
      ...process.env,
      CODEX_HOME: PROJECT_CODEX_HOME,
      ...SECRET_VALUES,
    });
    for (const name of ALWAYS_FORBIDDEN_ENV) expect(environment[name]).toBeUndefined();
    expect(environment.OMNIROUTE_API_KEY).toBeUndefined();
    expect(environment.MINIMAX_API_KEY).toBeUndefined();
    expect(environment.NOTIFY_CENTER_TOKEN).toBeUndefined();
    expect(environment.NOTICEPLACE_HEALTH_LAUNCH_TOKEN).toBeUndefined();
    expect(environment.AGENT_HERDER_DISARM_TOKEN).toBeUndefined();
  });

  it("spawns a child that sees the data home that the caller named", async () => {
    const environment = await spawnedEnvironment({ ...process.env, CODEX_HOME: PROJECT_CODEX_HOME });
    expect(environment.CODEX_HOME).toBe(PROJECT_CODEX_HOME);
  });

  it("spawns a child that sees no secret of the herder when the caller names no environment", async () => {
    const environment = await spawnedEnvironment(undefined);
    for (const name of ALWAYS_FORBIDDEN_ENV) expect(environment[name]).toBeUndefined();
    expect(Object.keys(environment).every((name) => [...DEFAULT_ALLOWED_ENV, ...BUS_NAMES].includes(name))).toBe(true);
  });
});
