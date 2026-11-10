import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserChatAdapter } from "../src/adapters/browser-chat.js";
import { ZaiCdpDriver, ZAI_ACTIVITY_SCRIPT } from "../src/adapters/zai-cdp-driver.js";
import { ZAI_LIST_API_SCRIPT } from "../src/adapters/browser-chat-api-scripts.js";
import { ZAI_CURRENT_ACCOUNT_SCOPE_SCRIPT } from "../src/adapters/browser-chat-new-page.js";
import { setHarnessRuntimeSettingsPathForTests } from "../src/harness-runtime-settings.js";

const first = vi.hoisted(() => vi.fn());
vi.mock("../src/adapters/browser-chat-new-page.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/adapters/browser-chat-new-page.js")>(),
  submitFirstChatMessage: first,
}));
const scope = "a".repeat(64), other = "b".repeat(64);
const native = "123e4567-e89b-12d3-a456-426614174000", route = "/c/" + native;
const json = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";
const roots: string[] = [];
afterEach(async () => {
  setHarnessRuntimeSettingsPathForTests(undefined);
  vi.unstubAllEnvs(); vi.restoreAllMocks(); first.mockReset();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(pinned = true) {
  const root = await mkdtemp(join(tmpdir(), "zai-fg-")); roots.push(root);
  vi.stubEnv("AGENT_HERDER_BROWSER_DRAFT_ROOT", join(root, "drafts"));
  vi.stubEnv("AGENT_HERDER_BROWSER_CHAT_INVENTORY_ROOT", join(root, "inventory"));
  const settings = join(root, "settings.json");
  await writeFile(settings, JSON.stringify({ version: 1, pollingEnabled: false }));
  setHarnessRuntimeSettingsPathForTests(settings);
  const state = { scope, path: route, origin: "https://chat.z.ai", phase: "idle", failRead: false,
    selected: true, composer: "", securityVerification: false, accountReadFails: false };
  const calls: Array<{name: string; source: string}> = [];
  const messages: Array<{id: string; role: "user" | "assistant"; text: string}> = [];
  let sends = 0;
  const driver = new ZaiCdpDriver({ async call(name, args = {}) {
    const source = String(args.function ?? ""); calls.push({ name, source });
    if (name === "list_pages") return state.selected ? `7: Z.ai (https://chat.z.ai${state.path})` : "";
    if (name === "take_snapshot") return 'uid=1_1 textbox "Send a Message"';
    if (name === "fill") { state.composer = String(args.value); return "ok"; }
    if (name !== "evaluate_script") throw new Error("unexpected browser mutation: " + name);
    if (source === ZAI_LIST_API_SCRIPT || source === ZAI_CURRENT_ACCOUNT_SCOPE_SCRIPT) {
      if (state.accountReadFails) throw new Error("account read failed");
      return json({ scope: state.scope, chats: [] });
    }
    if (source === ZAI_ACTIVITY_SCRIPT) return json({ origin: state.origin, path: state.path,
      loggedIn: true, composer: true, titles: [], phase: state.phase, draftPresent: false,
      securityVerification: state.securityVerification });
    if (source.includes("/messages/batch")) {
      if (state.failRead) throw new Error("read unavailable");
      return json({ messages });
    }
    if (source.includes("const expected =")) {
      sends++; messages.push({ id: "user-second", role: "user", text: state.composer });
      state.composer = "";
      return json({ submitted: true });
    }
    if (source.includes("remaining:")) return json({ remaining: "", origin: "https://chat.z.ai", path: state.path });
    if (source.includes("editor.value")) return json({ value: state.composer });
    if (source.includes('window.name === "herder-owned:zai:' + scope + '"')) return json({ owned: true });
    return json({}); // owned-tab lookup: configured exact page7 is the fallback
  } }, pinned ? 7 : undefined, 0);
  first.mockImplementation(async () => {
    sends++; messages.push({ id: "user-first", role: "user", text: "first" });
    return { clicked: true, uncertain: false, remoteId: "route:" + native };
  });
  const adapter = new BrowserChatAdapter(driver,
    { id: "zai", name: "Z.ai", harness: "zai", cwd: "/browser/zai" }, "/browser/zai", true, true);
  const created = await adapter.createSession({ name: "owned draft", cwd: "/browser/zai" });
  expect(await adapter.sendMessage(created.id, { message: "first", inputId: "first-input", queue: true }))
    .toMatchObject({ ok: true, admitted: true, nativeInputMessageId: "user-first" });
  const draft = decodeURIComponent(created.id.split("::")[1]!);
  expect(driver.getKnownChat(draft)?.working).toBe(true);
  messages.push({ id: "assistant-first", role: "assistant", text: "answer first" });
  const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 3000);
  return { root, driver, adapter, created, draft, state, calls, messages, sends: () => sends };
}

describe("Z.ai foreground admitted draft activity", () => {
  it("create/send/read/idle permits the second exact correlated delivery while background is paused", async () => {
    const f = await fixture();
    expect(await f.adapter.getSessionMessages(f.created.id)).toMatchObject([
      { id: "user-first" }, { id: "assistant-first" },
    ]);
    f.calls.length = 0;
    expect((await f.adapter.getSession(f.created.id))?.status).toBe("idle");
    expect(f.driver.getKnownChat(f.draft)).toMatchObject({ id: f.draft, working: false });
    const stored = JSON.parse(await readFile(join(f.root, "inventory", "zai", scope, "inventory.json"), "utf8"));
    expect(stored.chats).toContainEqual(expect.objectContaining({ id: native, lastRunStatus: "completed" }));
    expect(f.calls.some(call => call.source === ZAI_ACTIVITY_SCRIPT)).toBe(true);
    expect(f.calls.filter(call => call.source === ZAI_LIST_API_SCRIPT)).toHaveLength(0);
    expect(f.calls.filter(call => call.source === ZAI_CURRENT_ACCOUNT_SCOPE_SCRIPT)).toHaveLength(1);
    expect(f.calls.every(call => ["evaluate_script", "list_pages"].includes(call.name))).toBe(true);
    const second = await f.adapter.sendMessage(f.created.id, { message: "second", inputId: "second-input", queue: true });
    expect(second).toMatchObject({ ok: true, admitted: true, nativeInputMessageId: "user-second" });
    expect(first).toHaveBeenCalledTimes(1);
    expect(f.sends()).toBe(2);
  });

  it("keeps the default background refresh paused without any browser request", async () => {
    const f = await fixture(); f.calls.length = 0;
    expect(await f.adapter.refreshSession(f.created.id)).toBe(false);
    expect(await f.driver.refreshTurnState(f.draft)).toBe(false);
    expect(f.calls).toEqual([]);
    expect(f.driver.getKnownChat(f.draft)?.working).toBe(true);
    const background = new BrowserChatAdapter(f.driver,
      { id: "zai", name: "Z.ai", harness: "zai", cwd: "/browser/zai" });
    expect((await background.getSession(f.draft))?.status).toBe("running");
    expect(f.calls).toEqual([]);
  });

  it("resolves an unpinned exact account-owned tab without opening or selecting a page", async () => {
    const f = await fixture(false); f.calls.length = 0;
    expect((await f.adapter.getSession(f.created.id))?.status).toBe("idle");
    expect(f.calls.every(call => ["evaluate_script", "list_pages"].includes(call.name))).toBe(true);
    expect(f.sends()).toBe(1);
  });

  it.each(["account", "account_read", "origin", "path", "missing", "generating", "unknown", "security"] as const)(
    "does not release stale busy admission on %s mismatch", async mismatch => {
      const f = await fixture(); f.calls.length = 0;
      if (mismatch === "account") f.state.scope = other;
      if (mismatch === "account_read") f.state.accountReadFails = true;
      if (mismatch === "origin") f.state.origin = "https://other.invalid";
      if (mismatch === "security") f.state.securityVerification = true;
      if (mismatch === "path") f.state.path = "/c/123e4567-e89b-12d3-a456-426614174099";
      if (mismatch === "missing") f.state.selected = false;
      if (mismatch === "generating" || mismatch === "unknown") f.state.phase = mismatch;
      expect((await f.adapter.getSession(f.created.id))?.status).toBe("running");
      expect(f.driver.getKnownChat(f.draft)?.working).toBe(true);
      expect(first).toHaveBeenCalledTimes(1); expect(f.sends()).toBe(1);
      expect(f.calls.every(call => ["evaluate_script", "list_pages"].includes(call.name))).toBe(true);
    });
});
