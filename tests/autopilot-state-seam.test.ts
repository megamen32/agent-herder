import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  adoptLegacyAutopilotState,
  AUTOPILOT_STATE_DIR_NAME,
  LEGACY_AUTOPILOT_STATE_DIR_NAME,
  resolveAutopilotStateDir,
  resolveHumanRequestStorePath,
} from "../src/autopilot/state-dir.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-state-seam-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("autopilot state seam", () => {
  it("resolves one default directory for every entrypoint and honours an explicit override", () => {
    const env = { HOME: "/home/roomhacker" } as NodeJS.ProcessEnv;
    expect(resolveAutopilotStateDir(env)).toBe(join("/home/roomhacker", ".local", "state", "agent-herder", AUTOPILOT_STATE_DIR_NAME));
    expect(resolveHumanRequestStorePath("/state", env)).toBe(join("/state", "human-requests.json"));

    const pinned = { HOME: "/home/roomhacker", AGENT_HERDER_AUTOPILOT_STATE_DIR: "/srv/state/pinned" } as NodeJS.ProcessEnv;
    expect(resolveAutopilotStateDir(pinned)).toBe("/srv/state/pinned");
    expect(resolveHumanRequestStorePath("/state", pinned)).toBe("/state/human-requests.json");
    expect(resolveHumanRequestStorePath("/state", { ...pinned, AGENT_HERDER_HUMAN_REQUEST_STORE: "/srv/hr.json" } as NodeJS.ProcessEnv)).toBe("/srv/hr.json");
  });

  it("adopts pre-seam state once, never overwrites it and never adopts a turn cache", async () => {
    const root = await home();
    const legacy = join(root, ".local", "state", "agent-herder", LEGACY_AUTOPILOT_STATE_DIR_NAME);
    const canonical = join(root, ".local", "state", "agent-herder", AUTOPILOT_STATE_DIR_NAME);
    const env = {
      HOME: root,
      AGENT_HERDER_LEGACY_AUTOPILOT_STATE_DIR: legacy,
      AGENT_HERDER_LEGACY_WORKING_DIRECTORY: root,
    } as NodeJS.ProcessEnv;

    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, ".agent-herder"), { recursive: true });
    await writeFile(join(root, ".agent-herder", "human-requests.json"), '{"legacy":true}', "utf8");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "choices.json"), '{"version":1,"requests":[]}', "utf8");
    await writeFile(join(legacy, "sessions.json"), '{"legacy-sessions":true}', "utf8");
    // The receipt store is the terminal-dedup and pending-notice outbox.
    await writeFile(join(legacy, "receipts.json"), '{"session-1:turn-1":{"kind":"human","pendingNotice":{"schema":"notify.event.v1"}}}', "utf8");

    const adopted = await adoptLegacyAutopilotState(canonical, env);

    expect(await readFile(join(canonical, "choices.json"), "utf8")).toBe('{"version":1,"requests":[]}');
    expect(await readFile(join(canonical, "sessions.json"), "utf8")).toBe('{"legacy-sessions":true}');
    expect(await readFile(join(canonical, "human-requests.json"), "utf8")).toBe('{"legacy":true}');
    // The pending notice outbox survives the cutover.
    expect(await readFile(join(canonical, "receipts.json"), "utf8")).toContain("pendingNotice");
    expect(adopted.length).toBeGreaterThanOrEqual(4);

    // A second boot adopts nothing and never rewrites live canonical state.
    await writeFile(join(canonical, "choices.json"), '{"live":true}', "utf8");
    expect(await adoptLegacyAutopilotState(canonical, env)).toEqual([]);
    expect(await readFile(join(canonical, "choices.json"), "utf8")).toBe('{"live":true}');
  });

  it("merges two populated directories by verified record identity", async () => {
    const root = await home();
    const legacy = join(root, "legacy");
    const canonical = join(root, "canonical");
    const env = {
      HOME: root,
      AGENT_HERDER_AUTOPILOT_STATE_DIR: canonical,
      AGENT_HERDER_LEGACY_AUTOPILOT_STATE_DIR: legacy,
      AGENT_HERDER_LEGACY_WORKING_DIRECTORY: root,
    } as NodeJS.ProcessEnv;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(legacy, { recursive: true });
    await mkdir(canonical, { recursive: true });
    const canonicalChoice = (requestId: string, status: string) => ({ requestId, harness: "zcode", sessionId: "s", turnId: "t", cwd: "/w", choices: [{ choiceId: "a", label: "a", nextGoal: "g" }], status, createdAt: "2026-10-11T10:00:00.000Z", resultRef: `agent-herder://autopilot/choice/${requestId}` });
    await writeFile(join(legacy, "choices.json"), JSON.stringify({ version: 1, requests: [
      canonicalChoice("req-shared", "pending"),
      canonicalChoice("req-legacy-only", "pending"),
    ] }), "utf8");
    await writeFile(join(canonical, "choices.json"), JSON.stringify({ version: 1, requests: [
      canonicalChoice("req-shared", "resumed"),
    ] }), "utf8");

    const adopted = await adoptLegacyAutopilotState(canonical, env);

    const merged = JSON.parse(await readFile(join(canonical, "choices.json"), "utf8")) as { requests: Array<{ requestId: string; status: string }> };
    expect(adopted).toContain(join(canonical, "choices.json"));
    // The canonical state of a shared record wins; a legacy-only pending
    // question is preserved instead of being dropped.
    expect(merged.requests.filter((record) => record.requestId === "req-shared").map((record) => record.status)).toEqual(["resumed"]);
    expect(merged.requests.map((record) => record.requestId)).toContain("req-legacy-only");
    expect(await readFile(join(canonical, "choices.json.pre-merge"), "utf8")).toContain("req-shared");
  });

  it("merges the terminal decisions, the notice outbox and the armed admission set", async () => {
    const root = await home();
    const legacy = join(root, "legacy");
    const canonical = join(root, "canonical");
    const env = {
      HOME: root,
      AGENT_HERDER_AUTOPILOT_STATE_DIR: canonical,
      AGENT_HERDER_LEGACY_AUTOPILOT_STATE_DIR: legacy,
      AGENT_HERDER_LEGACY_WORKING_DIRECTORY: root,
    } as NodeJS.ProcessEnv;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(legacy, { recursive: true });
    await mkdir(canonical, { recursive: true });
    await writeFile(join(legacy, "receipts.json"), JSON.stringify({
      "ses-old:turn-old": { kind: "human" },
      "ses-shared:turn-1": { kind: "done" },
    }), "utf8");
    await writeFile(join(canonical, "receipts.json"), JSON.stringify({
      "ses-shared:turn-1": { kind: "continue" },
    }), "utf8");
    await writeFile(join(legacy, "armed-sessions.json"), JSON.stringify(["ses-old", "ses-shared"]), "utf8");
    await writeFile(join(canonical, "armed-sessions.json"), JSON.stringify(["ses-shared"]), "utf8");

    const adopted = await adoptLegacyAutopilotState(canonical, env);

    expect(adopted).toEqual(expect.arrayContaining([join(canonical, "receipts.json"), join(canonical, "armed-sessions.json")]));
    // The canonical terminal decision wins; a distinct legacy one survives.
    const receipts = JSON.parse(await readFile(join(canonical, "receipts.json"), "utf8")) as Record<string, { kind: string }>;
    expect(receipts["ses-shared:turn-1"]?.kind).toBe("continue");
    expect(receipts["ses-old:turn-old"]?.kind).toBe("human");
    // The armed admission set is the union, in its own list shape.
    expect(JSON.parse(await readFile(join(canonical, "armed-sessions.json"), "utf8"))).toEqual(["ses-shared", "ses-old"]);
    expect(await readFile(join(canonical, "receipts.json.pre-merge"), "utf8")).toContain("continue");
  });

  it("leaves an unrecognized registry shape untouched", async () => {
    const root = await home();
    const legacy = join(root, "legacy");
    const canonical = join(root, "canonical");
    const env = {
      HOME: root,
      AGENT_HERDER_AUTOPILOT_STATE_DIR: canonical,
      AGENT_HERDER_LEGACY_AUTOPILOT_STATE_DIR: legacy,
      AGENT_HERDER_LEGACY_WORKING_DIRECTORY: root,
    } as NodeJS.ProcessEnv;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(legacy, { recursive: true });
    await mkdir(canonical, { recursive: true });
    await writeFile(join(legacy, "human-requests.json"), '{"unexpected":"shape"}', "utf8");
    await writeFile(join(canonical, "human-requests.json"), '{"version":1,"requests":[]}', "utf8");

    expect(await adoptLegacyAutopilotState(canonical, env)).toEqual([]);
    expect(await readFile(join(canonical, "human-requests.json"), "utf8")).toBe('{"version":1,"requests":[]}');
  });

  it("does not adopt anything when only the canonical directory is pinned", async () => {
    const root = await home();
    const legacy = join(root, "legacy");
    const canonical = join(root, "pinned");
    const env = {
      HOME: root,
      AGENT_HERDER_AUTOPILOT_STATE_DIR: canonical,
      AGENT_HERDER_LEGACY_WORKING_DIRECTORY: root,
    } as NodeJS.ProcessEnv;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "choices.json"), '{"version":1,"requests":[]}', "utf8");

    expect(await adoptLegacyAutopilotState(canonical, env)).toEqual([]);
    await expect(readFile(join(canonical, "choices.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});