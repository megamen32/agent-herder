import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { SettingsStore } from "../src/web/settings-store.js";
import {
  applySettingsValue,
  currentSettingsVersion,
  readSettings,
  rollbackSettingsValue,
  runSettingsCommand,
} from "../src/settings-management.js";
import { registerFleetNodeTools } from "../src/mesh/fleet-node.js";
import { unwrapResult } from "../src/mesh/protocol.js";

function storeWith(files: { env?: string; nodeConfig?: string } = {}): { store: SettingsStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "herder-settings-"));
  const envPath = join(dir, "herder.env");
  const nodeConfigPath = join(dir, "node-config.json");
  if (files.env !== undefined) writeFileSync(envPath, files.env);
  if (files.nodeConfig !== undefined) writeFileSync(nodeConfigPath, files.nodeConfig);
  return {
    store: new SettingsStore({ envPath, nodeConfigPath, stateDir: join(dir, "state"), actor: "owner", hostId: "test-host" }),
    dir,
  };
}

describe("the management of the settings in one implementation", () => {
  it("names every value by its version and never returns a secret", async () => {
    const { store, dir } = storeWith({ env: "NOTIFY_CENTER_TOKEN=the-secret\nNOTIFY_CENTER_PROJECT=alpha\n" });
    try {
      const view = await readSettings(store);
      expect(view.ok).toBe(true);
      expect(view.environment.values["NOTIFY_CENTER_PROJECT"]?.present).toBe(true);
      // The version of a secret names it and never reveals it.
      expect(view.environment.values["NOTIFY_CENTER_TOKEN"]?.version).toMatch(/^sha256:/);
      expect(JSON.stringify(view)).not.toContain("the-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a change without the version of the value and does not write it", async () => {
    const { store, dir } = storeWith({ env: "NOTIFY_CENTER_PROJECT=alpha\n" });
    try {
      const refused = await applySettingsValue(store, { entity: "herder.env", key: "NOTIFY_CENTER_PROJECT", value: "beta" });
      expect(refused.ok).toBe(false);
      expect(refused.ok === false && refused.code).toBe("precondition_required");
      const view = await readSettings(store);
      expect(view.environment.values["NOTIFY_CENTER_PROJECT"]?.version).toBe(await currentSettingsVersion(store, "herder.env", "NOTIFY_CENTER_PROJECT"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a change whose version is stale and keeps the value", async () => {
    const { store, dir } = storeWith({ env: "NOTIFY_CENTER_PROJECT=alpha\n" });
    try {
      const refused = await applySettingsValue(store, {
        entity: "herder.env",
        key: "NOTIFY_CENTER_PROJECT",
        value: "beta",
        ifMatch: "sha256:0000000000000000",
      });
      expect(refused.ok).toBe(false);
      expect(refused.ok === false && refused.code).toBe("precondition_failed");
      const view = await readSettings(store);
      expect(view.audit).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("changes a value with the version that was read, and rolls it back", async () => {
    const { store, dir } = storeWith({ env: "NOTIFY_CENTER_PROJECT=alpha\n" });
    try {
      const version = await currentSettingsVersion(store, "herder.env", "NOTIFY_CENTER_PROJECT");
      const applied = await applySettingsValue(store, {
        entity: "herder.env",
        key: "NOTIFY_CENTER_PROJECT",
        value: "beta",
        ifMatch: version,
      });
      expect(applied.ok).toBe(true);
      const afterApply = await readSettings(store);
      expect(afterApply.environment.values["NOTIFY_CENTER_PROJECT"]?.version).not.toBe(version);
      expect(afterApply.audit).toHaveLength(1);

      const rolled = await rollbackSettingsValue(store, { entity: "herder.env", key: "NOTIFY_CENTER_PROJECT" });
      expect(rolled.ok).toBe(true);
      const afterRollback = await readSettings(store);
      expect(afterRollback.environment.values["NOTIFY_CENTER_PROJECT"]?.version).toBe(version);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves the same values to the MCP tool and to the command of the settings", async () => {
    const { store, dir } = storeWith({ env: "NOTIFY_CENTER_PROJECT=alpha\n" });
    try {
      const server = new McpServer({ name: "local-herder", version: "1" });
      registerFleetNodeTools(server, { adapters: new Map(), settings: store });
      const client = new Client({ name: "settings-consumer", version: "1" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      await client.connect(ct);
      try {
        const read = unwrapResult(await client.callTool({ name: "settings", arguments: { op: "read" } }));
        expect((read as any).environment.values["NOTIFY_CENTER_PROJECT"].present).toBe(true);
        const version = (read as any).environment.values["NOTIFY_CENTER_PROJECT"].version;

        // A change without the version is refused, and the refusal says why.
        const refused = unwrapResult(await client.callTool({
          name: "settings",
          arguments: { op: "apply", entity: "herder.env", key: "NOTIFY_CENTER_PROJECT", value: "beta" },
        }));
        expect((refused as any).code).toBe("precondition_required");

        const applied = unwrapResult(await client.callTool({
          name: "settings",
          arguments: { op: "apply", entity: "herder.env", key: "NOTIFY_CENTER_PROJECT", value: "beta", ifMatch: version },
        }));
        expect((applied as any).ok).toBe(true);

        // The command reads the same store and sees the same value.
        const printed: string[] = [];
        const code = await runSettingsCommand(["read"], store, (text) => printed.push(text));
        expect(code).toBe(0);
        const view = JSON.parse(printed.join("\n"));
        expect(view.environment.values["NOTIFY_CENTER_PROJECT"].version).toBe((applied as any).version);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers that the settings are not available on a node without a store", async () => {
    const server = new McpServer({ name: "local-herder", version: "1" });
    registerFleetNodeTools(server, { adapters: new Map() });
    const client = new Client({ name: "settings-consumer", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const answer = unwrapResult(await client.callTool({ name: "settings", arguments: { op: "read" } }));
      expect((answer as any).ok).toBe(false);
      expect((answer as any).code).toBe("not_available");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("answers the command with the exit code of the refusal", async () => {
    const { store, dir } = storeWith({ env: "NOTIFY_CENTER_PROJECT=alpha\n" });
    const failed = vi.fn();
    try {
      const code = await runSettingsCommand(["apply", "herder.env", "NOTIFY_CENTER_PROJECT", "beta"], store, () => {}, failed);
      expect(code).toBe(1);
      expect(failed).toHaveBeenCalled();
      const misuse = await runSettingsCommand(["nonsense"], store, () => {}, failed);
      expect(misuse).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
