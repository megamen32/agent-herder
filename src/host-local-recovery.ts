import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ProcessWaitDecision } from "./process-wait-gate.js";

export interface ExactRecoveryOwner {
  readonly nativeId: string;
  readonly nodeRef: string;
  decision(): Promise<ProcessWaitDecision>;
}

export const recoveryUnavailable = (): ProcessWaitDecision => ({
  blocked: true, reason: "native_recovery_ownership_unavailable",
});

export function nativeHandoff(reply: unknown, start: number, end: number): ProcessWaitDecision {
  const r = reply as { isError?: boolean; structuredContent?: Record<string, unknown> } | null;
  const v = r?.structuredContent;
  const observed = typeof v?.observedAt === "string" ? Date.parse(v.observedAt) : NaN;
  if (r?.isError || !v || v.version !== 1 || v.complete !== true || v.configured !== true ||
      typeof v.reason !== "string" || !v.reason || typeof v.mapped !== "boolean" || v.blocked !== true || v.recoveryOwner !== "rust" ||
      !Number.isFinite(observed) || observed < start - 5000 || observed > end + 5000 ||
      !Array.isArray(v.sessionRefs) || !v.sessionRefs.every(i => typeof i === "string") ||
      !Array.isArray(v.ruleRefs) || !v.ruleRefs.every(i => typeof i === "string") ||
      (!v.mapped && (v.sessionRefs.length || v.ruleRefs.length))) return recoveryUnavailable();
  return { blocked: true, recoveryOwner: "rust",
    reason: v.reason === "rust_recovery_handoff" ? v.reason : "native_recovery_held" };
}

async function pinned(path: string, pin: string, limit: number, keepBytes = false): Promise<Buffer> {
  const invalid = () => new Error("untrusted host-local recovery artifact");
  if (!isAbsolute(path) || await realpath(path) !== path || !/^[a-f0-9]{64}$/.test(pin)) throw invalid();
  for (let dir = dirname(path);;) {
    const st = await lstat(dir);
    if (!st.isDirectory() || (st.uid !== 0 && st.uid !== process.getuid?.()) || (st.mode & 0o022)) throw invalid();
    if (dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    if (!st.isFile() || st.uid !== process.getuid?.() || st.nlink !== 1 || (st.mode & 0o077) || st.size > limit) throw invalid();
    const hash = createHash("sha256");
    const pieces: Buffer[] = [];
    const block = Buffer.alloc(Math.min(65536, limit));
    let size = 0;
    for (;;) {
      const { bytesRead } = await file.read(block);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw invalid();
      const piece = block.subarray(0, bytesRead);
      hash.update(piece);
      if (keepBytes) pieces.push(Buffer.from(piece));
    }
    const current = await lstat(path);
    if (size !== st.size || current.dev !== st.dev || current.ino !== st.ino ||
        current.ctimeMs !== st.ctimeMs || hash.digest("hex") !== pin) throw invalid();
    return Buffer.concat(pieces);
  } finally { await file.close(); }
}

// Only the Fleet singleton enables this stdio child. Its current scheduler sweep
// also reopens a dead child; queries in helper processes can only defer the exact ID.
export class HostLocalRecovery implements ExactRecoveryOwner {
  private enabled = false;
  private client?: Client;
  private connecting?: Promise<Client>;
  constructor(readonly nativeId: string, readonly nodeRef: string, private readonly env: NodeJS.ProcessEnv) {}

  start(): void { this.enabled = true; this.maintain(); }
  maintain(): void {
    if (this.enabled && !this.client) void this.connected().catch(() => undefined);
  }
  async close(): Promise<void> {
    this.enabled = false;
    const client = this.client ?? await this.connecting?.catch(() => undefined);
    if (client) await client.close();
  }
  async decision(): Promise<ProcessWaitDecision> {
    try {
      const client = await this.connected();
      const start = Date.now();
      const reply = await client.callTool({ name: "automation", arguments: {
        action: "wait_status", harness: "codex", node_ref: this.nodeRef, native_session_id: this.nativeId,
      } }, { timeout: 5000 });
      return nativeHandoff(reply, start, Date.now());
    } catch { return recoveryUnavailable(); }
  }
  private async connected(): Promise<Client> {
    if (!this.enabled) throw new Error("recovery owner is offline");
    if (this.client) return this.client;
    this.connecting ??= this.open().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  private async open(): Promise<Client> {
    const e = this.env;
    if (hostname() !== this.nodeRef) throw new Error("host-local recovery node mismatch");
    if ((e.AGENT_HERDER_CANONICAL_MODE ?? "legacy") !== "legacy" || e.AGENT_HERDER_CANONICAL_CONFIG ||
        e.AGENT_HERDER_PROCESS_WAIT_AUTHORITY || e.AGENT_HERDER_PROCESS_WAIT_SELECTOR ||
        e.AGENT_HERDER_PROCESS_WAIT_LAUNCHER || e.AGENT_HERDER_PROCESS_WAIT_NODE_REF || e.HERDER_V1_ENTRY) {
      throw new Error("a previous wait authority is configured");
    }
    try {
      await lstat(join(homedir(), ".config/agent-herder/gptadmin-entry.json"));
      throw new Error("a previous wait selector is installed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const path = e.AGENT_HERDER_LOCAL_RECOVERY_PROFILE ?? "";
    const core = e.AGENT_HERDER_LOCAL_RECOVERY_CORE ?? "";
    const profile = JSON.parse((await pinned(path, e.AGENT_HERDER_LOCAL_RECOVERY_PROFILE_SHA256 ?? "", 16384, true)).toString("utf8"));
    const owner = profile.owner;
    const scope = owner?.codex_recovery?.legacy_handoff;
    if (owner?.node !== this.nodeRef || !this.nodeRef || owner.kind !== "codex" ||
        owner.instance !== e.AGENT_HERDER_LOCAL_RECOVERY_INSTANCE || !owner.instance ||
        !owner.ahap_env?.AHAP_CODEX_SOCKET || !Array.isArray(scope?.native_sessions) ||
        scope.native_sessions.length !== 1 || scope.native_sessions[0] !== this.nativeId ||
        scope.instance_wide || scope.workspaces !== undefined || owner.opencode_recovery) throw new Error("host-local recovery scope mismatch");
    await pinned(core, e.AGENT_HERDER_LOCAL_RECOVERY_CORE_SHA256 ?? "", 128 * 1024 * 1024);
    const client = new Client({ name: "herder-local-recovery-gate", version: "1" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    client.onclose = () => { if (this.client === client) this.client = undefined; };
    try {
      await client.connect(new StdioClientTransport({ command: core, args: ["--trusted-owner-profile", path],
        env: { HOME: homedir(), PATH: "/usr/bin:/bin" }, stderr: "ignore", maxBufferSize: 131072 }), { timeout: 5000 });
      if (!this.enabled) throw new Error("recovery owner is offline");
      this.client = client;
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }
}

const exactId = process.env.AGENT_HERDER_LOCAL_RECOVERY_NATIVE_ID;
export const installedLocalRecovery = exactId
  ? new HostLocalRecovery(exactId, process.env.AGENT_HERDER_LOCAL_RECOVERY_NODE ?? "", process.env) : undefined;
