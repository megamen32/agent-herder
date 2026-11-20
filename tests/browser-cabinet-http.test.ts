import { hostname } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { loadBrowserChatProviderAdapter } from "../src/adapters/browser-chat-loader.js";
import { CanonicalBrowserActions } from "../src/adapters/canonical-browser-actions.js";
import { createCanonicalAutomationClient, unwrapCanonicalResult } from "../src/canonical-herder.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { FleetGptAdminTransport } from "../src/mesh/fleet-gptadmin-transport.js";
import { handleStopAgent } from "../src/mcp-tools/handlers.js";
import { canonicalResumePayloadHash } from "../src/resume/canonical-transport.js";
import { SessionImageStore } from "../src/session-images.js";
import { requestBrowserStop } from "../src/web-ui/browser-stop.js";
import { createWebServer } from "../src/web/server.js";
import { canonicalFixture } from "./helpers/canonical-herder-fixture.js";
import { cabinetNativeOwner } from "./helpers/cabinet-native-owner.js";

const local = vi.hoisted(() => ({
  sendMessage: vi.fn(), stopTurn: vi.fn(), getMessages: vi.fn(),
  listChats: () => Promise.resolve([]),
  getKnownChat: (id: string) => ({ id, title: "Fixture", working: false, unread: false, updatedAt: "2026-01-01T00:00:00Z" }),
}));
vi.mock("../src/adapters/chatgpt-mac-cdp-driver.js", () => ({ createBrowserChatDriver: () => local }));
vi.mock("../src/adapters/zai-cdp-driver.js", () => ({ createBrowserChatDriver: () => local }));

type Harness = "chatgpt" | "zai";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.resetAllMocks();
});

async function cabinet(harness: Harness, legacy = false) {
  const fixture = await canonicalFixture();
  cleanups.push(fixture.cleanup);
  fixture.config.node_ref = "browser-node";
  await fixture.writeConfig();
  const id = harness === "chatgpt" ? "chatgpt::selected" : "zai::route%3Aselected";
  const target = { harness, nativeSessionId: id, sessionRef: "registered-" + harness, nodeRef: "browser-node", instanceRef: harness };
  const owner = vi.fn<(tool: string, args: Record<string, unknown>) => unknown>();
  const transport = new FleetGptAdminTransport({
    endpoint: "http://fixture.invalid/mcp", headersProvider: () => ({}), nativeHerderAuthority: fixture.config.authority,
    unwrapResponse: unwrapCanonicalResult, fetch: async (_url, init) => {
      const rpc = JSON.parse(String(init?.body));
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 204 });
      let result = {};
      if (rpc.method === "tools/call") {
        expect(rpc.params.name).toBe("exec");
        const code = /^return await mcp\.call\((.*)\);$/s.exec(rpc.params.arguments.code);
        const [authority, tool, args] = JSON.parse("[" + code![1] + "]");
        expect(authority).toBe(fixture.config.authority);
        result = { structuredContent: await owner(tool, args), content: [] };
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    },
  });
  const client = await createCanonicalAutomationClient({ env: legacy ? {} : fixture.env, transportFactory: async () => transport });
  const images = new SessionImageStore(join(fixture.root, "uploads"));
  local.getMessages.mockResolvedValue([]);
  const adapter = await loadBrowserChatProviderAdapter(harness, JSON.stringify([{ id: harness, name: harness, cwd: fixture.root,
    module: harness === "zai" ? "builtin:zai-cdp" : "builtin:chatgpt-mac-cdp" }]), client && new CanonicalBrowserActions(client, images));
  const jobs = new HerderJobRegistry(undefined, { persistencePath: join(fixture.root, "jobs.json") });
  const server = createWebServer({ adapters: new Map([[harness, adapter]]), converter: {} as never, sessionImageStore: images, jobs });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const path = `/api/sessions/${harness}/${encodeURIComponent(id)}`;
  const post = (route: string, body: unknown) => fetch(origin + route, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const inputId = "queued-input";
  const queue = (message: string, fields = {}) => post(path + "/message", { message, mode: "queue", humanRequested: true, hostId: hostname(), inputId, ...fields });
  const status = async () => {
    const read = async () => (await fetch(origin + path + "/message-status?inputId=" + inputId)).json();
    await vi.waitFor(async () => expect((await read()).job?.state).toBe("completed"), { timeout: 4000, interval: 20 });
    return read();
  };
  const address = { node_ref: target.nodeRef, instance_ref: target.instanceRef, native_session_id: id };
  const resolution = { complete: true, session_ref: target.sessionRef, owner: { harness, ...address } };
  const resolveCall = ["session", { action: "resolve", harness, node_ref: target.nodeRef, native_session_id: id }];
  const lookup = { version: 1, complete: true, found: false, reserved_payload_hash: null, session_ref: target.sessionRef,
    request_key: inputId, task_ref: "delivery-task", delivery_mode: "queue", target: address };
  const nativeReceipt = { sender: null, native_id: 'ahap-receipt:v1:{"kind":"message","native_id":"provider-input"}',
    target: { instance: { node: target.nodeRef, instance_id: harness }, native_session_id: id } };
  return { harness, id, path, origin, post, owner, inputId, queue, status, target, resolution, resolveCall, lookup, nativeReceipt, adapter,
    ledgerPath: join(fixture.root, "stop-receipts.json") };
}

it.each(["chatgpt", "zai"] as const)("delivers %s cabinet uploads once after a lost handoff response", async harness => {
  const f = await cabinet(harness);
  const png = { name: "tiny.png", mime_type: "image/png", data_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGmcAAAAASUVORK5CYII=" };
  const file = { name: "notes.txt", mime_type: "text/plain", data_base64: Buffer.from("fixture original").toString("base64") };
  const ids = [];
  for (const [url, upload] of [["/api/session-images", png], ["/api/session-files", file]] as const) {
    const response = await f.post(url, { harness, sessionId: f.id, fileName: upload.name, mimeType: upload.mime_type, dataBase64: upload.data_base64 });
    expect(response.status).toBe(200);
    ids.push((await response.json()).id);
  }
  const message = harness === "chatgpt" ? "" : "fixture caption";
  const attachments = [png, file];
  const proof = { ...f.lookup, found: true, state: "confirmed", payload_hash: canonicalResumePayloadHash(f.target, "queue", message, attachments),
    native_receipt: f.nativeReceipt };
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce(f.lookup)
    .mockImplementationOnce(() => { throw new Error("response lost after handoff"); }).mockReturnValueOnce(proof);
  const payload = { attachmentIds: ids };
  expect((await f.queue(message, payload)).status).toBe(202);
  expect(await f.status()).toMatchObject({ ok: true, admitted: true, inputId: f.inputId, nativeInputMessageId: "provider-input" });
  expect((await f.queue(message, payload)).status).toBe(200);
  expect((await f.queue("different payload", payload)).status).toBe(400);
  const exact = { session_ref: f.target.sessionRef, request_key: f.inputId };
  const read = ["deliver", { action: "receipt", ...exact }];
  expect(f.owner.mock.calls).toEqual([f.resolveCall, read, ["deliver", { action: "session", ...exact, mode: "queue", message, attachments }], read]);
  expect(local.sendMessage).not.toHaveBeenCalled();
});

it.each(["missing", "pending", "wrong-hash", "wrong-recipient", "mesh-sender"] as const)("retains the original queue intent on %s readback", async outcome => {
  const f = await cabinet("zai");
  const message = "original";
  const proof = { ...f.lookup, found: true, state: outcome === "pending" ? "unknown" : "confirmed",
    payload_hash: outcome === "wrong-hash" ? "another hash" : canonicalResumePayloadHash(f.target, "queue", message),
    native_receipt: { ...f.nativeReceipt, ...(outcome === "mesh-sender" && { sender: { hostId: "peer" } }),
      ...(outcome === "wrong-recipient" && { target: { ...f.nativeReceipt.target, native_session_id: "other" } }) } };
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce(f.lookup)
    .mockImplementationOnce(() => { throw new Error("lost response"); }).mockReturnValue(outcome === "missing" ? f.lookup : proof);
  expect((await f.queue(message)).status).toBe(202);
  const result = await f.status();
  expect(result).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true, inputId: f.inputId });
  expect(result.admitted).toBeUndefined();
  expect((await f.queue(message)).status).toBe(502);
  expect(f.owner.mock.calls.filter(([tool, args]) => tool === "deliver" && args.action === "session")).toHaveLength(1);
  expect(local.sendMessage).not.toHaveBeenCalled();
});

it("refuses a foreign host, an unregistered session, and attachments from a different session", async () => {
  const f = await cabinet("chatgpt");
  expect((await f.queue("text", { hostId: "another-machine" })).status).toBe(409);
  const image = await f.post("/api/session-files", { harness: f.harness, sessionId: "other", fileName: "example.txt", mimeType: "text/plain", dataBase64: "YQ==" });
  expect(image.status).toBe(200);
  expect((await f.queue("text", { attachmentIds: [(await image.json()).id] })).status).toBe(400);
  expect(f.owner).not.toHaveBeenCalled();
  f.owner.mockReturnValue({ ...f.resolution, owner: { ...f.resolution.owner, node_ref: "another-machine" } });
  expect((await f.queue("text")).status).toBe(202);
  expect(await f.status()).toMatchObject({ ok: false, notSubmitted: true, nonRetryable: true });
  expect(f.owner.mock.calls).toEqual([f.resolveCall]);
  expect(local.sendMessage).not.toHaveBeenCalled();
});

it("reads an existing native delivery before attempting a new handoff", async () => {
  const f = await cabinet("zai");
  const message = "prior request";
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce({ ...f.lookup, found: true, state: "confirmed",
    payload_hash: canonicalResumePayloadHash(f.target, "queue", message), native_receipt: { ...f.nativeReceipt, native_id: "older-message-id" } });
  expect((await f.queue(message)).status).toBe(202);
  expect(await f.status()).toMatchObject({ ok: true, admitted: true, nativeInputMessageId: "older-message-id" });
  expect(f.owner.mock.calls).toEqual([f.resolveCall, ["deliver", { action: "receipt", session_ref: f.target.sessionRef, request_key: f.inputId }]]);
  expect(local.sendMessage).not.toHaveBeenCalled();
});

it.each(["reserved", "wrong-key", "wrong-ref"] as const)("does not treat a %s projection as a verified miss", async kind => {
  const f = await cabinet("chatgpt");
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce({ ...f.lookup,
    ...(kind === "reserved" && { reserved_payload_hash: canonicalResumePayloadHash(f.target, "queue", "text") }),
    ...(kind === "wrong-key" && { request_key: "other" }), ...(kind === "wrong-ref" && { session_ref: "other" }) });
  await f.queue("text");
  expect(await f.status()).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
  expect(f.owner).toHaveBeenCalledTimes(2);
  expect(local.sendMessage).not.toHaveBeenCalled();
});

it("rejects an oversized Fleet attachment frame before the native send", async () => {
  const f = await cabinet("zai");
  const upload = await f.post("/api/session-files", { harness: f.harness, sessionId: f.id, fileName: "fixture.bin",
    mimeType: "application/octet-stream", dataBase64: Buffer.alloc(50 * 1024).toString("base64") });
  expect(upload.status).toBe(200);
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce(f.lookup);
  await f.queue("text", { attachmentIds: [(await upload.json()).id] });
  expect(await f.status()).toMatchObject({ ok: false, notSubmitted: true, nonRetryable: true, error: "fleet_attachment_frame_too_large" });
  expect(f.owner).toHaveBeenCalledTimes(2);
  expect(local.sendMessage).not.toHaveBeenCalled();
});

it.each(["chatgpt", "zai"] as const)("retains the %s stop key on loss and reads the original acknowledgement on explicit retry", async harness => {
  const f = await cabinet(harness);
  const target = { hostId: hostname(), harness, id: f.id };
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) };
  const http: typeof fetch = (url, init) => fetch(f.origin + url, init);
  const ack = { session_ref: f.target.sessionRef, hold: "active", native_interrupt: "acknowledged" };
  f.owner.mockReturnValueOnce(f.resolution).mockImplementationOnce(() => { throw new Error("owner response lost"); })
    .mockReturnValueOnce(f.resolution).mockReturnValueOnce(ack).mockReturnValueOnce(f.resolution).mockReturnValueOnce(ack);
  expect((await f.post(f.path + "/stop", {})).status).toBe(400);
  await expect(requestBrowserStop(target, "provider-input", storage, http)).rejects.toThrow("Прерывание не подтверждено");
  const { inputId } = JSON.parse([...values.values()][0]!);
  await expect(requestBrowserStop(target, "provider-input", storage, async (url, init) => {
    await (await http(url, init)).arrayBuffer();
    throw new Error("cabinet HTTP response lost");
  })).rejects.toThrow("Прерывание не подтверждено");
  await requestBrowserStop(target, "provider-input", storage, http);
  expect(values.size).toBe(0);
  const stop = ["stop", { action: "stop", session_ref: f.target.sessionRef, request_key: inputId }];
  expect(f.owner.mock.calls).toEqual([f.resolveCall, stop, f.resolveCall, stop, f.resolveCall, stop]);
  expect(local.stopTurn).not.toHaveBeenCalled();
});

it.each(["not_sent", "not_attempted_no_known_handoff", "required_or_reconcile", "wrong-session"])("never presents %s as a native stop", async interrupt => {
  const f = await cabinet("zai");
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce({ session_ref: interrupt === "wrong-session" ? "elsewhere" : f.target.sessionRef,
    hold: "active", native_interrupt: interrupt === "wrong-session" ? "acknowledged" : interrupt });
  const response = await f.post(f.path + "/stop", { inputId: "stop-key" });
  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ ok: false, inputId: "stop-key", nonRetryable: true,
    ...(interrupt === "not_sent" || interrupt === "not_attempted_no_known_handoff" ? { notSubmitted: true } : { admissionUnknown: true }),
    ...(interrupt !== "wrong-session" && { held: true, nativeInterrupt: interrupt }) });
  expect(local.stopTurn).not.toHaveBeenCalled();
});

it("preserves the stock stop caller's key and unknown outcome on the shared browser adapter", async () => {
  const f = await cabinet("chatgpt");
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce({ session_ref: f.target.sessionRef, hold: "active", native_interrupt: "required_or_reconcile" });
  const stop = () => handleStopAgent(new Map([[f.harness, f.adapter]]), { sessionId: f.id, harness: f.harness, inputId: "original-stop" },
    { ledgerPath: f.ledgerPath });
  expect((await stop()).structured).toMatchObject({ state: "unknown", held: true, retryable: false });
  expect((await stop()).structured.state).toBe("unknown");
  expect(f.owner.mock.calls).toEqual([f.resolveCall, ["stop", { action: "stop", session_ref: f.target.sessionRef, request_key: "original-stop" }]]);
  expect(local.stopTurn).not.toHaveBeenCalled();
});

it("keeps the unkeyed legacy HTTP send and stop on their original driver", async () => {
  const f = await cabinet("zai", true);
  local.sendMessage.mockResolvedValue({});
  local.stopTurn.mockResolvedValue({ stopped: true });
  expect((await f.post(f.path + "/message", { message: "legacy", humanRequested: true })).status).toBe(200);
  expect((await f.post(f.path + "/stop", {})).status).toBe(200);
  expect(local.sendMessage).toHaveBeenCalledWith({ chatId: "route:selected", text: "legacy", waitForCompletion: true });
  expect(local.stopTurn).toHaveBeenCalledWith("route:selected");
  expect(f.adapter.controlCapabilities.fileInput).toBeUndefined();
  expect(f.owner).not.toHaveBeenCalled();
});

const binary = resolve(process.env.CARGO_TARGET_DIR ?? "crates/herder/target", "debug/herder_native_stdio");
it.runIf(process.platform === "linux" && existsSync(binary)).each(["chatgpt", "zai"] as const)(
  "reopens the Rust %s owner after lost send and stop responses with exactly one of each native effect", async harness => {
    const f = await cabinet(harness);
    const native = cabinetNativeOwner(binary, harness, f.target.nodeRef);
    cleanups.push(async () => native.cleanup());
    const registration = await native.call("session", { action: "register", instance_ref: harness, native_session_id: f.id, request_key: "register-fixture" });
    expect(registration.session_ref).toEqual(expect.any(String));
    let lostSend = false, lostStop = false;
    f.owner.mockImplementation(async (tool, args) => {
      const reply = await native.call(tool, args);
      if (tool === "deliver" && args.action === "session" && !lostSend) {
        lostSend = true;
        throw new Error("lost response after Rust handoff");
      }
      if (tool === "stop" && !lostStop) {
        lostStop = true;
        throw new Error("lost response after Rust interrupt");
      }
      return reply;
    });
    const attachment = { name: "fixture.txt", mime_type: "text/plain", data_base64: "Zml4dHVyZQ==" };
    const upload = await f.post("/api/session-files", { harness, sessionId: f.id,
      fileName: attachment.name, mimeType: attachment.mime_type, dataBase64: attachment.data_base64 });
    expect(upload.status).toBe(200);
    const fields = { attachmentIds: [(await upload.json()).id] };
    const message = harness === "chatgpt" ? "" : "fixture caption";
    expect((await f.queue(message, fields)).status).toBe(202);
    expect(await f.status()).toMatchObject({ ok: true, inputId: f.inputId, nativeInputMessageId: "native-1" });
    expect((await f.queue(message, fields)).status).toBe(200);
    const stop = () => f.post(f.path + "/stop", { hostId: hostname(), inputId: "stop-fixture" });
    expect(await (await stop()).json()).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
    expect(await (await stop()).json()).toMatchObject({ ok: true, held: true, nativeInterrupt: "acknowledged" });
    expect([lostSend, lostStop]).toEqual([true, true]);
    expect(native.trace()).toEqual([
      { method: "sendMessage", id: f.id, harness, message: { id: "native-1", role: "user", text: message }, attachments: [attachment] },
      { method: "cancelTurn", id: f.id, harness, inputMessageId: "native-1" },
    ]);
    expect(local.sendMessage).not.toHaveBeenCalled();
    expect(local.stopTurn).not.toHaveBeenCalled();
  }, 20_000);

it.runIf(process.platform === "linux" && existsSync(binary))("keeps UNKNOWN after the browser accepted input and lost its AHAP reply", async () => {
  const f = await cabinet("chatgpt");
  const native = cabinetNativeOwner(binary, f.harness, f.target.nodeRef);
  cleanups.push(async () => native.cleanup());
  await native.call("session", { action: "register", instance_ref: f.harness, native_session_id: f.id, request_key: "register-fixture" });
  f.owner.mockImplementation(native.call);
  expect((await f.queue("lose native response")).status).toBe(202);
  expect(await f.status()).toMatchObject({ ok: false, admissionUnknown: true, nonRetryable: true });
  expect((await f.queue("lose native response")).status).toBe(502);
  expect(native.trace()).toHaveLength(1);
  expect(local.sendMessage).not.toHaveBeenCalled();
}, 20_000);
