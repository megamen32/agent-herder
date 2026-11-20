import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createCanonicalAutomationClient, unwrapCanonicalResult } from "../src/canonical-herder.js";
import { HerderEventBus } from "../src/herder-events.js";
import { HerderJobRegistry } from "../src/herder-jobs.js";
import { registerSessionTools } from "../src/mcp/session-tools.js";
import { withToolConsolidation } from "../src/mcp/tool-consolidation.js";
import { FleetGptAdminTransport } from "../src/mesh/fleet-gptadmin-transport.js";
import { FleetDirectTransport } from "../src/mesh/fleet-direct-transport.js";
import type { GptAdminTransport } from "../src/mesh/gptadmin.js";
import { AutomationDisarmStore } from "../src/automation-disarm/index.js";
import type { ProjectModelPolicyStateProvider } from "../src/project-model-delivery-gate.js";
import type { HarnessAdapter } from "../src/types/index.js";
import { canonicalFixture } from "./helpers/canonical-herder-fixture.js";

vi.mock("node:os", { spy: true });
let fixture: Awaited<ReturnType<typeof canonicalFixture>>;
let client: Client;
let server: McpServer;
beforeEach(async () => {
  vi.mocked(hostname).mockReturnValue("browser-node");
  fixture = await canonicalFixture();
  vi.mocked(homedir).mockReturnValue(fixture.root);
  vi.stubEnv("AGENT_HERDER_AUTOPILOT_STATE_DIR", fixture.root);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture.cleanup();
});

async function browserConsumer(harness: "chatgpt" | "zai", options: {
  policy?: ProjectModelPolicyStateProvider; transport?: GptAdminTransport;
} = {}) {
  // Immutable fields captured from the existing browser_registration Rust
  // fixture's deliver.receipt for ordinary_browser_and_scriptless_opencode_envelopes_reach_registered_sessions.
  const hashes = {
    chatgpt: "sha256-dispatch-v1:8bba0bb6b882a2dc528641dd107506fb71693b67fb4ddac2e9eff39a4226ea98",
    zai: "sha256-dispatch-v1:48cd18ae79c09f31cfc6d6ba5c8440da8a4873e82b4f99f813f6c91d9afaca4b",
  };
  const target = { hostId: "browser-node", harness, nativeSessionId: "existing-native" };
  const sender = { hostId: "opencode-node", harness: "opencode", nativeSessionId: "ses_mesh_fixture" };
  const marker = harness + "-to-" + harness;
  const request = { target, sender, inputId: marker, message: marker };
  const binding = { nodeRef: target.hostId, instanceRef: harness, sessionRef: "registered-chat",
    nativeSessionId: target.nativeSessionId, harness };
  const resolution = { complete: true, session_ref: binding.sessionRef, owner: { harness, node_ref: target.hostId,
    instance_ref: binding.instanceRef, native_session_id: target.nativeSessionId } };
  const lookup = { version: 1, complete: true, found: false, session_ref: binding.sessionRef,
    request_key: request.inputId, task_ref: "task-original", delivery_mode: "queue", automatic_continuation: true, reserved_payload_hash: null,
    target: { node_ref: target.hostId, instance_ref: binding.instanceRef, native_session_id: target.nativeSessionId } };
  const nativeReceiptId = "ahap-receipt:v1:" + JSON.stringify({ kind: "message", native_id: harness + "-message-0" });
  const proof = { ...lookup, found: true, state: "confirmed", payload_hash: hashes[harness], task_status: "completed",
    native_receipt: { native_id: nativeReceiptId, sender, target: { native_session_id: target.nativeSessionId,
      instance: { node: target.hostId, instance_id: binding.instanceRef } } } };

  // Cross the real pinned Fleet transport and its native-call allowlist. Only
  // the wire replies from the owner are supplied by the test.
  const owner = vi.fn<(tool: string, args: Record<string, unknown>) => unknown>();
  const transport = new FleetGptAdminTransport({
    endpoint: "https://fixture.invalid/mcp", headersProvider: () => ({}),
    nativeHerderAuthority: fixture.config.authority, unwrapResponse: unwrapCanonicalResult,
    fetch: async (_url, init) => {
      const rpc = JSON.parse(String(init?.body));
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 204 });
      let result = {};
      if (rpc.method === "tools/call") {
        expect(rpc.params.name).toBe("exec");
        const call = /^return await mcp\.call\((.*)\);$/s.exec(rpc.params.arguments.code);
        const [authority, tool, args] = JSON.parse("[" + call![1] + "]");
        expect(authority).toBe(fixture.config.authority);
        result = { content: [], structuredContent: owner(tool, args) };
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    },
  });
  const canonicalClient = await createCanonicalAutomationClient({ env: fixture.env, transportFactory: async () => transport });
  const legacySend = vi.fn();
  const legacyRead = vi.fn(async () => { throw new Error("offline legacy UserIO"); });
  const adapter = { type: harness, getSession: legacyRead, sendMessage: legacySend } as unknown as HarnessAdapter;
  const events = new HerderEventBus();
  server = new McpServer({ name: "mesh-receiver", version: "1" });
  withToolConsolidation(server, () => registerSessionTools(server, {
    adapters: new Map([[harness, adapter]]), events, canonicalClient, transport: options.transport,
    deliveryPolicy: options.policy ?? (async () => ({ kind: "valid", policy: {} })),
    jobs: new HerderJobRegistry(events, { persistencePath: join(fixture.root, "jobs.json") }),
  }), new Set());
  const [clientPort, serverPort] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "mesh-consumer", version: "1" });
  await server.connect(serverPort);
  await client.connect(clientPort);
  const deliver = async (envelope: Record<string, unknown> = request) => (await client.callTool({ name: "deliver", arguments: envelope })).structuredContent;
  return { request, resolution, lookup, proof, nativeReceiptId, owner, deliver, transport, legacyRead, legacySend };
}

it.each(["chatgpt", "zai"] as const)("returns the bound %s native receipt through ordinary deliver", async harness => {
  const f = await browserConsumer(harness);
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce(f.lookup)
    .mockReturnValueOnce({ outcome: "confirmed", native_receipt_id: f.nativeReceiptId }).mockReturnValueOnce(f.proof);
  const admitted = { state: "admitted", retryable: false, inputId: f.request.inputId, nativeReceiptId: f.nativeReceiptId };
  expect(await f.deliver()).toEqual(admitted);
  expect(await f.deliver()).toEqual(admitted);
  expect(await f.deliver({ ...f.request, sender: { ...f.request.sender, nativeSessionId: "another-source" } }))
    .toMatchObject({ state: "not_attempted", retryable: false, reason: "input_id_conflict" });
  const read = ["deliver", { action: "receipt", session_ref: f.lookup.session_ref, request_key: f.request.inputId }];
  expect(f.owner.mock.calls).toEqual([
    ["session", { action: "resolve", harness, node_ref: f.request.target.hostId, native_session_id: f.request.target.nativeSessionId }],
    read, ["deliver", f.request], read,
  ]);
  expect(f.legacyRead).not.toHaveBeenCalled();
  expect(f.legacySend).not.toHaveBeenCalled();
});

const uploads = [
  { name: "pixel.png", mime_type: "image/png", data_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cS/kAAAAASUVORK5CYII=" },
  { name: "отчёт.txt", mime_type: "text/plain", data_base64: "0L/RgNC+0LLQtdGA0LrQsAo=" },
];

it.each([
  ["chatgpt", "", "37f40e6fd4309c21782e1f7992c46a3ae9b4a577229e5ec90bde2080689de303"],
  ["zai", "read the files", "24818e0ba00c5e4b56b1f2dba90663d9d83c1d5772ea671c506018f62b41ccb7"],
] as const)("binds the %s receipt to both originals and the caption", async (harness, message, hash) => {
  const f = await browserConsumer(harness);
  const packet = { ...f.request, message, attachments: uploads };
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce(f.lookup)
    .mockReturnValueOnce({ outcome: "confirmed" }).mockReturnValueOnce({ ...f.proof, payload_hash: "sha256-dispatch-v1:" + hash });
  const admitted = await f.deliver(packet);
  expect(admitted).toMatchObject({ state: "admitted", nativeReceiptId: f.nativeReceiptId });
  expect(await f.deliver(packet)).toEqual(admitted);
  expect(await f.deliver({ ...packet, attachments: [...uploads].reverse() })).toMatchObject({ reason: "input_id_conflict" });
  expect(f.owner.mock.calls.filter(([, args]) => args.target)).toEqual([["deliver", packet]]);
});

it("rejects malformed, oversized and unaddressed uploads before sending a caption", async () => {
  const f = await browserConsumer("zai");
  const packet = { ...f.request, attachments: uploads };
  for (const invalid of [
    { ...packet, message: " \uFEFF " },
    { ...packet, attachments: [{ ...uploads[0], path: "/local/file" }] },
    { ...packet, attachments: [{ ...uploads[0], name: "../local" }] },
    { ...packet, attachments: [{ ...uploads[0], data_base64: "Zh==" }] },
    { ...packet, attachments: Array(17).fill(uploads[0]) },
    { ...packet, attachments: [{ ...uploads[0], data_base64: Buffer.alloc(2 * 1024 * 1024).toString("base64") }, uploads[1]] },
    { sessionId: "existing-native", message: "caption", attachments: uploads },
  ]) {
    const reply = await client.callTool({ name: "deliver", arguments: invalid });
    expect(reply.isError).toBe(true);
  }
  expect(f.owner).not.toHaveBeenCalled();
  expect(f.legacySend).not.toHaveBeenCalled();
});

it("reports the GPTAdmin frame limit before dispatching an otherwise valid attachment", async () => {
  const f = await browserConsumer("chatgpt");
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce(f.lookup);
  const packet = { ...f.request, attachments: [{ ...uploads[0], data_base64: Buffer.alloc(50_000).toString("base64") }] };
  expect(await f.deliver(packet)).toEqual({ state: "not_attempted", inputId: packet.inputId,
    reason: "fleet_attachment_frame_too_large", retryable: false });
  expect(f.owner.mock.calls.some(([, args]) => args.target)).toBe(false);
});

it.each([true, false])("only forwards files to a Fleet receiver that accepts them (capability %s)", async supported => {
  vi.mocked(hostname).mockReturnValue("opencode-node");
  const fwd = vi.fn(async (_target: string, tool: string, args: Record<string, unknown>) => {
    if (tool === "fleet_node_info") return { hostId: "browser-node", browserInlineAttachments: supported };
    if (tool === "deliver") return { state: "admitted", inputId: args.inputId, nativeReceiptId: "file-receipt" };
    throw Error("unexpected tool");
  });
  const transport = {
    discover: async () => ({ servers: [{ server_id: "mcp:shell:browser-node:AgentHerder", kind: "child_mcp", status: "online" }] }),
    schema: async () => ({ tools: [{ name: "deliver" }, { name: "fleet_node_info" }] }), call: fwd,
  };
  const f = await browserConsumer("chatgpt", { transport });
  const packet = { ...f.request, message: "", attachments: uploads };
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce({ ...f.proof,
    payload_hash: "sha256-dispatch-v1:37f40e6fd4309c21782e1f7992c46a3ae9b4a577229e5ec90bde2080689de303",
    native_receipt: { ...f.proof.native_receipt, native_id: "file-receipt" } });
  expect(await f.deliver(packet)).toMatchObject(supported ? { state: "admitted", nativeReceiptId: "file-receipt" }
    : { state: "not_attempted", reason: "attachments_unsupported" });
  expect(fwd.mock.calls.filter(([, tool]) => tool === "deliver").map(([, , args]) => args)).toEqual(supported ? [packet] : []);
});

it.each(["lost", "sender", "recipient", "pending", "read-denied", "changed-hash", "held"] as const)("preserves the owner's %s outcome without replay", async outcome => {
  const f = await browserConsumer("zai");
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce(f.lookup);
  if (outcome === "held") {
    f.owner.mockReturnValueOnce({ isError: true, structuredContent: { code: "delivery_blocked", effect: "none" } });
  } else if (outcome === "lost") {
    f.owner.mockImplementationOnce(() => { throw new Error("fixture lost reply"); });
  } else if (outcome === "read-denied") {
    f.owner.mockReturnValueOnce({ outcome: "confirmed", native_receipt_id: f.nativeReceiptId })
      .mockReturnValueOnce({ isError: true, structuredContent: { code: "session_grant_required", effect: "none" } });
  } else {
    const proof = f.proof.native_receipt;
    f.owner.mockReturnValueOnce({ outcome: "confirmed", native_receipt_id: f.nativeReceiptId }).mockReturnValueOnce({
      ...f.proof, state: outcome === "pending" ? "unknown" : "confirmed",
      payload_hash: outcome === "changed-hash" ? "sha256-dispatch-v1:" + "0".repeat(64) : f.proof.payload_hash,
      native_receipt: { ...proof, sender: outcome === "sender" ? { ...proof.sender, hostId: "other" } : proof.sender,
        target: outcome === "recipient" ? { ...proof.target, native_session_id: "other" } : proof.target },
    });
  }
  const receipt = await f.deliver();
  expect(receipt).toMatchObject(outcome === "held" ? { state: "not_attempted", reason: "delivery_blocked", retryable: false }
    : { state: "unknown", retryable: false });
  expect(await f.deliver()).toEqual(receipt);
  expect(f.owner.mock.calls.filter(([tool, args]) => tool === "deliver" && args.target)).toHaveLength(1);
  expect(f.legacyRead).not.toHaveBeenCalled();
  expect(f.legacySend).not.toHaveBeenCalled();
});

it.each(["unknown", "hash", "denied"] as const)("checks the owner's existing %s record before sending", async kind => {
  const f = await browserConsumer("chatgpt");
  if (kind === "denied") {
    f.owner.mockReturnValueOnce({ isError: true, structuredContent: { code: "unauthorized", effect: "none" } });
  } else {
    f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce(kind === "unknown"
      ? { ...f.proof, state: "unknown", native_receipt: null }
      : { ...f.proof, payload_hash: "sha256-dispatch-v1:" + "0".repeat(64) });
  }
  const expected = kind === "unknown" ? { state: "unknown" }
    : { state: "not_attempted", reason: kind === "hash" ? "input_id_conflict" : "unauthorized" };
  expect(await f.deliver()).toMatchObject({ ...expected, retryable: false });
  expect(f.owner.mock.calls.some(([, args]) => args.target)).toBe(false);
  expect(f.legacyRead).not.toHaveBeenCalled();
  expect(f.legacySend).not.toHaveBeenCalled();
});

it.each(["global disarm", "scoped disarm", "project policy"] as const)("honors %s with UserIO offline", async gate => {
  const modelGate = gate === "project policy";
  const f = await browserConsumer("zai", modelGate ? { policy: async () => ({ kind: "valid", policy: {
    projectRoutes: { [fixture.root]: { deniedModels: ["fixture-model"] } },
  } }) } : {});
  if (!modelGate) {
    const result = await AutomationDisarmStore.forRuntime().replaceRecords({ source: "owner", records: [{
      scope: gate === "global disarm" ? "*" : fixture.root, forbidden: true, createdAt: new Date().toISOString(),
    }] });
    expect(result.ok).toBe(true);
  }
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce(f.lookup);
  const reason = modelGate ? "session_work_directory_unknown"
    : gate === "global disarm" ? "automation_disarmed" : "canonical_work_metadata_unavailable";
  expect(await f.deliver()).toMatchObject({ state: "not_attempted", reason, retryable: false });
  expect(f.owner.mock.calls.some(([, args]) => args.target)).toBe(false);
  expect(f.legacyRead).not.toHaveBeenCalled();
  expect(f.legacySend).not.toHaveBeenCalled();
});

it("restricts the pinned native Fleet authority to an exact browser envelope", async () => {
  const f = await browserConsumer("zai");
  const authority = fixture.config.authority;
  for (const args of [
    { ...f.request, humanRequested: true }, { ...f.request, action: "session" },
    { ...f.request, target: { ...f.request.target, harness: "codex" } },
    { ...f.request, target: { ...f.request.target, principal: "owner" } },
    { ...f.request, sender: { ...f.request.sender, nativeSessionId: "" } },
    { ...f.request, inputId: "x".repeat(257) }, { ...f.request, message: " " },
  ]) await expect(f.transport.call(authority, "deliver", args)).rejects.toThrow("native_herder_call_not_allowed");
  await expect(f.transport.call("mcp:shell:other:AgentHerder", "deliver", f.request)).rejects.toThrow("native_herder_authority_mismatch");
  expect(f.owner).not.toHaveBeenCalled();
});

it.each([true, false])("checks Fleet's browser admission against the original owner receipt (matching ID %s)", async matches => {
  vi.mocked(hostname).mockReturnValue("opencode-node");
  const relay = "mcp:shell:browser-node:HerderFleet";
  const nativeReceiptId = 'ahap-receipt:v1:{"kind":"message","native_id":"zai-message-0"}';
  const call = vi.fn(async (_peer: string, tool: string, args: Record<string, unknown>) => {
    if (tool === "fleet_node_info") return { hostId: "browser-node" };
    if (tool === "deliver") return { state: "admitted", inputId: args.inputId, nativeReceiptId: matches ? nativeReceiptId : "another-receipt", retryable: false };
    throw new Error("unexpected legacy call");
  });
  const transport = new FleetDirectTransport([{ hostId: "browser-node", sshHost: "unused.invalid", nativeUser: "fixture",
    port: 1, python: "/unused" }], 1000, {
    discover: async () => ({ servers: [{ server_id: relay, status: "online" }] }),
    schema: async () => ({ tools: [{ name: "fleet_node_info" }, { name: "deliver" }] }), call,
  });
  const f = await browserConsumer("zai", { transport });
  f.owner.mockReturnValueOnce(f.resolution).mockReturnValueOnce(f.proof);
  const expected = matches ? { state: "admitted", nativeReceiptId } : { state: "unknown" };
  expect(await f.deliver()).toEqual({ ...expected, inputId: f.request.inputId, retryable: false });
  expect(f.owner.mock.calls).toEqual([
    ["session", { action: "resolve", harness: "zai", node_ref: "browser-node", native_session_id: "existing-native" }],
    ["deliver", { action: "receipt", session_ref: f.lookup.session_ref, request_key: f.request.inputId }],
  ]);
  expect(call.mock.calls).toEqual([[relay, "fleet_node_info", {}], [relay, "deliver", f.request]]);
  expect(f.legacyRead).not.toHaveBeenCalled();
  if (!matches) {
    await client.close();
    await server.close();
    const reconnected = await browserConsumer("zai", { transport });
    expect(await reconnected.deliver()).toEqual({ ...expected, inputId: f.request.inputId, retryable: false });
    expect(call.mock.calls.filter(([, tool]) => tool === "deliver")).toHaveLength(1);
    expect(reconnected.owner).not.toHaveBeenCalled();
  }
});
