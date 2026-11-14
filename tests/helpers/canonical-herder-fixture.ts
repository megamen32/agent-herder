import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { CanonicalHerderConfig } from "../../src/canonical-herder.js";
import type { ResumeAfterWait } from "../../src/resume-after.js";

type ObjectValue = Record<string, any>;
const execute = promisify(execFile);
export const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
let executableDigest: Promise<string> | undefined;

export async function canonicalFixture(waits: ResumeAfterWait[] = [], epoch = "migration-test-1") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "herder-canonical-wait-")));
  await fs.chmod(root, 0o700);
  const directory = path.join(root, "legacy-waits");
  await fs.mkdir(directory, { mode: 0o700 });
  const rows = [];
  for (const wait of waits) {
    const text = JSON.stringify(wait) + "\n";
    await fs.writeFile(path.join(directory, wait.id + ".json"), text, { mode: 0o400 });
    rows.push({ id: wait.id, sha256: sha256(text) });
  }
  const identity = await fs.stat(directory);
  const snapshot = {
    version: 1, kind: "herder-resume-after-retained", epoch, directory,
    directory_identity: { device: String(identity.dev), inode: String(identity.ino) },
    sealed_at: new Date().toISOString(), records: rows,
  };
  const snapshotPath = path.join(root, "waits-snapshot.json");
  const snapshotText = JSON.stringify(snapshot) + "\n";
  await fs.writeFile(snapshotPath, snapshotText, { mode: 0o400 });
  await fs.chmod(directory, 0o500);

  // A real short-lived fixture child proves that exact PID/birth is gone. This
  // does not launch a harness, model, scheduler, or shared service.
  const child = await execute(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync('/proc/self/stat','utf8'))"], { encoding: "utf8" });
  const stat = child.stdout.trim();
  const pid = Number(stat.slice(0, stat.indexOf(" ")));
  const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
  const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  executableDigest ??= fs.readFile(process.execPath).then(sha256);
  const now = new Date().toISOString();
  const drain = {
    version: 1, kind: "herder-legacy-writer-drain", epoch, platform: "linux", hostname: hostname(), node_ref: "server-100",
    completed_at: now, sources: [directory], writers: [{
      pid, boot_id: boot, start_ticks: ticks, executable_sha256: await executableDigest, sources: [directory],
      observation: { observed_at: now, result: "identity_absent", provider_operation_id: "test-child-exit-" + pid,
        target: "fixture:local-process", method: "wait-for-exit" },
    }],
  };
  const drainPath = path.join(root, "writer-drain.json");
  const drainText = JSON.stringify(drain) + "\n";
  await fs.writeFile(drainPath, drainText, { mode: 0o400 });
  const config: CanonicalHerderConfig = {
    version: 1, mode: "canonical", epoch, authority: "mcp:shell:roomhacker-server-100:AgentHerder",
    writer_drain: { path: drainPath, sha256: sha256(drainText) },
    resume_after: { directory, snapshot: snapshotPath, sha256: sha256(snapshotText) },
  };
  const configPath = path.join(root, "canonical.json");
  const env: NodeJS.ProcessEnv = {
    AGENT_HERDER_CANONICAL_MODE: "canonical", AGENT_HERDER_CANONICAL_CONFIG: configPath,
  };
  const writeConfig = async () => {
    const text = JSON.stringify(config) + "\n";
    await fs.chmod(configPath, 0o600).catch(() => {});
    await fs.writeFile(configPath, text, { mode: 0o600 });
    env.AGENT_HERDER_CANONICAL_CONFIG_SHA256 = sha256(text);
  };
  await writeConfig();
  return { root, directory, snapshot, snapshotPath, drain, drainPath, config, configPath, env, writeConfig,
    async writeDrain() {
      const text = JSON.stringify(drain) + "\n";
      await fs.chmod(drainPath, 0o600); await fs.writeFile(drainPath, text); await fs.chmod(drainPath, 0o400);
      config.writer_drain.sha256 = sha256(text); await writeConfig();
    },
    async cleanup() { await fs.chmod(directory, 0o700).catch(() => {}); await fs.rm(root, { recursive: true, force: true }); },
  };
}

/** Durable authority model shared across facade restarts. Its clock stays here. */
export class CanonicalCoreFixture {
  readonly calls: Array<{ target: string; tool: string; args: ObjectValue }> = [];
  readonly rows = new Map<string, ObjectValue>();
  readonly bindings = new Map<string, ObjectValue>();
  readonly keys = new Map<string, string>();
  now = Date.now();
  admissions = 0;
  loseNextCreate = false;
  completeList = true;
  invalidTurnProof = false;

  constructor() {
    this.bind("codex", "parent"); this.bind("codex", "child-b"); this.bind("zcode", "child-a", "server-44");
  }
  bind(harness: string, native: string, node = "server-100") {
    const session = "session:" + harness + ":" + native;
    this.bindings.set(session, { harness, native_session_id: native, node_ref: node, instance_ref: "instance:" + node + ":" + harness });
    return session;
  }
  readonly transport = { call: async (target: string, tool: string, args: ObjectValue): Promise<unknown> => {
    this.calls.push({ target, tool, args: copy(args) });
    if (tool === "session" && args.action === "resolve") {
      const matches = [...this.bindings].filter(([, owner]) => owner.harness === args.harness
        && owner.native_session_id === args.native_session_id && (!args.node_ref || owner.node_ref === args.node_ref));
      if (matches.length !== 1) throw new Error("native_session_not_registered_or_ambiguous");
      return { complete: true, session_ref: matches[0]![0], owner: copy(matches[0]![1]) };
    }
    if (tool !== "automation") throw new Error("unexpected canonical tool");
    if (args.action === "list") return { rules: [...this.rows.values()].map(copy), complete: this.completeList };
    if (args.action === "get" || args.action === "delete") {
      const row = this.rows.get(args.rule_ref);
      if (!row) return { isError: true, structuredContent: { code: "rule_not_found", effect: "none", message: "No such rule" } };
      if (args.action === "delete" && row.status !== "cancelled") {
        if (args.revision !== row.revision) throw new Error("revision_conflict");
        row.revision++; row.status = "cancelled"; row.wait.phase = "cancelled"; row.wait.wake_cancelled = true;
      }
      return copy(row);
    }
    if (args.action !== "create") throw new Error("unexpected canonical action");
    const key = JSON.stringify([args.session_ref, args.request_key]);
    const previous = this.keys.get(key);
    if (previous) {
      const row = this.rows.get(previous)!;
      if (!isDeepStrictEqual(row.rule, args.rule)) throw new Error("request_key_conflict");
      return copy(row);
    }
    const owner = this.bindings.get(args.session_ref);
    if (!owner) throw new Error("owner_not_registered");
    const rule = copy(args.rule);
    const due = rule.kind === "timer" ? rule.trigger.kind === "delay" ? this.now + rule.trigger.delay_ms : Date.parse(rule.trigger.at) : null;
    const ref = "wait-rule:" + sha256(key);
    const row = {
      rule_ref: ref, kind: rule.kind, session_ref: args.session_ref, owner: copy(owner), request_key: args.request_key, rule,
      created_at: new Date(this.now).toISOString(), due_at: due === null ? null : new Date(due).toISOString(), due_unix_ms: due,
      dependencies: (rule.dependencies ?? []).map((session_ref: string) => ({
        session_ref, owner: copy(this.bindings.get(session_ref)), native_turn_id: this.invalidTurnProof ? null : "native-turn:" + session_ref,
        captured_status: "running", authority_generation: 1, scope_generation: 1,
      })), revision: 1, status: "armed", wait: { phase: "armed", detail: null, delivery_task: null, wake_cancelled: false, cancel_generation: null },
      delivery_status: null,
    };
    this.rows.set(ref, row); this.keys.set(key, ref); this.admissions++;
    if (this.loseNextCreate) { this.loseNextCreate = false; throw new Error("lost_ack_after_durable_admission"); }
    return copy(row);
  } };
  phase(id: string, phase: string) {
    const row = this.rows.get(id)!; row.status = phase; row.wait.phase = phase;
    if (phase === "confirmed") { row.delivery_status = "handed_off"; row.wait.delivery_task = "task:original-wake"; }
  }
}
