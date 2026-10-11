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
    await writeFile(join(legacy, "receipts.json"), '{"legacy-receipts":true}', "utf8");

    const adopted = await adoptLegacyAutopilotState(canonical, env);

    expect(await readFile(join(canonical, "choices.json"), "utf8")).toBe('{"version":1,"requests":[]}');
    expect(await readFile(join(canonical, "sessions.json"), "utf8")).toBe('{"legacy-sessions":true}');
    expect(await readFile(join(canonical, "human-requests.json"), "utf8")).toBe('{"legacy":true}');
    // A turn cache is rebuilt by a fresh process and is never adopted.
    await expect(readFile(join(canonical, "receipts.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(adopted).toHaveLength(3);

    // A second boot adopts nothing and never rewrites live canonical state.
    await writeFile(join(canonical, "choices.json"), '{"live":true}', "utf8");
    expect(await adoptLegacyAutopilotState(canonical, env)).toEqual([]);
    expect(await readFile(join(canonical, "choices.json"), "utf8")).toBe('{"live":true}');
  });

  it("does not adopt anything when the state directory is pinned explicitly", async () => {
    const root = await home();
    const legacy = join(root, "legacy");
    const canonical = join(root, "pinned");
    const env = {
      HOME: root,
      AGENT_HERDER_AUTOPILOT_STATE_DIR: canonical,
      AGENT_HERDER_LEGACY_AUTOPILOT_STATE_DIR: legacy,
      AGENT_HERDER_LEGACY_WORKING_DIRECTORY: root,
    } as NodeJS.ProcessEnv;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "choices.json"), '{"version":1,"requests":[]}', "utf8");

    expect(await adoptLegacyAutopilotState(canonical, env)).toEqual([]);
    await expect(readFile(join(canonical, "choices.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});