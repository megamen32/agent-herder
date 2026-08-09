import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireAgentHerderSingleton } from "./singleton.js";

describe("Agent Herder singleton", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

  it("rejects a second process and releases the lock", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-herder-singleton-"));
    roots.push(root);
    process.env.AGENT_HERDER_SINGLETON_LOCK = join(root, "agent-herder.lock");
    const release = acquireAgentHerderSingleton();
    expect(() => acquireAgentHerderSingleton()).toThrow(/singleton already running/);
    release();
    expect(() => acquireAgentHerderSingleton()).not.toThrow();
  });
});
