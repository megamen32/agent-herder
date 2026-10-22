import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWebServer } from "../src/web/server.js";

/**
 * The counters of a recovery say how many sessions were skipped, not why.
 * The reason of every skipped session belongs in the operator's log: it is the
 * evidence of a session that is not observed.
 */
describe("the log of the recovered health observation", () => {
  it("names every skipped session and its reason", async () => {
    const root = await mkdtemp(join(tmpdir(), "herder-health-recovery-log-"));
    const previousStateDir = process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR;
    process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR = root;
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.map((value) => String(value)).join(" ")); };
    try {
      await writeFile(join(root, "sessions.json"), JSON.stringify({
        version: 1,
        sessions: [
          { harness: "opencode", sessionId: "ses_gone", cwd: "/work", enabled: true, noticeIncident: { incidentId: "inc_gone", project: "omniroute-guard" } },
        ],
      }));

      const server = createWebServer({
        adapters: new Map(),
        converter: { async convert() { return { success: true, targetSessionId: "x", targetPath: "/tmp/x", messageCount: 0 }; } },
      });
      await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    } finally {
      console.log = originalLog;
      if (previousStateDir === undefined) delete process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR;
      else process.env.AGENT_HERDER_AUTOPILOT_STATE_DIR = previousStateDir;
      await rm(root, { recursive: true, force: true });
    }

    const log = logs.join("\n");
    expect(log).toContain("Notice health observer recovered");
    expect(log).toContain("ses_gone");
    expect(log).toContain("the session is gone or finished");
  });
});
