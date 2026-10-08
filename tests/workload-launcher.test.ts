import { afterEach, describe, expect, it } from "vitest";
import { buildDetachedWorkloadCommand, ZCODE_SHARED_RESOURCE_CHECK, ZCODE_SHARED_RESOURCE_PROPERTIES } from "../src/workload-launcher.js";

const originalIsolation = process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
const originalVitest = process.env.VITEST;
afterEach(() => {
  if (originalIsolation === undefined) delete process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
  else process.env.AGENT_HERDER_WORKLOAD_ISOLATION = originalIsolation;
  if (originalVitest === undefined) delete process.env.VITEST;
  else process.env.VITEST = originalVitest;
});

describe("detached workload isolation", () => {
  it("wraps Linux workloads in a transient user scope", () => {
    delete process.env.VITEST;
    delete process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
    const launch = buildDetachedWorkloadCommand("/usr/bin/example-agent", ["run", "--flag"], {
      label: "Codex Queue",
      cwd: "/tmp",
      env: { TEST_ONLY: "yes" },
      stdio: "ignore",
    });
    if (process.platform !== "linux") return expect(launch.isolated).toBe(false);
    expect(launch.isolated).toBe(true);
    expect(launch.command).toBe("systemd-run");
    expect(launch.args.slice(0, 5)).toEqual(["--user", "--scope", "--quiet", "--collect", expect.stringMatching(/^--unit=agent-herder-codex-queue-/)]);
    expect(launch.args.slice(-3)).toEqual(["/usr/bin/example-agent", "run", "--flag"]);
    expect(launch.options).toMatchObject({ cwd: "/tmp", detached: true, stdio: "ignore" });
    expect((launch.options.env as NodeJS.ProcessEnv).TEST_ONLY).toBe("yes");
    expect((launch.options.env as NodeJS.ProcessEnv).XDG_RUNTIME_DIR).toMatch(/^\/run\/user\/\d+$/);
    expect((launch.options.env as NodeJS.ProcessEnv).DBUS_SESSION_BUS_ADDRESS).toContain("/bus");
    expect(launch.unitName).toMatch(/^agent-herder-codex-queue-[a-f0-9]+\.scope$/);
  });

  it("supports an explicit direct-spawn fallback", () => {
    process.env.AGENT_HERDER_WORKLOAD_ISOLATION = "off";
    const launch = buildDetachedWorkloadCommand("/bin/sleep", ["1"], { label: "test", cwd: "/tmp" });
    expect(launch).toMatchObject({ command: "/bin/sleep", args: ["1"], isolated: false });
    expect(launch.options).toMatchObject({ cwd: "/tmp", detached: true, stdio: "ignore" });
  });
});

describe("mandatory ZCode shared resource guard", () => {
  it("wraps the native command after the reviewed budget and actual cap readback", () => {
    delete process.env.VITEST;
    delete process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
    if (process.platform !== "linux") return;
    const launch = buildDetachedWorkloadCommand("/review/native", ["argument with spaces"], {
      label: "zcode-app-server", resourceGuard: "zcode-shared", stdio: ["pipe", "pipe", "pipe"],
    });
    if (process.platform !== "linux") return;
    expect(launch.command).toBe("systemd-run");
    expect(ZCODE_SHARED_RESOURCE_PROPERTIES).toEqual([
      "MemoryHigh=32212254720", "MemoryMax=36507222016", "MemorySwapMax=2147483648",
      "CPUQuota=1600%", "TasksMax=4096",
    ]);
    for (const property of ZCODE_SHARED_RESOURCE_PROPERTIES) expect(launch.args).toContain(property);
    expect(launch.args.slice(-6)).toEqual(["/bin/sh", "-c", ZCODE_SHARED_RESOURCE_CHECK,
      "zcode-resource-guard", "/review/native", "argument with spaces"]);
    expect(launch.options).not.toHaveProperty("resourceGuard");
  });

  it("refuses isolation bypasses instead of launching an unbounded native payload", () => {
    delete process.env.VITEST;
    process.env.AGENT_HERDER_WORKLOAD_ISOLATION = "off";
    expect(() => buildDetachedWorkloadCommand("/review/native", [], {
      label: "zcode-app-server", resourceGuard: "zcode-shared",
    })).toThrow("requires Linux systemd isolation");
    delete process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
    process.env.VITEST = "true";
    expect(() => buildDetachedWorkloadCommand("/review/native", [], {
      label: "zcode-app-server", resourceGuard: "zcode-shared",
    })).toThrow("requires Linux systemd isolation");
  });

  it("rejects budget overrides on the mandatory shared profile", () => {
    if (process.platform !== "linux") return;
    delete process.env.VITEST;
    delete process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
    expect(() => buildDetachedWorkloadCommand("/review/native", [], {
      label: "zcode-app-server", resourceGuard: "zcode-shared",
      resourceProperties: ["MemoryMax=infinity"],
    })).toThrow("does not accept budget overrides");
  });
});
