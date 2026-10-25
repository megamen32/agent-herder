import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { compactAutomaticMessage, readLongMessage } from "../src/long-messages.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { handleSendMessage, handleNewOrResume } from "../src/mcp-tools/handlers.js";
import { registerControlPlaneTools } from "../src/mcp/control-plane-tools.js";
import { CoordinationNoteStore } from "../src/coordination-notes.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { registerHerderResources } from "../src/mcp/resources.js";
import { HumanRequestRegistry } from "../src/human-request/registry.js";
import { HarnessEventHealthRegistry } from "../src/harness-event-health.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";
import { createHash } from "node:crypto";

let root: string | undefined;
let oldDirectory: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
  if (oldDirectory === undefined) delete process.env.AGENT_HERDER_LONG_MESSAGES_DIR;
  else process.env.AGENT_HERDER_LONG_MESSAGES_DIR = oldDirectory;
  oldDirectory = undefined;
});

describe("durable long automatic messages", () => {
  it("keeps messages through 8000 characters intact and previews the next character with an 8000-character continuation page", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-long-message-boundary-"));
    oldDirectory = process.env.AGENT_HERDER_LONG_MESSAGES_DIR;
    process.env.AGENT_HERDER_LONG_MESSAGES_DIR = join(root, "content");
    const below = "b".repeat(7_999);
    const exact = "e".repeat(8_000);
    expect(await compactAutomaticMessage(below)).toBe(below);
    expect(await compactAutomaticMessage(exact)).toBe(exact);

    const original = "x".repeat(8_001);
    const preview = await compactAutomaticMessage(original);
    expect(preview.slice(0, 8_000)).toBe(original.slice(0, 8_000));
    const id = preview.match(/herder:\/\/m\/([a-f0-9]{8,64})/)?.[1];
    expect(id).toBeTruthy();
    const first = await readLongMessage({ messageId: id! });
    expect(first).toMatchObject({ total: original.length, offset: 0, nextOffset: 8_000 });
    expect(first.text).toBe(original.slice(0, 8_000));
    const second = await readLongMessage({ messageId: id!, offset: first.nextOffset! });
    expect(second.text).toBe(original.slice(8_000));
    expect(second.nextOffset).toBeNull();
  });

  it("stores exact content privately and reconstructs it across store calls", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-long-message-"));
    oldDirectory = process.env.AGENT_HERDER_LONG_MESSAGES_DIR;
    process.env.AGENT_HERDER_LONG_MESSAGES_DIR = join(root, "content");
    const original = `${"first line\n".repeat(900)}tail 🧪`;
    const digest = createHash("sha256").update(original).digest("hex");
    const preview = await compactAutomaticMessage(original);
    const id = preview.match(/herder:\/\/m\/([a-f0-9]{8,64})/)?.[1];
    expect(id).toHaveLength(8);
    expect(preview.length).toBeGreaterThan(8_000);
    expect(preview.length).toBeLessThan(8_100);
    expect(preview.slice(0, 8_000)).toBe(original.slice(0, 8_000));
    expect(preview).not.toContain(digest);
    expect(preview).not.toContain("read_message");
    expect(preview).not.toContain("Fallback");
    expect(preview.length - 8_000).toBeLessThan(40);
    expect(preview).toContain(`herder://m/${id}`);
    expect((await stat(process.env.AGENT_HERDER_LONG_MESSAGES_DIR)).mode & 0o777).toBe(0o700);
    expect((await stat(join(process.env.AGENT_HERDER_LONG_MESSAGES_DIR, `${digest}.txt`))).mode & 0o777).toBe(0o600);

    const first = await readLongMessage({ messageId: id! });
    const second = await readLongMessage({ messageId: id!, offset: first.nextOffset! });
    expect(first.total).toBe(original.length);
    expect(first.sha256).toBe(digest);
    expect(first.nextOffset).toBe(8_000);
    expect(first.text + second.text).toBe(original);
  });

  it("extends colliding short IDs without overwrite and keeps legacy IDs readable", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-short-id-"));
    oldDirectory = process.env.AGENT_HERDER_LONG_MESSAGES_DIR;
    const directory = join(root, "content");
    process.env.AGENT_HERDER_LONG_MESSAGES_DIR = directory;
    await mkdir(directory, {mode:0o700});
    const body = "Exact content with a checked public reference. ".repeat(220);
    const digest = createHash("sha256").update(body).digest("hex");
    const occupied = digest.slice(0,8)+"0".repeat(56);
    await writeFile(join(directory, `ref-${digest.slice(0,8)}`), occupied, {mode:0o600});
    const preview = await compactAutomaticMessage(body);
    const id = preview.match(/herder:\/\/m\/([a-f0-9]+)/)![1]!;
    expect(id).toHaveLength(10);
    expect(await readFile(join(directory, `ref-${digest.slice(0,8)}`),"utf8")).toBe(occupied);
    const first = await readLongMessage({messageId:id});
    const second = await readLongMessage({messageId:id, offset:first.nextOffset!});
    expect(first.text + second.text).toBe(body);
    const legacyFirst = await readLongMessage({messageId:digest});
    const legacySecond = await readLongMessage({messageId:digest, offset:legacyFirst.nextOffset!});
    expect(legacyFirst.text + legacySecond.text).toBe(body);
    await writeFile(join(directory, `ref-${id}`), "../outside");
    await expect(readLongMessage({messageId:id})).rejects.toThrow("Invalid message reference");
  });

  it("leaves short messages unchanged and rejects unknown IDs and unbounded reads", async () => {
    expect(await compactAutomaticMessage("short human text" )).toBe("short human text");
    await expect(readLongMessage({ messageId: "a".repeat(64) })).rejects.toThrow("Unknown long message ID");
    await expect(readLongMessage({ messageId: "../secret" })).rejects.toThrow("Unknown long message ID");
    await expect(readLongMessage({ messageId: "a".repeat(64), limit: 8001 })).rejects.toThrow("limit");
  });

  it("delivers an automatic preview and reads the exact multi-chunk body through the MCP tool", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-long-delivery-"));
    oldDirectory = process.env.AGENT_HERDER_LONG_MESSAGES_DIR;
    process.env.AGENT_HERDER_LONG_MESSAGES_DIR = join(root, "content");
    const previousStops = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    const previousNotes = process.env.AGENT_HERDER_COORDINATION_NOTES;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(root, "stops.json");
    process.env.AGENT_HERDER_COORDINATION_NOTES = join(root, "notes.json");
    const session: AgentSession = { id: "target-long-message", harness: "codex", status: "running", title: "target", cwd: root!, lastActivity: new Date().toISOString(), needsPermission: false };
    let delivered = "";
    const adapter: HarnessAdapter = {
      type: "codex", name: "test adapter", async init() {}, async listSessions() { return [session]; }, async getSession(id) { return id === session.id ? session : null; },
      async sendMessage(_id, options) { delivered = options.message || ""; return { ok: true }; }, async sendActiveMessage(_id, options) { delivered = options.message; return { ok: true }; },
      async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    };
    const adapters = new Map([["codex", adapter]]);
    const original = `${"concrete assignment detail line\n".repeat(360)}final line ✅`;
    const digest = createHash("sha256").update(original).digest("hex");
    const sent = await handleSendMessage(adapters, { harness: "codex", sessionId: session.id, inputId: "long-message-integration", message: original, mode: "queue" });
    expect(sent).toContain("Message sent");
    const id = delivered.match(/herder:\/\/m\/([a-f0-9]{8,64})/)?.[1];
    expect(id).toBeTruthy();
    expect(delivered).not.toContain(original);
    expect(delivered).toContain(original.slice(0, 8_000));
    expect(delivered.length).toBeGreaterThan(8_000);
    expect(delivered.length).toBeLessThan(8_100);
    const fallbackUri = delivered.match(/(herder:\/\/m\/[a-f0-9]{8,64})/)?.[1];
    expect(fallbackUri).toBe(`herder://m/${id}`);

    const events = new HerderEventBus();
    const server = new McpServer({ name: "long-message-read-test", version: "1" });
    registerControlPlaneTools(server, { jobs: new HerderJobRegistry(events), events, coordination: new CoordinationNoteStore(join(root!, "notes.json")) });
    registerHerderResources(server, {
      adapters: new Map(), coordination: new CoordinationNoteStore(join(root!, "notes.json")),
      humanRequests: new HumanRequestRegistry(join(root!, "human-requests.json"), events),
      jobs: new HerderJobRegistry(events), events, eventHealth: new HarnessEventHealthRegistry(),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "long-message-reader", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const firstRead = await client.callTool({ name: "read_message", arguments: { messageId: id } });
    expect(firstRead.isError).not.toBe(true);
    const firstPage = firstRead.structuredContent as { text: string; nextOffset: number | null; sha256: string; total: number };
    expect(firstPage.text.length).toBe(8_000);
    expect(firstPage.nextOffset).toBe(8_000);
    expect(firstPage.sha256).toBeUndefined();
    const secondRead = await client.callTool({ name: "read_message", arguments: { messageId: id, offset: firstPage.nextOffset } });
    expect(secondRead.isError).not.toBe(true);
    const secondPage = secondRead.structuredContent as { text: string; nextOffset: number | null; sha256: string; total: number };
    expect(secondPage.nextOffset).toBeNull();
    expect(secondPage.sha256).toBeUndefined();
    const storedText = firstPage.text + secondPage.text;
    expect(storedText).toContain(original);
    expect(firstPage.total).toBe(storedText.length);

    expect((await client.listResourceTemplates()).resourceTemplates.map(item => item.uriTemplate)).toContain("herder://messages/{messageId}/{offset}/{limit}");
    const resourceChunks: string[] = [];
    let resourceUri = fallbackUri!;
    for (;;) {
      const result = await client.readResource({ uri: resourceUri });
      const page = JSON.parse(result.contents[0]?.text ?? "{}") as { text: string; nextOffset: number | null; nextResourceUri: string | null; sha256: string; total: number };
      resourceChunks.push(page.text);
      expect(page.sha256).toBeUndefined();
      expect(page.total).toBe(storedText.length);
      if (page.nextResourceUri === null) { expect(page.nextOffset).toBeNull(); break; }
      expect(page.nextOffset).not.toBeNull();
      resourceUri = page.nextResourceUri;
    }
    expect(resourceChunks.join("")).toBe(storedText);
    await expect(client.readResource({ uri: "herder://messages/%2E%2E%2Fsecret/0/100" })).rejects.toThrow();
    await expect(client.readResource({ uri: `herder://messages/${id}/0/8001` })).rejects.toThrow();

    const exportedResult = await client.callTool({ name: "save_message_to_file", arguments: { messageId: id, cwd: root } });
    expect(exportedResult.isError).not.toBe(true);
    const exported = exportedResult.structuredContent as { path: string; sha256: string; bytes: number; host: { name: string; note: string } };
    const expectedPath = join(root!, ".agent-herder", "messages", `${id}.txt`);
    expect(Object.keys(exported).sort()).toEqual(["bytes", "host", "path"]);
    expect(exported).not.toHaveProperty("sha256");
    expect(exported.host).not.toHaveProperty("note");
    expect(exported).toMatchObject({ path: expectedPath, bytes: Buffer.byteLength(storedText), host: { name: hostname() } });
    expect((await client.listTools()).tools.find(tool => tool.name === "save_message_to_file")?.description).toContain("not automatically available on the calling machine");
    expect(Buffer.from(await readFile(expectedPath))).toEqual(Buffer.from(storedText, "utf8"));
    expect((await stat(expectedPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root!, ".agent-herder"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(root!, ".agent-herder", "messages"))).mode & 0o777).toBe(0o700);
    expect(exportedResult.content[0]?.type === "text" ? exportedResult.content[0].text : "").not.toContain(original);
    const repeatedExport = await client.callTool({ name: "save_message_to_file", arguments: { messageId: id, cwd: root } });
    expect(repeatedExport.structuredContent).toEqual(exported);

    const mismatchWorkspace = join(root!, "mismatch-workspace");
    await mkdir(mismatchWorkspace);
    const mismatchTarget = join(mismatchWorkspace, ".agent-herder", "messages", `${id}.txt`);
    await mkdir(join(mismatchWorkspace, ".agent-herder", "messages"), { recursive: true });
    await writeFile(mismatchTarget, "unrelated content", { mode: 0o600 });
    expect((await client.callTool({ name: "save_message_to_file", arguments: { messageId: id, cwd: mismatchWorkspace } })).isError).toBe(true);
    expect(await readFile(mismatchTarget, "utf8")).toBe("unrelated content");

    const outside = join(root!, "outside");
    const linkedWorkspace = join(root!, "linked-workspace");
    await mkdir(outside);
    await mkdir(linkedWorkspace);
    await symlink(outside, join(linkedWorkspace, ".agent-herder"));
    expect((await client.callTool({ name: "save_message_to_file", arguments: { messageId: id, cwd: linkedWorkspace } })).isError).toBe(true);
    expect(await readdir(outside)).toEqual([]);

    const linkedTargetWorkspace = join(root!, "linked-target-workspace");
    const externalFile = join(outside, "external.txt");
    await mkdir(join(linkedTargetWorkspace, ".agent-herder", "messages"), { recursive: true });
    await writeFile(externalFile, "external sentinel", { mode: 0o600 });
    await symlink(externalFile, join(linkedTargetWorkspace, ".agent-herder", "messages", `${id}.txt`));
    expect((await client.callTool({ name: "save_message_to_file", arguments: { messageId: id, cwd: linkedTargetWorkspace } })).isError).toBe(true);
    expect(await readFile(externalFile, "utf8")).toBe("external sentinel");
    expect((await client.callTool({ name: "save_message_to_file", arguments: { messageId: "../secret", cwd: root } })).isError).toBe(true);
    expect((await client.callTool({ name: "save_message_to_file", arguments: { messageId: "f".repeat(64), cwd: root } })).isError).toBe(true);
    expect((await client.callTool({ name: "save_message_to_file", arguments: { messageId: id, cwd: "relative/workspace" } })).isError).toBe(true);
    expect((await client.callTool({ name: "save_message_to_file", arguments: { messageId: id, cwd: join(root!, "missing") } })).isError).toBe(true);
    const workspaceLink = join(root!, "workspace-link");
    await symlink(root!, workspaceLink);
    expect((await client.callTool({ name: "save_message_to_file", arguments: { messageId: id, cwd: workspaceLink } })).isError).toBe(true);
    await client.close();
    await server.close();
    if (previousStops === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousStops;
    if (previousNotes === undefined) delete process.env.AGENT_HERDER_COORDINATION_NOTES;
    else process.env.AGENT_HERDER_COORDINATION_NOTES = previousNotes;
  });

  it("compacts automatic new_or_resume assignments while retaining the original delivery digest", async () => {
    root = await mkdtemp(join(tmpdir(), "herder-long-new-resume-"));
    oldDirectory = process.env.AGENT_HERDER_LONG_MESSAGES_DIR;
    process.env.AGENT_HERDER_LONG_MESSAGES_DIR = join(root, "content");
    const previousStops = process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    const previousNotes = process.env.AGENT_HERDER_COORDINATION_NOTES;
    process.env.AGENT_HERDER_HUMAN_STOP_STORE = join(root, "stops.json");
    process.env.AGENT_HERDER_COORDINATION_NOTES = join(root, "notes.json");
    const session: AgentSession = { id: "new-resume-target", harness: "codex", status: "running", title: "target", cwd: root!, lastActivity: new Date().toISOString(), needsPermission: false };
    let delivered = "";
    let receivedInputId = "";
    const adapter: HarnessAdapter = {
      type: "codex", name: "test adapter", async init() {}, async listSessions() { return [session]; }, async getSession(id) { return id === session.id ? session : null; },
      async sendMessage(_id, options) { delivered = options.message || ""; receivedInputId = options.inputId || ""; return { ok: true, admitted: true, inputId: options.inputId }; },
      async sendActiveMessage(_id, options) { delivered = options.message; receivedInputId = options.inputId || ""; return { ok: true, admitted: true, inputId: options.inputId }; },
      async createSession() { return session; }, async stopSession() { return { ok: true }; }, async respondPermission() { return { ok: true }; }, async setPermissions() { return { ok: true }; },
    };
    const original = "new assignment details\n".repeat(500);
    const result = JSON.parse(await handleNewOrResume(new Map([["codex", adapter]]), { harness: "codex", name: "same", cwd: root, message: original, mode: "queue" }));
    expect(result.ok).toBe(true);
    const id = delivered.match(/herder:\/\/m\/([a-f0-9]{8,64})/)?.[1];
    expect(id).toBeTruthy();
    expect(delivered).toContain(original.slice(0, 8_000));
    expect(delivered).not.toContain(original);
    const first = await readLongMessage({messageId:id!});
    const second = await readLongMessage({messageId:id!,offset:first.nextOffset!});
    expect(first.text + second.text).toBe(original);
    expect(receivedInputId).toBe(createHash("sha256").update(original).digest("hex"));
    const short = await compactAutomaticMessage("short remains unchanged");
    expect(short).toBe("short remains unchanged");
    if (previousStops === undefined) delete process.env.AGENT_HERDER_HUMAN_STOP_STORE;
    else process.env.AGENT_HERDER_HUMAN_STOP_STORE = previousStops;
    if (previousNotes === undefined) delete process.env.AGENT_HERDER_COORDINATION_NOTES;
    else process.env.AGENT_HERDER_COORDINATION_NOTES = previousNotes;
  });
});
