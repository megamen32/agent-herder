import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResumeAfterBackend } from "./resume-after.js";
import { canonicalMode, readCanonicalPrivateBytes } from "./canonical-herder.js";
import { observeInstalledCanonicalProcessWait } from "./process-wait-gate.js";
import type { CanonicalWaitObservation, ProcessWaitTarget } from "./process-wait-gate.js";

export const CANONICAL_RUNTIME_STATUS_PATH = "/api/canonical-runtime-status";
const CAPABILITY = "canonical-scheduler-wait-gate-v1";
const MiB = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const requiredFiles = ["index.js", "canonical-runtime-status.js", "canonical-herder.js", "canonical-migration.js",
  "resume-after-runtime.js", "resume-after-canonical.js", "process-wait-gate.js"];

type BackendProof = { config: string; config_sha256: string; epoch: string; authority: string; writer_drain_sha256: string };
type ObservableBackend = ResumeAfterBackend & { canonicalReadiness?: () => Promise<BackendProof> };
type Manifest = { version: 1; kind: "herder-canonical-ts-runtime"; capability: typeof CAPABILITY;
  source_commit: string; root: string; entry: "index.js"; files: Record<string, string>; node_binary: string; node_sha256: string };
export type RuntimeStatusRequest = { challenge: string; probe?: ProcessWaitTarget };
export type RuntimeProcessIdentity = { pid: number; boot_id: string; start_ticks: string; entry: string;
  node_binary: string; node_device: number; node_inode: number; module_path: string };
export interface CanonicalRuntimeStatusSource { observe(request: RuntimeStatusRequest): Promise<Record<string, unknown>> }
export class CanonicalRuntimeStatusError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code); }
}
type Options = { env?: NodeJS.ProcessEnv; now?: () => number;
  /** Isolated proof fixtures only; production always observes its own Linux process. */
  processIdentity?: () => Promise<RuntimeProcessIdentity>;
  observeGate?: (target: ProcessWaitTarget) => Promise<CanonicalWaitObservation> };

const fail = (code: string): never => { throw new CanonicalRuntimeStatusError(code); };
const exact = (value: unknown, maximum = 4096): value is string => typeof value === "string" && value.length > 0
  && value.length <= maximum && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const absolute = (value: unknown): value is string => exact(value) && path.isAbsolute(value) && path.normalize(value) === value;
const relative = (value: string): boolean => exact(value, 512) && !path.isAbsolute(value) && !value.includes("\\")
  && value.split("/").every(part => part !== "" && part !== "." && part !== "..");

export function parseCanonicalRuntimeStatusRequest(params: URLSearchParams): RuntimeStatusRequest {
  const allowed = new Set(["challenge", "harness", "nativeSessionId", "nodeRef"]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1)
    throw new CanonicalRuntimeStatusError("invalid_runtime_status_request", 400);
  const challenge = params.get("challenge");
  if (!challenge || !HASH.test(challenge)) throw new CanonicalRuntimeStatusError("invalid_runtime_challenge", 400);
  const harness = params.get("harness"), native = params.get("nativeSessionId"), node = params.get("nodeRef");
  if (harness === null && native === null && node === null) return { challenge };
  if (!exact(harness, 128) || !/^[A-Za-z0-9._-]+$/.test(harness) || !exact(native)
    || (node !== null && !exact(node, 512))) throw new CanonicalRuntimeStatusError("invalid_runtime_probe", 400);
  return { challenge, probe: { harness, nativeSessionId: native, ...(node !== null ? { nodeRef: node } : {}) } };
}

function manifest(value: unknown): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("runtime_manifest_invalid");
  const row = value as Record<string, unknown>;
  const keys = ["version", "kind", "capability", "source_commit", "root", "entry", "files", "node_binary", "node_sha256"];
  if (keys.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !keys.includes(key))
    || row.version !== 1 || row.kind !== "herder-canonical-ts-runtime" || row.capability !== CAPABILITY
    || typeof row.source_commit !== "string" || !/^[a-f0-9]{40}$/.test(row.source_commit)
    || !absolute(row.root) || row.entry !== "index.js" || !absolute(row.node_binary)
    || typeof row.node_sha256 !== "string" || !HASH.test(row.node_sha256)
    || !row.files || typeof row.files !== "object" || Array.isArray(row.files)) return fail("runtime_manifest_invalid");
  const entries = Object.entries(row.files);
  if (!entries.length || entries.length > 10000 || requiredFiles.some(name => !Object.hasOwn(row.files as object, name))
    || entries.some(([name, digest]) => !relative(name) || typeof digest !== "string" || !HASH.test(digest))) return fail("runtime_manifest_invalid");
  return row as unknown as Manifest;
}

function unchanged(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.mode === after.mode && before.uid === after.uid;
}
async function fileProof(filename: string, maximum: number, node = false): Promise<{ sha256: string; stat: Stats }> {
  if (await fs.realpath(filename) !== filename) return fail("runtime_file_untrusted");
  const selected = await fs.lstat(filename);
  if (!selected.isFile()) return fail("runtime_file_untrusted");
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    const permissions = before.mode & 0o7777;
    const modeOK = node ? ((before.uid === process.getuid?.() && permissions === 0o500)
      || (before.uid === 0 && permissions === 0o555)) : before.uid === process.getuid?.() && permissions === 0o400;
    if (!before.isFile() || !modeOK || before.nlink !== 1 || before.size > maximum
      || selected.dev !== before.dev || selected.ino !== before.ino) return fail("runtime_file_untrusted");
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length; if (bytes > maximum) return fail("runtime_file_too_large"); hash.update(chunk);
    }
    const after = await handle.stat(), named = await fs.lstat(filename);
    if (bytes !== before.size || !unchanged(before, after) || !unchanged(before, named) || !named.isFile()) return fail("runtime_file_changed");
    return { sha256: hash.digest("hex"), stat: before };
  } finally { await handle.close(); }
}

async function treeProof(value: Manifest): Promise<void> {
  if (await fs.realpath(value.root) !== value.root) return fail("runtime_tree_untrusted");
  const found = new Set<string>(); const directories: Array<[string, Stats]> = []; let entries = 0, bytes = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 32) return fail("runtime_tree_too_large");
    const before = await fs.lstat(directory);
    if (!before.isDirectory() || before.uid !== process.getuid?.() || (before.mode & 0o7777) !== 0o500) return fail("runtime_tree_untrusted");
    directories.push([directory, before]);
    for (const name of (await fs.readdir(directory)).sort()) {
      if (++entries > 20000) return fail("runtime_tree_too_large");
      const filename = path.join(directory, name), relativeName = path.relative(value.root, filename);
      if (!relative(relativeName)) return fail("runtime_tree_untrusted");
      const item = await fs.lstat(filename);
      if (item.isDirectory()) { await walk(filename, depth + 1); continue; }
      if (!item.isFile() || !Object.hasOwn(value.files, relativeName) || found.size >= 10000) return fail("runtime_tree_inventory_mismatch");
      bytes += item.size; if (bytes > 512 * MiB) return fail("runtime_tree_too_large");
      const proof = await fileProof(filename, 64 * MiB);
      if (proof.sha256 !== value.files[relativeName]) return fail("runtime_tree_digest_mismatch");
      found.add(relativeName);
    }
  };
  await walk(value.root, 0);
  if (found.size !== Object.keys(value.files).length) return fail("runtime_tree_inventory_mismatch");
  for (const [directory, before] of directories) if (!unchanged(before, await fs.lstat(directory))) return fail("runtime_tree_changed");
}

async function linuxIdentity(): Promise<RuntimeProcessIdentity> {
  if (process.platform !== "linux") return fail("runtime_platform_unsupported");
  if (process.argv.length !== 2 || process.execArgv.length !== 0
    || ["NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_AUDIT"].some(key => process.env[key])) return fail("runtime_process_injection_disallowed");
  const stat = await fs.readFile("/proc/self/stat", "utf8");
  const close = stat.lastIndexOf(")"), pid = Number(stat.slice(0, stat.indexOf(" ")));
  const ticks = stat.slice(close + 2).trim().split(/\s+/)[19];
  const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const entry = process.argv[1], node = process.execPath;
  if (close < 0 || pid !== process.pid || !ticks || !/^[1-9][0-9]*$/.test(ticks)
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot)
    || !absolute(entry) || !absolute(node) || await fs.realpath(entry) !== entry || await fs.realpath(node) !== node) return fail("runtime_process_identity_unavailable");
  const exe = await fs.stat("/proc/self/exe");
  return { pid, boot_id: boot, start_ticks: ticks, entry, node_binary: node,
    node_device: exe.dev, node_inode: exe.ino, module_path: fileURLToPath(import.meta.url) };
}

/** Observe this process's installed scheduler and gate. Never starts another backend. */
export function createCanonicalRuntimeStatus(service: ResumeAfterBackend, options: Options = {}): CanonicalRuntimeStatusSource {
  const env = options.env ?? process.env;
  const selected = env.AGENT_HERDER_TS_RUNTIME_MANIFEST, selectedHash = env.AGENT_HERDER_TS_RUNTIME_MANIFEST_SHA256;
  const identity = options.processIdentity ?? linuxIdentity;
  const observeGate = options.observeGate ?? observeInstalledCanonicalProcessWait;
  const clock = options.now ?? Date.now;
  return { async observe(request) {
    if (!HASH.test(request.challenge)) throw new CanonicalRuntimeStatusError("invalid_runtime_challenge", 400);
    if (service.authority !== "canonical" || typeof (service as ObservableBackend).canonicalReadiness !== "function") return fail("canonical_backend_not_active");
    if (canonicalMode(env) !== "canonical") return fail("canonical_backend_not_active");
    if (!absolute(selected) || typeof selectedHash !== "string" || !HASH.test(selectedHash)
      || env.AGENT_HERDER_TS_RUNTIME_MANIFEST !== selected || env.AGENT_HERDER_TS_RUNTIME_MANIFEST_SHA256 !== selectedHash) return fail("runtime_manifest_unconfigured");
    try {
      const manifestMeta = await fs.lstat(selected);
      if ((manifestMeta.mode & 0o7777) !== 0o400) return fail("runtime_manifest_untrusted");
      const bytes = await readCanonicalPrivateBytes(selected, 8 * MiB);
      if (createHash("sha256").update(bytes).digest("hex") !== selectedHash) return fail("runtime_manifest_digest_mismatch");
      const value = manifest(JSON.parse(bytes.toString("utf8")));
      if (selected === value.root || selected.startsWith(value.root + path.sep)) return fail("runtime_manifest_inside_tree");
      const actual = await identity();
      if (actual.entry !== path.join(value.root, value.entry) || actual.node_binary !== value.node_binary
        || actual.module_path !== path.join(value.root, "canonical-runtime-status.js")) return fail("runtime_process_binding_mismatch");
      await treeProof(value);
      const node = await fileProof(value.node_binary, 256 * MiB, true);
      if (node.sha256 !== value.node_sha256 || node.stat.dev !== actual.node_device || node.stat.ino !== actual.node_inode) return fail("runtime_node_binding_mismatch");
      const backend = await (service as ObservableBackend).canonicalReadiness!();
      if (backend.config !== env.AGENT_HERDER_CANONICAL_CONFIG || backend.config_sha256 !== env.AGENT_HERDER_CANONICAL_CONFIG_SHA256
        || !absolute(backend.config) || !HASH.test(backend.config_sha256) || !HASH.test(backend.writer_drain_sha256)) return fail("canonical_backend_binding_mismatch");
      let probe: Record<string, unknown> | null = null;
      if (request.probe) {
        const observed = await observeGate(request.probe);
        if (observed.config !== backend.config || observed.config_sha256 !== backend.config_sha256
          || observed.epoch !== backend.epoch || observed.authority !== backend.authority
          || observed.request.harness !== request.probe.harness
          || observed.request.native_session_id !== request.probe.nativeSessionId
          || (request.probe.nodeRef !== undefined && observed.request.node_ref !== request.probe.nodeRef)) return fail("canonical_gate_binding_mismatch");
        probe = { request: observed.request, decision: observed.decision, gateBlocked: observed.gateBlocked };
      }
      const currentBackend = await (service as ObservableBackend).canonicalReadiness!();
      if (JSON.stringify(currentBackend) !== JSON.stringify(backend)
        || backend.config !== env.AGENT_HERDER_CANONICAL_CONFIG || backend.config_sha256 !== env.AGENT_HERDER_CANONICAL_CONFIG_SHA256
        || canonicalMode(env) !== "canonical") return fail("canonical_backend_binding_mismatch");
      const after = await identity();
      if (JSON.stringify(after) !== JSON.stringify(actual) || !unchanged(manifestMeta, await fs.lstat(selected))
        || env.AGENT_HERDER_TS_RUNTIME_MANIFEST !== selected || env.AGENT_HERDER_TS_RUNTIME_MANIFEST_SHA256 !== selectedHash) return fail("runtime_process_changed");
      return { version: 1, kind: "herder-canonical-runtime-status", challenge: request.challenge, observedAt: new Date(clock()).toISOString(),
        process: { pid: actual.pid, boot_id: actual.boot_id, start_ticks: actual.start_ticks,
          entry: actual.entry, entry_sha256: value.files[value.entry], node_binary: value.node_binary, node_sha256: node.sha256 },
        runtime: { manifest: selected, manifest_sha256: selectedHash, source_commit: value.source_commit, capability: CAPABILITY,
          resume_after_authority: "canonical", legacy_fallback: false }, canonical: backend, migration_ready: true, probe };
    } catch (error) {
      if (error instanceof CanonicalRuntimeStatusError) throw error;
      throw new CanonicalRuntimeStatusError("canonical_runtime_unavailable");
    }
  } };
}
