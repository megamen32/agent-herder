/**
 * The value of a secret lives in one file of the node and in no other.
 *
 * The file of the state of the node and the file of the product are files that
 * everybody with an account on the machine can read. The value of a secret
 * goes into neither of them: the state of the node keeps the fingerprint of
 * the value, the file of the product keeps its marker, and the raw value lives
 * in the store of the secrets alone.
 *
 * The node stays a working node: it takes the document of the owner, applies
 * it, and hands the document on — the values are put back on the way, and the
 * revision of the document is the check that they are the right ones.
 *
 * The secrets of this test are fictional: `stand-common-secret` and
 * `stand-local-secret`. No value of a living node is written here.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCommonDocument,
  CommonSettingsNodeService,
  CommonSettingsStateStore,
  type CommonSettingsDocument,
  type CommonSettingsTarget,
} from "../src/common-settings/index.js";
import { loadSecretEnvironment, SettingsStore, settingsFingerprint } from "../src/web/settings-store.js";

/** The secret the owner of the document sends. */
const COMMON_SECRET = "stand-common-secret";
/** The secret the node held before the document was applied. */
const LOCAL_SECRET = "stand-local-secret";

let configDir = "";
let stateDir = "";

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "herder-secret-store-"));
  stateDir = await mkdtemp(join(tmpdir(), "herder-secret-store-state-"));
});

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

/** The store of the settings of a node whose file of the product is empty. */
function storeOf(node: { env?: Record<string, string> } = {}): SettingsStore {
  const envPath = join(configDir, "herder.env");
  return new SettingsStore({
    envPath,
    nodeConfigPath: join(configDir, "node-config.json"),
    stateDir: join(stateDir, "settings"),
    actor: "owner",
    hostId: "stand-node",
  });
}

/** The settings of a node, as a fake of the product of the node. */
function fakeTarget(initial: Record<string, string> = {}) {
  const values: Record<string, string> = { ...initial };
  const local: Record<string, string> = {};
  const target: CommonSettingsTarget = {
    async readEnvironment() {
      return {
        values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { present: true, value }])),
      };
    },
    async readSecretValue(key: string) { return values[key]; },
    async applyEnvironment(changes: Record<string, string | null>) {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete values[key];
        else values[key] = value;
      }
      return [];
    },
    async keepLocalSecretValue(key: string, value: string | undefined) {
      if (value === undefined) delete local[key];
      else local[key] = value;
    },
    async readLocalSecretValue(key: string) { return local[key]; },
  };
  return { values, local, target };
}

describe("the file of the product keeps the marker of a secret", () => {
  it("holds no value of a secret after the secret was written", async () => {
    const store = storeOf();
    await store.applyEnvironment({ NOTIFY_CENTER_TOKEN: COMMON_SECRET });

    const text = await readFile(join(configDir, "herder.env"), "utf8");
    expect(text).not.toContain(COMMON_SECRET);
    expect(text).toContain(`NOTIFY_CENTER_TOKEN=${settingsFingerprint(COMMON_SECRET)}`);

    // The value is in the store of the secrets and nowhere else.
    expect(await store.readSecretValue("NOTIFY_CENTER_TOKEN")).toBe(COMMON_SECRET);
    const secrets = JSON.parse(await readFile(join(configDir, "secrets.json"), "utf8"));
    expect(secrets.secrets.NOTIFY_CENTER_TOKEN).toBe(COMMON_SECRET);
    expect((await stat(join(configDir, "secrets.json"))).mode & 0o777).toBe(0o600);
  });

  it("answers with the fingerprint of the value and never with the value", async () => {
    const store = storeOf();
    await store.applyEnvironment({ NOTIFY_CENTER_TOKEN: COMMON_SECRET });

    const view = await store.readEnvironment();
    const secret = view.values.NOTIFY_CENTER_TOKEN!;
    expect(secret.kind).toBe("secret");
    expect(secret.configured).toBe(true);
    expect(secret.fingerprint).toBe(settingsFingerprint(COMMON_SECRET));
    expect(secret.value).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain(COMMON_SECRET);
  });

  it("keeps no value of a secret in the undo stack and puts the old value back", async () => {
    const store = storeOf();
    await store.applyEnvironment({ NOTIFY_CENTER_TOKEN: LOCAL_SECRET });
    await store.applyEnvironment({ NOTIFY_CENTER_TOKEN: COMMON_SECRET });

    const history = await readFile(join(stateDir, "settings", "history.json"), "utf8");
    expect(history).not.toContain(LOCAL_SECRET);
    expect(history).not.toContain(COMMON_SECRET);

    // The rollback of a secret puts the value it had before back.
    await store.rollback({ entity: "herder.env", key: "NOTIFY_CENTER_TOKEN" });
    expect(await store.readSecretValue("NOTIFY_CENTER_TOKEN")).toBe(LOCAL_SECRET);
    const env = await readFile(join(configDir, "herder.env"), "utf8");
    expect(env).not.toContain(LOCAL_SECRET);
  });

  it("takes the raw value that the file of the product still holds over", async () => {
    const envPath = join(configDir, "herder.env");
    await writeFile(envPath, `NOTIFY_CENTER_TOKEN=${LOCAL_SECRET}\n`, { mode: 0o600 });
    const store = storeOf();

    const adopted = await store.adoptLegacySecrets();
    expect(adopted).toEqual(["NOTIFY_CENTER_TOKEN"]);

    const text = await readFile(envPath, "utf8");
    expect(text).not.toContain(LOCAL_SECRET);
    expect(text).toContain(`NOTIFY_CENTER_TOKEN=${settingsFingerprint(LOCAL_SECRET)}`);
    expect(await store.readSecretValue("NOTIFY_CENTER_TOKEN")).toBe(LOCAL_SECRET);
  });

  it("puts the value of the secret into the environment of the process", async () => {
    const store = storeOf();
    await store.applyEnvironment({ NOTIFY_CENTER_TOKEN: COMMON_SECRET });
    const env: NodeJS.ProcessEnv = {};

    const loaded = await loadSecretEnvironment({ store, env });
    expect(loaded.loaded).toContain("NOTIFY_CENTER_TOKEN");
    expect(env.NOTIFY_CENTER_TOKEN).toBe(COMMON_SECRET);
  });
});

describe("the file of the state of the node holds no value of a secret", () => {
  /** The document of the owner, with a secret in it. */
  function documentOfOwner(): CommonSettingsDocument {
    return buildCommonDocument({
      owner: "stand-owner",
      environment: {
        NOTIFY_CENTER_PROJECT: "agent-herder",
        NOTIFY_CENTER_TOKEN: COMMON_SECRET,
      },
    });
  }

  it("keeps the fingerprint of the secret and never its value", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_TOKEN: LOCAL_SECRET });
    const statePath = join(stateDir, "common-settings.json");
    const service = new CommonSettingsNodeService({
      hostId: "stand-node",
      role: "member",
      ownerHostId: "stand-owner",
      stateStore: new CommonSettingsStateStore({ path: statePath }),
      target: node.target,
    });

    const result = await service.apply(documentOfOwner());
    expect(result.ok).toBe(true);

    const text = await readFile(statePath, "utf8");
    expect(text).not.toContain(COMMON_SECRET);
    expect(text).not.toContain(LOCAL_SECRET);

    const state = JSON.parse(text);
    // The document of the node keeps the marker of the secret.
    expect(state.document.environment.NOTIFY_CENTER_TOKEN).toBe(settingsFingerprint(COMMON_SECRET));
    // The deviation keeps the fingerprints of both sides and no value.
    const conflict = state.conflicts.find((item: any) => item.id === "herder.env/NOTIFY_CENTER_TOKEN");
    expect(conflict.commonValue).toBeNull();
    expect(conflict.localValue).toBeNull();
    expect(conflict.commonFingerprint).toBe(settingsFingerprint(COMMON_SECRET));
    expect(conflict.localFingerprint).toBe(settingsFingerprint(LOCAL_SECRET));
  });

  it("hands the document on with the values put back", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_TOKEN: LOCAL_SECRET });
    const statePath = join(stateDir, "common-settings.json");
    const service = new CommonSettingsNodeService({
      hostId: "stand-node",
      role: "member",
      ownerHostId: "stand-owner",
      stateStore: new CommonSettingsStateStore({ path: statePath }),
      target: node.target,
    });
    const document = documentOfOwner();
    await service.apply(document);

    // The node hands the document on: the values are put back and the
    // revision of the owner is the check that they are the right ones.
    const handed = await service.document();
    expect(handed).not.toBeNull();
    expect(handed!.revision).toBe(document.revision);
    expect(handed!.environment.NOTIFY_CENTER_TOKEN).toBe(COMMON_SECRET);
    expect(handed!.environment.NOTIFY_CENTER_PROJECT).toBe("agent-herder");
  });

  it("hands nothing on when the secret of the node is not the one of the owner", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_TOKEN: LOCAL_SECRET });
    const statePath = join(stateDir, "common-settings.json");
    const stateStore = new CommonSettingsStateStore({ path: statePath });
    const service = new CommonSettingsNodeService({
      hostId: "stand-node",
      role: "member",
      ownerHostId: "stand-owner",
      stateStore,
      target: node.target,
    });
    const document = documentOfOwner();
    await service.apply(document);

    // The secret of the node is gone: the document cannot be rebuilt, so the
    // node hands on nothing rather than a document that lies about itself.
    node.values.NOTIFY_CENTER_TOKEN = "another-secret-entirely";
    expect(await service.document()).toBeNull();
  });

  it("puts the local value of a secret back", async () => {
    const node = fakeTarget({ NOTIFY_CENTER_TOKEN: LOCAL_SECRET });
    const statePath = join(stateDir, "common-settings.json");
    const service = new CommonSettingsNodeService({
      hostId: "stand-node",
      role: "member",
      ownerHostId: "stand-owner",
      stateStore: new CommonSettingsStateStore({ path: statePath }),
      target: node.target,
    });
    await service.apply(documentOfOwner());
    expect(node.values.NOTIFY_CENTER_TOKEN).toBe(COMMON_SECRET);

    const restored = await service.restore();
    expect(restored.ok).toBe(true);
    expect(node.values.NOTIFY_CENTER_TOKEN).toBe(LOCAL_SECRET);

    // The value of the local secret is in the store of the secrets and in no
    // file of the state.
    const text = await readFile(statePath, "utf8");
    expect(text).not.toContain(LOCAL_SECRET);
  });
});
