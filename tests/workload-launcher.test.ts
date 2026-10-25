import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDetachedWorkloadCommand, ZCODE_SHARED_RESOURCE_CHECK, ZCODE_SHARED_RESOURCE_PROPERTIES } from "../src/workload-launcher.js";

const originalIsolation = process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
const originalVitest = process.env.VITEST;
const originalRuntimeDir = process.env.XDG_RUNTIME_DIR;

/** The place where the guard script of the test goes: not the runtime of the user. */
beforeAll(() => {
  process.env.XDG_RUNTIME_DIR = mkdtempSync(join(tmpdir(), "agent-herder-guard-test-"));
});
afterAll(() => {
  if (originalRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
});
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
    const guard = launch.args[launch.args.length - 3];
    expect(launch.args.slice(-4)).toEqual(["/bin/sh", guard, "/review/native", "argument with spaces"]);
    expect(readFileSync(guard, "utf8")).toBe(ZCODE_SHARED_RESOURCE_CHECK);
    expect(launch.options).not.toHaveProperty("resourceGuard");
  });

  it("keeps the text of the guard out of the arguments of systemd-run", () => {
    delete process.env.VITEST;
    delete process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
    if (process.platform !== "linux") return;
    const launch = buildDetachedWorkloadCommand("/review/native", ["argument with spaces"], {
      label: "zcode-app-server", resourceGuard: "zcode-shared", stdio: ["pipe", "pipe", "pipe"],
    });
    // The command line of a scope becomes the Description of the transient
    // unit, and a line break in it breaks the unit file of the scope: the
    // text of the guard never travels in the arguments.
    expect(launch.args).not.toContain(ZCODE_SHARED_RESOURCE_CHECK);
    for (const argument of launch.args) {
      expect(argument).not.toMatch(/\n/);
      expect(argument).not.toContain("while IFS");
      expect(argument).not.toContain("$hierarchy");
      expect(argument).not.toContain("$group");
      expect(argument).not.toContain("printf '%s");
    }
    // The guard still runs, from a file that the scope reads.
    const guard = launch.args[launch.args.length - 3];
    expect(guard).toMatch(/^\//);
    expect(launch.args.slice(-4)).toEqual(["/bin/sh", guard, "/review/native", "argument with spaces"]);
    expect(readFileSync(guard, "utf8")).toBe(ZCODE_SHARED_RESOURCE_CHECK);
  });

  it("names the scope without the command line of the payload", () => {
    delete process.env.VITEST;
    delete process.env.AGENT_HERDER_WORKLOAD_ISOLATION;
    if (process.platform !== "linux") return;
    const launch = buildDetachedWorkloadCommand("/review/native", ["argument with spaces"], {
      label: "zcode-app-server", resourceGuard: "zcode-shared", stdio: ["pipe", "pipe", "pipe"],
    });
    // The Description of the transient unit is what systemd writes into the
    // unit file of the scope: it names the workload and nothing else.
    const description = launch.args.find((argument) => argument.startsWith("--description="));
    expect(description).toBeDefined();
    expect(description).not.toMatch(/\n/);
    expect(description).not.toContain("/review/native");
    expect(description).not.toContain(ZCODE_SHARED_RESOURCE_CHECK);
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
