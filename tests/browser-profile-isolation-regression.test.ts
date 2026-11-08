import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { makeConfiguredAdapter, serveBrowserChatAhap } from "../src/ahap-browser-runner.js";
import { ChatGptMacCdpDriver } from "../src/adapters/chatgpt-mac-cdp-driver.js";
import { CHATGPT_CREATE_SCOPE_SCRIPT } from "../src/adapters/browser-chat-new-page.js";
import { ZAI_LIST_API_SCRIPT } from "../src/adapters/browser-chat-api-scripts.js";
import type { ChromePageTools } from "../src/adapters/mac-mini-chrome-transport.js";

const A = "a".repeat(64), B = "b".repeat(64);
const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const json = (value: unknown) => "```json\n" + JSON.stringify(value) + "\n```";
const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it("two-account consumer fixture rejects duplicate account scopes before native bootstrap", () => {
  const script = `
import hashlib,json,sys,tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path('tests/native').resolve()))
import v1_multi_browser_stand as stand
with tempfile.TemporaryDirectory() as folder:
    root=Path(folder);artifact=root/'artifact';artifact.write_bytes(b'fixture')
    sha=hashlib.sha256(b'fixture').hexdigest()
    manifest={k:str(artifact) for k in ['core','node','bootstrap']}
    manifest.update(source_commit='fixture',adapters={'chatgpt':str(artifact)},sha256={**{k:sha for k in ['core','node','bootstrap']},'adapters':{'chatgpt':sha}})
    path=root/'manifest.json';path.write_text(json.dumps(manifest))
    with patch.object(stand.subprocess,'check_output',side_effect=RuntimeError('native bootstrap reached')) as bootstrap:
        try:stand.run(path,['a'*64,'a'*64],root/'run',stage='candidate')
        except Exception as error:print(json.dumps({'error':type(error).__name__,'bootstrap_calls':bootstrap.call_count}))
`;
  const result = JSON.parse(execFileSync("python3", ["-I", "-c", script], { encoding: "utf8" }));
  expect(result).toEqual({ error: "ValueError", bootstrap_calls: 0 });
});

it("ChatGPT archive selects its own account after page renumbering and fresh driver restart", async () => {
  let ids = [7, 11];
  const archived: number[] = [];
  const writes: string[] = [];
  const tools: ChromePageTools = { call: async (name, args = {}) => {
    if (name === "list_pages") return ids.map((id, i) => `${id}: Profile (https://chatgpt.com/?herder_owned=chatgpt%3A${i ? B : A})`).join("\n");
    if (name === "evaluate_script") {
      const script = String(args.function), page = Number(args.pageId);
      if (script === CHATGPT_CREATE_SCOPE_SCRIPT) return json({ scope: page === ids[0] ? A : B });
      if (script.includes("is_archived")) { archived.push(page); return json({ ok: true }); }
    }
    writes.push(name);
    throw new Error("unexpected " + name);
  } };
  for (const restart of [false, true]) {
    if (restart) ids = [41, 3];
    const driver = new ChatGptMacCdpDriver(tools, undefined, 0, A);
    await driver.verifyPinnedAccountScope();
    expect(await driver.archiveChat(ID)).toEqual({ ok: true });
  }
  expect(archived).toEqual([7, 41]);
  expect(writes).toEqual([]);
});

it("ChatGPT rejects duplicate account window markers after SPA removed both URL markers", async () => {
  const scopesRead: number[] = [];
  const tools: ChromePageTools = { call: async (name, args = {}) => {
    if (name === "list_pages") return `7: Profile (https://chatgpt.com/c/${ID})\n11: Duplicate (https://chatgpt.com/)`;
    if (name === "evaluate_script") {
      if (String(args.function).includes("window.name ===")) return json({ owned: true });
      if (args.function === CHATGPT_CREATE_SCOPE_SCRIPT) { scopesRead.push(Number(args.pageId)); return json({ scope: A }); }
    }
    throw new Error("unexpected " + name);
  } };
  await expect(new ChatGptMacCdpDriver(tools, undefined, 0, A).verifyPinnedAccountScope())
    .rejects.toThrow("duplicate_owned_browser_tabs");
  expect(scopesRead).toEqual([]);
});

it("configured Zai create refuses account drift instead of rebinding its draft to another profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-isolation-drafts-"));
  temporary.push(root);
  vi.stubEnv("AGENT_HERDER_BROWSER_DRAFT_ROOT", root);
  vi.stubEnv("AGENT_HERDER_BROWSER_INVENTORY_ROOT", root);
  let scope = A;
  const tools: ChromePageTools = { call: async (name, args = {}) => {
    if (name === "list_pages") return "7: Zai (https://chat.z.ai/?herder_owned=zai)";
    if (name === "evaluate_script") {
      if (String(args.function).includes("herder-owned:")) return json({ owned: true });
      if (args.function === ZAI_LIST_API_SCRIPT) return json({ scope, chats: [] });
      return json({ origin: "https://chat.z.ai", loggedIn: true, composer: true, phase: "idle", chats: [] });
    }
    throw new Error("unexpected " + name);
  } };
  const adapter = makeConfiguredAdapter({ AHAP_HARNESS: "zai", AHAP_BROWSER_TRANSPORT: "mac-mini", AHAP_BROWSER_ACCOUNT_SCOPE: A },
    { macMini: () => tools, directCdp: () => { throw new Error("wrong transport"); } });
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", chunk => { text += chunk; });
  // The tab switches after successful AHAP init, immediately before create.
  // Passive inventory initialization is unrelated to this mutation guard.
  adapter.init = async () => { scope = B; };
  const serving = serveBrowserChatAhap(adapter, input, output, A);
  input.end([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { harness: "zai", ahapVersion: "0.1" } },
    { jsonrpc: "2.0", id: 2, method: "init" },
    { jsonrpc: "2.0", id: 3, method: "createSession", params: { options: { name: "must remain account A", cwd: "/fixture" } } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  await serving;
  const replies = text.trim().split("\n").map(line => JSON.parse(line));
  expect(replies[1].error).toBeUndefined();
  expect(replies[2].result).toBeUndefined();
  expect(replies[2].error).toBeDefined();
});
