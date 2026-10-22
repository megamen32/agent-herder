import { describe, expect, it } from "vitest";

import { ALWAYS_FORBIDDEN_ENV, DEFAULT_ALLOWED_ENV, harnessEnv, harnessEnvNames } from "../src/web/settings-harness-env.js";

/**
 * The environment of a spawned harness process.
 *
 * A spawned agent must not see the secrets of the contour: the right to use a
 * key is not the right to read it.
 */
describe("the environment of a spawned harness process", () => {
  const source: Record<string, string | undefined> = {
    PATH: "/usr/bin",
    HOME: "/home/roomhacker",
    AGENT_HERDER_WEB_PORT: "18787",
    AGENT_HERDER_DISARM_TOKEN: "the-lever-token",
    NOTICEPLACE_HEALTH_LAUNCH_TOKEN: "the-health-token",
    NOTIFY_CENTER_TOKEN: "the-center-token",
    AGENT_RESUME_HERMES_TOKEN: "the-hermes-token",
    OMNIROUTE_API_KEY: "the-omniroute-key",
    MINIMAX_API_KEY: "the-minimax-key",
    MCP_TELEGRAM_BEARER: "the-telegram-bearer",
    SSS_API_KEY: "the-sss-key",
  };

  it("passes only the names of the allowlist", () => {
    const environment = harnessEnv(source);
    // The default allowlist names the plain variables of the system and the
    // address of the panel; the secrets of the contour are not in it.
    expect(Object.keys(environment).sort()).toEqual(["AGENT_HERDER_WEB_PORT", "HOME", "PATH"]);
    expect(environment.PATH).toBe("/usr/bin");
    expect(environment.AGENT_HERDER_DISARM_TOKEN).toBeUndefined();
  });

  it("refuses every secret of the contour, even when it is allowed", () => {
    const environment = harnessEnv(source, [...ALWAYS_FORBIDDEN_ENV, "PATH"]);
    // The rule of the deny wins: only PATH, which is not a secret, passes.
    expect(Object.keys(environment)).toEqual(["PATH"]);
    for (const name of ALWAYS_FORBIDDEN_ENV) {
      expect(environment[name]).toBeUndefined();
    }
  });

  it("passes an allowed name and drops everything else", () => {
    const environment = harnessEnv(source, ["AGENT_HERDER_WEB_PORT", "NOTIFY_CENTER_TOKEN"]);
    expect(environment.AGENT_HERDER_WEB_PORT).toBe("18787");
    // The secret of the center does not pass, although it was named.
    expect(environment.NOTIFY_CENTER_TOKEN).toBeUndefined();
  });

  it("carries no value of a secret in the answer", () => {
    const environment = harnessEnv(source, Object.keys(source));
    const text = JSON.stringify(environment);
    expect(text).not.toContain("the-lever-token");
    expect(text).not.toContain("the-health-token");
    expect(text).not.toContain("the-center-token");
    expect(text).not.toContain("the-hermes-token");
    expect(text).not.toContain("the-omniroute-key");
    expect(text).not.toContain("the-minimax-key");
    expect(text).not.toContain("the-telegram-bearer");
    expect(text).not.toContain("the-sss-key");
  });

  it("names the refused names without their values", () => {
    const names = harnessEnvNames([...DEFAULT_ALLOWED_ENV, "NOTIFY_CENTER_TOKEN"]);
    expect(names.allowed).toContain("PATH");
    expect(names.refused).toContain("NOTIFY_CENTER_TOKEN");
    expect(names.allowed).not.toContain("NOTIFY_CENTER_TOKEN");
    expect(JSON.stringify(names)).not.toContain("the-center-token");
  });
});
