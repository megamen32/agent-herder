import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PREWARM_LIMIT,
  HARNESS_RUNTIME_SETTINGS_FILE_NAME,
  HarnessRuntimeSettingsError,
  HarnessRuntimeSettingsStore,
  emptyHarnessRuntimeSettings,
  harnessHooksEnabled,
  harnessPollingEnabled,
  harnessPrewarmLimit,
  harnessPromptPollingEnabled,
  harnessRuntimeView,
  liveHarnessPollingEnabled,
  parseHarnessRuntimeSettings,
  readHarnessRuntimeSettingsLive,
  setHarnessRuntimeSettingsPathForTests,
} from "../src/harness-runtime-settings.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-runtime-settings-"));
});

afterEach(async () => {
  setHarnessRuntimeSettingsPathForTests(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("the document of the runtime switches", () => {
  it("starts with every harness polling and every harness hooked", () => {
    const document = emptyHarnessRuntimeSettings();
    expect(document.pollingEnabled).toBe(true);
    expect(harnessPollingEnabled(document, "chatgpt")).toBe(true);
    expect(harnessPollingEnabled(document, "zai")).toBe(true);
    expect(harnessPollingEnabled(document, "codex")).toBe(true);
    expect(harnessPromptPollingEnabled(document, "chatgpt")).toBe(true);
    expect(harnessHooksEnabled(document, "claude")).toBe(true);
    expect(harnessHooksEnabled(document, "codex")).toBe(true);
    expect(harnessPrewarmLimit(document, "chatgpt")).toBe(DEFAULT_PREWARM_LIMIT);
  });

  it("pauses every harness when the master switch is off", () => {
    const document = { ...emptyHarnessRuntimeSettings(), pollingEnabled: false, harnesses: { zai: { pollingEnabled: true } } };
    expect(harnessPollingEnabled(document, "chatgpt")).toBe(false);
    // An explicit per-harness true must not outvote the master switch.
    expect(harnessPollingEnabled(document, "zai")).toBe(false);
    expect(harnessPromptPollingEnabled(document, "chatgpt")).toBe(false);
    // The hooks of a harness are an independent switch: a paused site keeps
    // its hooks, and a silent harness keeps its polling.
    expect(harnessHooksEnabled(document, "chatgpt")).toBe(true);
  });

  it("pauses one harness without touching the others", () => {
    const document = {
      ...emptyHarnessRuntimeSettings(),
      harnesses: { chatgpt: { pollingEnabled: false } },
    };
    expect(harnessPollingEnabled(document, "chatgpt")).toBe(false);
    expect(harnessPollingEnabled(document, "zai")).toBe(true);
  });

  it("switches the ChatGPT modal-prompt poller on its own", () => {
    const document = {
      ...emptyHarnessRuntimeSettings(),
      harnesses: { chatgpt: { promptPollingEnabled: false } },
    };
    expect(harnessPromptPollingEnabled(document, "chatgpt")).toBe(false);
    // The prompt poller belongs to the harness: polling off means the
    // prompt poller off even without its own override.
    const paused = {
      ...emptyHarnessRuntimeSettings(),
      harnesses: { chatgpt: { pollingEnabled: false } },
    };
    expect(harnessPromptPollingEnabled(paused, "chatgpt")).toBe(false);
    // Another harness is not affected by the ChatGPT override.
    expect(harnessPromptPollingEnabled(document, "zai")).toBe(true);
  });

  it("resolves the prewarm budget: override, then environment, then default", () => {
    const previous = process.env.AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT;
    try {
      const document = {
        ...emptyHarnessRuntimeSettings(),
        harnesses: { chatgpt: { prewarmLimit: 10 }, zai: { prewarmLimit: 0 } },
      };
      expect(harnessPrewarmLimit(document, "chatgpt")).toBe(10);
      expect(harnessPrewarmLimit(document, "zai")).toBe(0);
      process.env.AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT = "7";
      expect(harnessPrewarmLimit(document, "codex")).toBe(7);
      delete process.env.AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT;
      expect(harnessPrewarmLimit(document, "codex")).toBe(DEFAULT_PREWARM_LIMIT);
      process.env.AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT = "5000";
      expect(harnessPrewarmLimit(document, "codex")).toBe(DEFAULT_PREWARM_LIMIT);
    } finally {
      if (previous === undefined) delete process.env.AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT;
      else process.env.AGENT_HERDER_BROWSER_CHAT_PREWARM_LIMIT = previous;
    }
  });

  it("silences the hooks of one harness and leaves the others running", () => {
    const document = {
      ...emptyHarnessRuntimeSettings(),
      harnesses: { codex: { hooksEnabled: false } },
    };
    expect(harnessHooksEnabled(document, "codex")).toBe(false);
    expect(harnessHooksEnabled(document, "claude")).toBe(true);
    expect(harnessPollingEnabled(document, "codex")).toBe(true);
  });

  it("refuses a text that is not a document of this version", () => {
    expect(() => parseHarnessRuntimeSettings("{")).toThrow(HarnessRuntimeSettingsError);
    expect(() => parseHarnessRuntimeSettings("[]")).toThrow(HarnessRuntimeSettingsError);
    expect(() => parseHarnessRuntimeSettings(JSON.stringify({ version: 2 }))).toThrow(/версия/i);
    expect(() => parseHarnessRuntimeSettings(JSON.stringify({ version: 1, pollingEnabled: "yes" }))).toThrow(/pollingEnabled/i);
    expect(() => parseHarnessRuntimeSettings(JSON.stringify({ version: 1, harnesses: { chatgpt: { prewarmLimit: 500 } } }))).toThrow(/prewarmLimit/i);
    const parsed = parseHarnessRuntimeSettings(JSON.stringify({
      version: 1,
      pollingEnabled: false,
      harnesses: { chatgpt: { pollingEnabled: true, hooksEnabled: false, prewarmLimit: 5 } },
      changedBy: "owner",
    }));
    expect(parsed.pollingEnabled).toBe(false);
    expect(parsed.harnesses.chatgpt).toEqual({ pollingEnabled: true, hooksEnabled: false, prewarmLimit: 5 });
    expect(parsed.changedBy).toBe("owner");
  });
});

describe("the store of the owner's panel", () => {
  it("reads the defaults when the file is absent", async () => {
    const store = new HarnessRuntimeSettingsStore(join(dir, HARNESS_RUNTIME_SETTINGS_FILE_NAME));
    expect(await store.read()).toEqual(emptyHarnessRuntimeSettings());
  });

  it("applies a change, writes it atomically and journals it", async () => {
    const store = new HarnessRuntimeSettingsStore(join(dir, HARNESS_RUNTIME_SETTINGS_FILE_NAME));
    const after = await store.update(
      { pollingEnabled: false, harnesses: { chatgpt: { pollingEnabled: false, prewarmLimit: 12 } } },
      { by: "owner", reason: "пауза запросов chatgpt" },
    );
    expect(after.pollingEnabled).toBe(false);
    expect(after.harnesses.chatgpt).toEqual({ pollingEnabled: false, prewarmLimit: 12 });
    expect(after.reason).toBe("пауза запросов chatgpt");
    // The next reader sees the same document from the durable file.
    expect(await store.read()).toEqual(after);
    const audit = await readFile(join(dir, "harness-runtime-settings.audit.jsonl"), "utf8");
    expect(audit).toContain("пауза запросов chatgpt");
    expect(audit).toContain('"after"');
  });

  it("merges fields, clears with null and drops an emptied harness", async () => {
    const store = new HarnessRuntimeSettingsStore(join(dir, HARNESS_RUNTIME_SETTINGS_FILE_NAME));
    await store.update({ harnesses: { chatgpt: { pollingEnabled: false, hooksEnabled: false } } }, { by: "owner" });
    const merged = await store.update(
      { harnesses: { chatgpt: { pollingEnabled: null, prewarmLimit: 3 } } },
      { by: "owner" },
    );
    expect(merged.harnesses.chatgpt).toEqual({ hooksEnabled: false, prewarmLimit: 3 });
    const cleared = await store.update(
      { harnesses: { chatgpt: { hooksEnabled: null, prewarmLimit: null } } },
      { by: "owner" },
    );
    expect(cleared.harnesses.chatgpt).toBeUndefined();
  });

  it("refuses a value the document cannot carry", async () => {
    const store = new HarnessRuntimeSettingsStore(join(dir, HARNESS_RUNTIME_SETTINGS_FILE_NAME));
    await expect(store.update({ pollingEnabled: "yes" as unknown as boolean }, { by: "owner" })).rejects.toThrow(HarnessRuntimeSettingsError);
    await expect(store.update({ harnesses: { chatgpt: { prewarmLimit: 999 } } }, { by: "owner" })).rejects.toThrow(/prewarmLimit/i);
    await expect(store.update({ harnesses: { "bad harness!": { pollingEnabled: true } } }, { by: "owner" })).rejects.toThrow(/имя харнесса/i);
    // Nothing was written by a refused change.
    expect(await store.read()).toEqual(emptyHarnessRuntimeSettings());
  });
});

describe("the live view of the pollers", () => {
  it("follows the file on every change", async () => {
    const path = join(dir, HARNESS_RUNTIME_SETTINGS_FILE_NAME);
    await writeFile(path, JSON.stringify({ version: 1, pollingEnabled: true }), "utf8");
    setHarnessRuntimeSettingsPathForTests(path);
    expect(liveHarnessPollingEnabled("chatgpt")).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 12));
    await writeFile(path, JSON.stringify({ version: 1, pollingEnabled: false, harnesses: { chatgpt: { hooksEnabled: false } } }), "utf8");
    expect(liveHarnessPollingEnabled("chatgpt")).toBe(false);
    expect(readHarnessRuntimeSettingsLive().harnesses.chatgpt).toEqual({ hooksEnabled: false });
  });

  it("answers with the defaults when the file is missing or unreadable", async () => {
    setHarnessRuntimeSettingsPathForTests(join(dir, "absent.json"));
    expect(liveHarnessPollingEnabled("zai")).toBe(true);
    const broken = join(dir, "broken.json");
    await writeFile(broken, "{not json", "utf8");
    setHarnessRuntimeSettingsPathForTests(broken);
    expect(liveHarnessPollingEnabled("zai")).toBe(true);
  });
});

describe("the page view of the settings", () => {
  it("shows every adapter and every override with its effective switch", () => {
    const document = {
      ...emptyHarnessRuntimeSettings(),
      harnesses: { chatgpt: { pollingEnabled: false, promptPollingEnabled: false, prewarmLimit: 8 }, zai: { hooksEnabled: false } },
    };
    const view = harnessRuntimeView(document, [
      { id: "chatgpt", name: "ChatGPT (Mac mini CDP)" },
      { id: "codex", name: "Codex" },
    ]);
    expect(view.ok).toBe(true);
    expect(view.pollingEnabled).toBe(true);
    const byId = Object.fromEntries(view.harnesses.map(harness => [harness.id, harness]));
    expect(byId.chatgpt.pollingEnabled).toBe(false);
    expect(byId.chatgpt.pollingOverride).toBe(false);
    expect(byId.chatgpt.promptPollingEnabled).toBe(false);
    expect(byId.chatgpt.prewarmLimit).toBe(8);
    expect(byId.chatgpt.name).toBe("ChatGPT (Mac mini CDP)");
    expect(byId.codex.pollingEnabled).toBe(true);
    expect(byId.codex.pollingOverride).toBeNull();
    expect(byId.codex.hooksEnabled).toBe(true);
    // A harness with an override appears even without an adapter.
    expect(byId.zai.hooksEnabled).toBe(false);
    expect(byId.zai.name).toBeNull();
  });
});
