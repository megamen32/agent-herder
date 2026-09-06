import { afterEach, describe, expect, it } from "vitest";
import { buildDetachedWorkloadCommand } from "../src/workload-launcher.js";

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
