import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { restoreCommonSettingsLocalValues } from "../src/common-settings/apply.js";
import { CommonSettingsNodeService } from "../src/common-settings/node-service.js";
import { CommonSettingsStateStore } from "../src/common-settings/node-state.js";
import { COMMON_SETTINGS_FORMAT, commonSettingsRevision } from "../src/common-settings/document.js";
import { SecretStore, SettingsStore, settingsFingerprint } from "../src/web/settings-store.js";

const LEGACY_LOCAL_SECRET = "synthetic-legacy-local-secret";
const LEGACY_DOCUMENT_SECRET = "synthetic-legacy-document-secret";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "herder-common-state-migration-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function legacyState() {
  return {
    optIn: true,
    role: "member",
    appliedRevision: "revision-before-migration",
    appliedAt: "2026-10-01T00:00:00.000Z",
    document: null,
    conflicts: [{
      id: "herder.env/NOTIFY_CENTER_TOKEN",
      commonValue: null,
      localValue: LEGACY_LOCAL_SECRET,
      kind: "local-change",
      detectedAt: "2026-10-01T00:00:00.000Z",
      open: true,
    }],
    rollback: { "herder.env/NOTIFY_CENTER_TOKEN": LEGACY_LOCAL_SECRET },
  };
}

describe("legacy common-settings secret migration", () => {
  it("stores the rollback value before redacting state and restores it on retry", async () => {
    const envPath = join(directory, "herder.env");
    const settings = new SettingsStore({
      envPath,
      nodeConfigPath: join(directory, "node-config.json"),
      stateDir: join(directory, "settings"),
    });
    const statePath = join(directory, "common-settings.json");
    await writeFile(statePath, `${JSON.stringify(legacyState(), null, 2)}\n`);
    const stateStore = new CommonSettingsStateStore({
      path: statePath,
      secretStore: settings.secretStore,
    });

    const state = await stateStore.read();
    expect(state.appliedRevision).toBe("revision-before-migration");
    expect(state.conflicts[0]?.localValue).toBeNull();
    expect(state.conflicts[0]?.localFingerprint).toBe(settingsFingerprint(LEGACY_LOCAL_SECRET));
    expect(state.rollback["herder.env/NOTIFY_CENTER_TOKEN"]).toBe(settingsFingerprint(LEGACY_LOCAL_SECRET));

    const redactedFile = await readFile(statePath, "utf8");
    expect(redactedFile).not.toContain(LEGACY_LOCAL_SECRET);
    expect(JSON.parse(redactedFile).conflicts[0].localValue).toBeNull();
    expect(await settings.secretStore.readLocal("NOTIFY_CENTER_TOKEN")).toBe(LEGACY_LOCAL_SECRET);

    // A repeated read after an interrupted migration is safe and retains the
    // value required by the existing restore path.
    await stateStore.read();
    const restored = await restoreCommonSettingsLocalValues({
      target: settings,
      state,
      hostId: "synthetic-node",
    });
    expect(restored.ok).toBe(true);
    expect(await settings.readSecretValue("NOTIFY_CENTER_TOKEN")).toBe(LEGACY_LOCAL_SECRET);
  });

  it("fails closed without a SecretStore and leaves the legacy state intact", async () => {
    const statePath = join(directory, "common-settings.json");
    const legacy = `${JSON.stringify(legacyState(), null, 2)}\n`;
    await writeFile(statePath, legacy);
    const stateStore = new CommonSettingsStateStore({ path: statePath });

    await expect(stateStore.read()).rejects.toThrow("without the node SecretStore");
    expect(await readFile(statePath, "utf8")).toBe(legacy);
    expect(await new SecretStore({ path: join(directory, "secrets.json") }).readLocal("NOTIFY_CENTER_TOKEN")).toBeUndefined();
  });

  it("migrates a document-only secret and preserves its revision for export", async () => {
    const settings = new SettingsStore({
      envPath: join(directory, "herder.env"),
      nodeConfigPath: join(directory, "node-config.json"),
      stateDir: join(directory, "settings"),
    });
    const environment = { NOTIFY_CENTER_TOKEN: LEGACY_DOCUMENT_SECRET };
    const revision = commonSettingsRevision({ environment });
    const statePath = join(directory, "common-settings.json");
    const state = {
      optIn: true,
      role: "member",
      appliedRevision: revision,
      appliedAt: "2026-10-02T00:00:00.000Z",
      document: {
        format: COMMON_SETTINGS_FORMAT,
        revision,
        owner: "synthetic-owner",
        createdAt: "2026-10-02T00:00:00.000Z",
        environment,
      },
      conflicts: [],
      rollback: {},
    };
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const stateStore = new CommonSettingsStateStore({ path: statePath, secretStore: settings.secretStore });

    const loaded = await stateStore.read();
    expect(loaded.appliedRevision).toBe(revision);
    expect(loaded.document?.revision).toBe(revision);
    expect(loaded.document?.environment.NOTIFY_CENTER_TOKEN).toBe(settingsFingerprint(LEGACY_DOCUMENT_SECRET));

    const stored = await readFile(statePath, "utf8");
    expect(stored).not.toContain(LEGACY_DOCUMENT_SECRET);
    expect(JSON.parse(stored).document.revision).toBe(revision);
    expect(await settings.secretStore.readSecret("NOTIFY_CENTER_TOKEN")).toBe(LEGACY_DOCUMENT_SECRET);

    const service = new CommonSettingsNodeService({
      hostId: "synthetic-node",
      role: "member",
      stateStore,
      target: settings,
    });
    const exported = await service.document();
    expect(exported?.revision).toBe(revision);
    expect(exported?.environment.NOTIFY_CENTER_TOKEN).toBe(LEGACY_DOCUMENT_SECRET);
  });
});
