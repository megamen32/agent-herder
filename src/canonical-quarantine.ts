import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { CanonicalAutomationClient, CanonicalQuarantineProfile } from "./canonical-herder.js";
import { readCanonicalPinnedJson, readCanonicalPrivateBytes } from "./canonical-herder.js";
import type { RetainedResumeAfter } from "./canonical-migration.js";
import type { RetainedResumeReceipts } from "./resume/canonical-receipts.js";

type Row = Record<string, any>;
const object = (v: unknown): Row => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("canonical_quarantine_invalid");
  return v as Row;
};
const exact = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 4096
  && v.trim() === v && !/[\x00-\x1f\x7f]/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const sha = (v: string | Buffer): string => createHash("sha256").update(v).digest("hex");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const identity = (p: Pick<CanonicalQuarantineProfile, "node_ref" | "instance_ref" | "authority_generation">): string =>
  JSON.stringify([p.node_ref, p.instance_ref, p.authority_generation]);

/** A terminal command and detached shell launch do not prove a native wake. */
export function legacyJobOutcome(row: Row): "accepted" | "not_submitted" | "unknown" {
  const result = row.resume_result; const target = row.resume ?? {};
  if (!result || typeof result !== "object" || result.agent !== target.agent
    || result.session_id !== target.session_id || result.used_last !== false
    || result.admission_unknown === true || result.admissionUnknown === true) return "unknown";
  if (row.execute_resume === false && result.executed === false && result.ok === true && result.admitted !== true) return "not_submitted";
  if (result.notSubmitted === true && result.admitted !== true) return "not_submitted";
  if (result.ok === true && result.executed === true && result.admitted === true) return "accepted";
  return "unknown";
}

async function jobs(client: CanonicalAutomationClient): Promise<{ records: Row[]; sources: Map<string, string> }> {
  const config = client.config.quarantine!.legacy_jobs;
  const seal = object(await readCanonicalPinnedJson(config.snapshot, config.sha256));
  const info = await fs.lstat(config.directory);
  if (seal.version !== 1 || seal.kind !== "herder-legacy-jobs-retained" || seal.epoch !== client.epoch
    || seal.directory !== config.directory || !Array.isArray(seal.records) || seal.records.length > 10000
    || (info.mode & 0o777) !== 0o500 || !info.isDirectory() || info.uid !== process.getuid?.()
    || await fs.realpath(config.directory) !== config.directory
    || String(info.dev) !== seal.directory_identity?.device || String(info.ino) !== seal.directory_identity?.inode) {
    throw new Error("canonical_legacy_jobs_unsealed");
  }
  const records: Row[] = []; const sources = new Map<string, string>(); const names = new Set<string>();
  for (const raw of seal.records) {
    const record = object(raw);
    if (!exact(record.id) || record.id === "." || record.id === ".." || /[/\\]/.test(record.id)
      || !hash(record.sha256) || names.has(record.id)) throw new Error("canonical_legacy_jobs_invalid");
    names.add(record.id);
    const directory = path.join(config.directory, record.id);
    const metadata = await fs.lstat(directory);
    if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o500
      || await fs.realpath(directory) !== directory) throw new Error("canonical_legacy_jobs_unsealed");
    const file = path.join(directory, "meta.json");
    if (((await fs.lstat(file)).mode & 0o777) !== 0o400) throw new Error("canonical_legacy_jobs_unsealed");
    const bytes = await readCanonicalPrivateBytes(file);
    if (sha(bytes) !== record.sha256) throw new Error("canonical_legacy_jobs_changed");
    const row = object(JSON.parse(bytes.toString("utf8")));
    if (row.job_id !== record.id || !exact(row.state)) throw new Error("canonical_legacy_jobs_invalid");
    records.push({ ...row, source_path: file, source_sha256: record.sha256 });
    sources.set(file, record.sha256);
  }
  if (!same((await fs.readdir(config.directory)).sort(), [...names].sort())) throw new Error("canonical_legacy_jobs_changed");
  const after = await fs.lstat(config.directory);
  if (after.dev !== info.dev || after.ino !== info.ino || after.mtimeMs !== info.mtimeMs
    || after.ctimeMs !== info.ctimeMs || (after.mode & 0o777) !== 0o500) throw new Error("canonical_legacy_jobs_changed");
  return { records, sources };
}

export interface CanonicalQuarantineStatus {
  version: 1; configured: true; local_verified: true; native_verified: boolean;
  inventory_sha256: string;
  snapshots: Array<{ harness: string; node_ref: string; instance_ref: string; authority_generation: string; sha256: string }>;
  authorities: Row[];
}

/** All old records stay immutable. Native profile attestations, not this file,
 * authorize unrelated work. Unknown records retain an explicit reviewed scope. */
export async function assertCanonicalQuarantineReady(client: CanonicalAutomationClient,
  waits: RetainedResumeAfter, receipts?: RetainedResumeReceipts, verifyNative = true): Promise<CanonicalQuarantineStatus> {
  await client.assertCurrent();
  const config = client.config.quarantine;
  if (!config || !config.snapshots.length) throw new Error("canonical_quarantine_required");
  const legacy = await jobs(client);
  const sourceHashes = new Map(legacy.sources);
  for (const wait of waits.waits) {
    sourceHashes.set(path.join(client.config.resume_after.directory, wait.id + ".json"), (wait as any).migration.recordSha256);
  }
  if (client.config.resume_receipts) {
    const bytes = await readCanonicalPrivateBytes(client.config.resume_receipts.path, 16 * 1024 * 1024);
    sourceHashes.set(client.config.resume_receipts.path, sha(bytes));
  }
  const inventory = [...sourceHashes].map(([file, digest]) => file + "\0" + digest + "\n").sort().join("");
  if (sha(inventory) !== config.inventory_sha256) throw new Error("canonical_quarantine_inventory_mismatch");
  const snapshots: { profile: CanonicalQuarantineProfile; value: Row }[] = [];
  let canonicalRecords: string | undefined;
  for (const profile of config.snapshots) {
    const value = object(await readCanonicalPinnedJson(profile.path, profile.sha256, 16 * 1024 * 1024));
    if (value.version !== 1 || value.kind !== "herder-legacy-quarantine" || value.epoch !== client.epoch
      || value.authority_generation !== profile.authority_generation || value.node_ref !== profile.node_ref
      || value.instance_ref !== profile.instance_ref || value.writer_drain_sha256 !== client.config.writer_drain.sha256
      || value.inventory_sha256 !== config.inventory_sha256 || !Array.isArray(value.sources)
      || !Array.isArray(value.records) || value.records.length > 20000 || value.sources.length !== sourceHashes.size) {
      throw new Error("canonical_quarantine_snapshot_invalid");
    }
    const observedSources = new Set<string>();
    for (const source of value.sources) {
      if (!source || sourceHashes.get(source.path) !== source.sha256 || observedSources.has(source.path)) {
        throw new Error("canonical_quarantine_source_mismatch");
      }
      observedSources.add(source.path);
    }
    const seen = new Set<string>();
    for (const raw of value.records) {
      const record = object(raw);
      if (!exact(record.record_ref) || seen.has(record.record_ref) || !hash(record.record_sha256)
        || sourceHashes.get(record.source_path) !== record.source_sha256 || !Array.isArray(record.request_keys)
        || !record.request_keys.length || record.request_keys.some((k: unknown) => !exact(k))
        || !["accepted", "not_submitted", "unknown"].includes(record.outcome) || !Array.isArray(record.holds)
        || (record.outcome === "unknown") !== (record.holds.length > 0)) throw new Error("canonical_quarantine_record_invalid");
      seen.add(record.record_ref);
      for (const hold of record.holds) {
        if (!exact(hold.node_ref) || !exact(hold.instance_ref)
          || !(hold.native_session_id === null || (exact(hold.native_session_id) && hold.native_session_id !== "*"))) {
          throw new Error("canonical_quarantine_scope_invalid");
        }
      }
    }
    const serialized = JSON.stringify(value.records);
    if (canonicalRecords !== undefined && canonicalRecords !== serialized) throw new Error("canonical_quarantine_profile_coverage_mismatch");
    canonicalRecords = serialized;
    snapshots.push({ profile, value });
  }
  const all = new Map<string, Row>(snapshots[0]!.value.records.map((r: Row) => [r.record_ref, r]));
  const requireRecord = (ref: string, source: string, digest: string, keys: string[], unknown: boolean,
    harness: string, native: string | undefined, host = client.config.node_ref): void => {
    const record = all.get(ref);
    if (!record || record.source_path !== source || record.source_sha256 !== digest
      || keys.some(key => !record.request_keys.includes(key)) || (unknown && record.outcome !== "unknown")) {
      throw new Error("canonical_quarantine_coverage_missing");
    }
    if (unknown) {
      const matching = config.snapshots.filter(p => p.harness === harness
        && (!host || p.node_ref === host || p.legacy_host_ids?.includes(host)));
      // Absent harnesses need an explicit reviewed origin profile hold. A
      // target string which names no configured authority is not coverage.
      if (!matching.length && !record.holds.some((h: Row) => h.native_session_id === null
        && config.snapshots.some(p => p.node_ref === h.node_ref && p.instance_ref === h.instance_ref))) {
        throw new Error("canonical_quarantine_unmapped_scope_missing");
      }
      for (const p of matching) {
        if (!record.holds.some((h: Row) => h.node_ref === p.node_ref && h.instance_ref === p.instance_ref
          && (h.native_session_id === null || (native !== undefined && h.native_session_id === native)))) {
          throw new Error("canonical_quarantine_target_scope_missing");
        }
      }
    }
  };
  for (const wait of waits.waits) {
    const file = path.join(client.config.resume_after.directory, wait.id + ".json");
    requireRecord("resume-after:" + wait.id, file, sourceHashes.get(file)!,
      [wait.id, "resume-after:" + wait.id], waits.blockers.includes(wait.id), wait.owner.harness, wait.owner.sessionId, (wait.owner as unknown as Row).hostId ?? client.config.node_ref);
  }
  if (receipts && client.config.resume_receipts) {
    for (const [key, receipt] of Object.entries(receipts.records)) {
      requireRecord("resume-receipt:" + sha(key), client.config.resume_receipts.path,
        sourceHashes.get(client.config.resume_receipts.path)!, [key, "compat-resume:v1:" + sha(key)],
        receipts.blockers.includes(key), receipt.target?.agent ?? "unknown", receipt.target?.session_id,
         (receipt.target as unknown as Row)?.hostId ?? client.config.node_ref);
    }
  }
  for (const job of legacy.records) {
    const key = "agent-resume:job:" + job.job_id;
    requireRecord("agent-resume-job:" + job.job_id, job.source_path, job.source_sha256,
      [job.job_id, key, "compat-resume:v1:" + sha(key)], legacyJobOutcome(job) === "unknown", job.resume?.agent ?? "unknown", job.resume?.session_id,
       job.resume?.hostId ?? client.config.node_ref);
  }
  const status: CanonicalQuarantineStatus = { version: 1, configured: true, local_verified: true,
    native_verified: false, inventory_sha256: config.inventory_sha256,
    snapshots: config.snapshots.map(p => ({ harness: p.harness, node_ref: p.node_ref, instance_ref: p.instance_ref,
      authority_generation: p.authority_generation, sha256: p.sha256 })), authorities: [] };
  if (!verifyNative) { await client.assertCurrent(); return status; }
  // A fake local snapshot cannot enable a core that never installed its fence.
  const groups = new Map<string, CanonicalQuarantineProfile[]>();
  for (const p of config.snapshots) {
    const key = JSON.stringify([p.harness, p.node_ref]); groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  for (const expected of groups.values()) {
    const p = expected[0]!;
    const response = await client.call("automation", { action: "wait_status", harness: p.harness,
      native_session_id: "herder-migration-readiness:" + client.epoch, node_ref: p.node_ref });
    const proofs = Array.isArray(response.migration_authorities) ? response.migration_authorities
      : response.migration ? [response.migration] : [];
    if (response.version !== 1 || response.configured !== true || response.complete !== true
      || proofs.length !== expected.length) throw new Error("canonical_quarantine_native_unverified");
    const actual = new Set<string>();
    for (const raw of proofs) {
      const proof = object(raw);
      const id = identity(proof as any); const profile = expected.find(item => identity(item) === id);
      if (!profile || actual.has(id) || proof.version !== 1 || proof.configured !== true
        || proof.epoch !== client.epoch || proof.required_epoch !== client.epoch
        || proof.snapshot_sha256 !== profile.sha256 || proof.writer_drain_sha256 !== client.config.writer_drain.sha256
        || proof.inventory_sha256 !== config.inventory_sha256) throw new Error("canonical_quarantine_native_unverified");
      actual.add(id); status.authorities.push(proof);
    }
  }
  status.native_verified = true;
  status.authorities.sort((a, b) => identity(a as any).localeCompare(identity(b as any)));
  await client.assertCurrent();
  return status;
}
