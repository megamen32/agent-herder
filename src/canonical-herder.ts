import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { GptAdminTransport } from "./mesh/gptadmin.js";

export type CanonicalMode = "legacy" | "canonical";
export interface CanonicalPinnedFile { path: string; sha256: string }
export interface CanonicalHerderConfig {
  version: 1;
  mode: "canonical";
  epoch: string;
  authority: string;
  node_ref?: string;
  /** Reviewed evidence that every former writer has stopped, not a readiness boolean. */
  writer_drain: CanonicalPinnedFile;
  resume_after: { directory: string; snapshot: string; sha256: string };
  resume_receipts?: { path: string; snapshot: string; sha256: string };
}
export interface CanonicalSessionRef {
  sessionRef: string;
  harness: string;
  nativeSessionId: string;
  nodeRef: string;
  instanceRef: string;
}
export interface CanonicalAutomationClient {
  readonly mode: "canonical";
  readonly epoch: string;
  readonly config: Readonly<CanonicalHerderConfig>;
  /** Reverify the pinned configuration before using retained migration evidence. */
  assertCurrent(): Promise<void>;
  call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  resolveNative(harness: string, id: string, node?: string): Promise<CanonicalSessionRef>;
}
export interface CanonicalClientBinding { config: string; config_sha256: string }
const clientBindings = new WeakMap<CanonicalAutomationClient, Readonly<CanonicalClientBinding>>();
/** Captured by the real client factory, never inferred from a later environment. */
export function canonicalClientBinding(client: CanonicalAutomationClient): Readonly<CanonicalClientBinding> | undefined {
  return clientBindings.get(client);
}
export interface CanonicalAutomationOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  configSha256?: string;
  transportFactory?: () => Promise<Pick<GptAdminTransport, "call"> | undefined>;
}

export class CanonicalHerderError extends Error {
  constructor(readonly code: string, readonly effect: string | undefined, message: string) {
    super(message); this.name = "CanonicalHerderError";
  }
}

/** Unwrap transport records only. A domain field named result is ordinary data. */
export function unwrapCanonicalResult(value: unknown): Record<string, unknown> {
  let current = value;
  let failed = false;
  for (let depth = 0; depth < 12; depth++) {
    if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("canonical_response_invalid");
    const row = current as Record<string, unknown>;
    if (row.isError === true) failed = true;
    if (row.structuredContent && typeof row.structuredContent === "object"
      && (Array.isArray(row.content) || row.isError !== undefined || Object.keys(row).every(key => key === "structuredContent" || key === "_meta"))) {
      current = row.structuredContent; continue;
    }
    if ((row.status === "completed" || row.status === "failed") && typeof row.calls === "number") {
      if (row.status === "failed") failed = true;
      if (row.result && typeof row.result === "object") { current = row.result; continue; }
      throw new Error("canonical_transport_failed");
    }
    if (Array.isArray(row.content) && row.content.length === 1
      && Object.keys(row).every(key => ["content", "isError", "_meta"].includes(key))) {
      const block = row.content[0] as Record<string, unknown> | undefined;
      if (block?.type === "text" && typeof block.text === "string" && block.text.length <= 1024 * 1024) {
        try { current = JSON.parse(block.text); continue; } catch { /* A text-only error stays an error. */ }
      }
    }
    if (row.jsonrpc === "2.0" && row.result && typeof row.result === "object"
      && Object.keys(row).every(key => ["jsonrpc", "id", "result"].includes(key))) {
      current = row.result; continue;
    }
    if (row.response && typeof row.response === "object" && Object.keys(row).every(key => ["response", "_meta"].includes(key))) {
      current = row.response; continue;
    }
    if (failed || (typeof row.code === "string" && row.effect === "none" && typeof row.message === "string")) {
      throw new CanonicalHerderError(typeof row.code === "string" ? row.code : "canonical_remote_error",
        typeof row.effect === "string" ? row.effect : undefined,
        typeof row.message === "string" ? row.message.slice(0, 1000) : "Canonical Herder operation failed");
    }
    return row;
  }
  throw new Error("canonical_response_depth_limit");
}

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value: unknown, max = 512): value is string => typeof value === "string"
  && value.length > 0 && value.length <= max && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const absolute = (value: unknown): value is string => exact(value, 4096) && path.isAbsolute(value);

function fields(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("canonical_config_invalid");
  const object = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(object, key))
    || Object.keys(object).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new Error("canonical_config_invalid");
  }
  return object;
}

/** No symlink, shared permissions, inode substitution, or unbounded config reads. */
export async function readCanonicalPrivateBytes(filename: string, maximum = 1024 * 1024): Promise<Buffer> {
  if (!absolute(filename) || await fs.realpath(filename) !== filename) throw new Error("canonical_file_untrusted");
  const selectedBefore = await fs.lstat(filename);
  if (!selectedBefore.isFile()) throw new Error("canonical_file_untrusted");
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== selectedBefore.dev || before.ino !== selectedBefore.ino
      || before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0
      || before.nlink !== 1 || before.size > maximum) throw new Error("canonical_file_untrusted");
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const selected = await fs.lstat(filename);
    if (bytes.length !== before.size || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || selected.dev !== before.dev || selected.ino !== before.ino || !selected.isFile()) {
      throw new Error("canonical_file_changed");
    }
    return bytes;
  } finally { await handle.close(); }
}

export async function readCanonicalPinnedJson(filename: string, sha256: string, maximum?: number): Promise<unknown> {
  if (!hash(sha256)) throw new Error("canonical_digest_invalid");
  const bytes = await readCanonicalPrivateBytes(filename, maximum);
  if (digest(bytes) !== sha256) throw new Error("canonical_digest_mismatch");
  return JSON.parse(bytes.toString("utf8"));
}

function validateConfig(value: unknown): CanonicalHerderConfig {
  const config = fields(value, ["version", "mode", "epoch", "authority", "writer_drain", "resume_after"], ["node_ref", "resume_receipts"]);
  if (config.version !== 1 || config.mode !== "canonical" || !exact(config.epoch, 128)
    || typeof config.authority !== "string" || !/^mcp:shell:[A-Za-z0-9._-]+:AgentHerder$/.test(config.authority)
    || (config.node_ref !== undefined && !exact(config.node_ref))) throw new Error("canonical_config_invalid");
  const drain = fields(config.writer_drain, ["path", "sha256"]);
  if (!absolute(drain.path) || !hash(drain.sha256)) throw new Error("canonical_config_invalid");
  const waits = fields(config.resume_after, ["directory", "snapshot", "sha256"]);
  if (!absolute(waits.directory) || !absolute(waits.snapshot) || !hash(waits.sha256)) throw new Error("canonical_config_invalid");
  if (config.resume_receipts !== undefined) {
    const receipts = fields(config.resume_receipts, ["path", "snapshot", "sha256"]);
    if (!absolute(receipts.path) || !absolute(receipts.snapshot) || !hash(receipts.sha256)) throw new Error("canonical_config_invalid");
  }
  return config as unknown as CanonicalHerderConfig;
}

/** Missing mode is legacy only when no canonical configuration was supplied. */
export function canonicalMode(env: NodeJS.ProcessEnv = process.env): CanonicalMode {
  const mode = env.AGENT_HERDER_CANONICAL_MODE;
  if (mode === undefined) {
    if (env.AGENT_HERDER_CANONICAL_CONFIG !== undefined || env.AGENT_HERDER_CANONICAL_CONFIG_SHA256 !== undefined) {
      throw new Error("canonical_mode_required");
    }
    return "legacy";
  }
  if (mode !== "legacy" && mode !== "canonical") throw new Error("canonical_mode_invalid");
  if (mode === "legacy" && (env.AGENT_HERDER_CANONICAL_CONFIG !== undefined
    || env.AGENT_HERDER_CANONICAL_CONFIG_SHA256 !== undefined)) throw new Error("canonical_legacy_config_conflict");
  return mode;
}

/** Exact installed native authority over the existing pinned GPTAdmin credential. */
export async function createCanonicalAutomationClient(options: CanonicalAutomationOptions = {}): Promise<CanonicalAutomationClient | undefined> {
  const env = options.env ?? process.env;
  const mode = canonicalMode(env);
  if (mode === "legacy") {
    if (options.configPath !== undefined || options.configSha256 !== undefined) throw new Error("canonical_mode_required");
    return undefined;
  }
  const filename = options.configPath ?? env.AGENT_HERDER_CANONICAL_CONFIG;
  const sha256 = options.configSha256 ?? env.AGENT_HERDER_CANONICAL_CONFIG_SHA256;
  if (!absolute(filename) || !hash(sha256)) throw new Error("canonical_config_required");
  const config = validateConfig(await readCanonicalPinnedJson(filename, sha256));
  const credentialPin = env.AGENT_HERDER_FLEET_CREDENTIAL_PIN;
  const credentialConfig = env.AGENT_HERDER_FLEET_MESH_CONFIG;
  Object.freeze(config.writer_drain);
  Object.freeze(config.resume_after);
  if (config.resume_receipts) Object.freeze(config.resume_receipts);
  Object.freeze(config);
  let current: { generation: string; transport: GptAdminTransport } | undefined;
  const getTransport = options.transportFactory ?? (async () => {
    const pin = env.AGENT_HERDER_FLEET_CREDENTIAL_PIN;
    if (!pin) throw new Error("canonical_authority_credential_unavailable");
    const { readFleetMeshBinding } = await import("./mesh/fleet-mesh-binding.js");
    const binding = await readFleetMeshBinding({ configPath: env.AGENT_HERDER_FLEET_MESH_CONFIG, pin });
    if (!binding) throw new Error("canonical_authority_credential_unavailable");
    if (current?.generation === binding.generation) return current.transport;
    const { FleetGptAdminTransport } = await import("./mesh/fleet-gptadmin-transport.js");
    const transport = new FleetGptAdminTransport({
      endpoint: binding.endpoint, headersProvider: () => ({ ...binding.headers }), readDeadlineMs: 15000,
      unwrapResponse: unwrapCanonicalResult,
      nativeHerderAuthority: config.authority,
    });
    current = { generation: binding.generation, transport };
    return transport;
  });
  const client: CanonicalAutomationClient = {
    mode: "canonical", epoch: config.epoch, config,
    async assertCurrent() {
      if (canonicalMode(env) !== "canonical" || (options.configPath ?? env.AGENT_HERDER_CANONICAL_CONFIG) !== filename
        || (options.configSha256 ?? env.AGENT_HERDER_CANONICAL_CONFIG_SHA256) !== sha256
        || (!options.transportFactory && (env.AGENT_HERDER_FLEET_CREDENTIAL_PIN !== credentialPin
          || env.AGENT_HERDER_FLEET_MESH_CONFIG !== credentialConfig))) throw new Error("canonical_configuration_changed");
      await readCanonicalPinnedJson(filename, sha256);
    },
    async call(tool, args) {
      if (!exact(tool, 128) || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("canonical_request_invalid");
      await client.assertCurrent();
      const transport = await getTransport();
      if (!transport) throw new Error("canonical_authority_unavailable");
      // No discovery, remapping, alternate store, or mutation retry here.
      return unwrapCanonicalResult(await transport.call(config.authority, tool, args));
    },
    async resolveNative(harness, id, node) {
      const nodeRef = node ?? config.node_ref;
      if (!exact(harness, 128) || !exact(id) || (nodeRef !== undefined && !exact(nodeRef))) throw new Error("canonical_native_identity_invalid");
      const result = await client.call("session", {
        action: "resolve", harness, native_session_id: id, ...(nodeRef ? { node_ref: nodeRef } : {}),
      });
      const owner = result.owner as Record<string, unknown> | undefined;
      if (result.complete !== true || !exact(result.session_ref) || !owner
        || owner.harness !== harness || owner.native_session_id !== id
        || !exact(owner.node_ref) || !exact(owner.instance_ref)
        || (nodeRef !== undefined && owner.node_ref !== nodeRef)) throw new Error("canonical_native_identity_unresolved");
      return { sessionRef: result.session_ref, harness, nativeSessionId: id, nodeRef: owner.node_ref, instanceRef: owner.instance_ref };
    },
  };
  clientBindings.set(client, Object.freeze({ config: filename, config_sha256: sha256 }));
  return client;
}

/** Shared cutover barrier for wait creation and direct compatibility delivery. */
export async function requireCanonicalMigrationReady(client: CanonicalAutomationClient): Promise<void> {
  const { assertRetainedResumeAfterReady } = await import("./canonical-migration.js");
  await assertRetainedResumeAfterReady(client);
  if (client.config.resume_receipts) {
    const { readRetainedResumeReceipts } = await import("./resume/canonical-receipts.js");
    if ((await readRetainedResumeReceipts(client)).blockers.length) throw new Error("canonical_legacy_receipts_unresolved");
  }
}
