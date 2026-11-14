import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import type { CanonicalAutomationClient } from "./canonical-herder.js";
import { readCanonicalPinnedJson, readCanonicalPrivateBytes } from "./canonical-herder.js";
import type { ResumeAfterWait } from "./resume-after.js";

type ObjectValue = Record<string, unknown>;
const record = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("canonical_migration_invalid");
  return value as ObjectValue;
};
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const exact = (value: unknown): value is string => typeof value === "string" && value.length > 0
  && value.length <= 4096 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const instant = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
function settled(wait: ObjectValue): boolean {
  const delivery = wait.delivery && typeof wait.delivery === "object" && !Array.isArray(wait.delivery)
    ? wait.delivery as ObjectValue : undefined;
  const receipt = delivery?.receipt && typeof delivery.receipt === "object" && !Array.isArray(delivery.receipt)
    ? delivery.receipt as ObjectValue : undefined;
  if (wait.state === "resumed" && delivery?.status === "accepted") return true;
  // Legacy cancellation could overwrite an already unknown handoff. A cancelled
  // label alone therefore cannot prove that the old delivery never happened.
  return ["cancelled", "delivery_blocked", "delivery_failed"].includes(String(wait.state))
    && delivery?.status === "rejected" && receipt?.notSubmitted === true
    && receipt.admitted !== true && receipt.admissionUnknown !== true;
}

export interface RetainedResumeAfter {
  epoch: string;
  waits: ResumeAfterWait[];
  ready: boolean;
  blockers: string[];
}

/** Immutable source files remain the migration evidence. This never repairs or imports them. */
export async function readRetainedResumeAfter(client: CanonicalAutomationClient): Promise<RetainedResumeAfter> {
  await client.assertCurrent();
  const config = client.config.resume_after;
  const snapshot = record(await readCanonicalPinnedJson(config.snapshot, config.sha256));
  const identity = record(snapshot.directory_identity);
  if (snapshot.version !== 1 || snapshot.kind !== "herder-resume-after-retained" || snapshot.epoch !== client.epoch
    || snapshot.directory !== config.directory || !instant(snapshot.sealed_at)
    || !exact(identity.device) || !exact(identity.inode) || !Array.isArray(snapshot.records)
    || snapshot.records.length > 10000) throw new Error("canonical_retained_snapshot_invalid");
  if (!path.isAbsolute(config.directory) || await fs.realpath(config.directory) !== config.directory) throw new Error("canonical_retained_directory_untrusted");
  const before = await fs.lstat(config.directory);
  if (!before.isDirectory() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o500
    || String(before.dev) !== identity.device || String(before.ino) !== identity.inode) {
    throw new Error("canonical_retained_directory_unsealed");
  }
  const names = await fs.readdir(config.directory);
  const expected: string[] = [];
  const waits: ResumeAfterWait[] = [];
  const blockers: string[] = [];
  for (const value of snapshot.records) {
    const row = record(value);
    if (typeof row.id !== "string" || !/^wait_[a-f0-9]{32}$/.test(row.id) || !hash(row.sha256)
      || expected.includes(row.id + ".json")) throw new Error("canonical_retained_record_invalid");
    expected.push(row.id + ".json");
    const filename = path.join(config.directory, row.id + ".json");
    const metadata = await fs.lstat(filename);
    if ((metadata.mode & 0o777) !== 0o400) throw new Error("canonical_retained_record_unsealed");
    const bytes = await readCanonicalPrivateBytes(filename);
    if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new Error("canonical_retained_record_changed");
    const wait = record(JSON.parse(bytes.toString("utf8")));
    const owner = record(wait.owner);
    if (wait.id !== row.id || !exact(owner.harness) || !exact(owner.sessionId) || !Array.isArray(wait.dependencies)
      || !exact(wait.createdAt) || !Number.isFinite(Date.parse(wait.createdAt))
      || typeof wait.message !== "string" || typeof wait.state !== "string" || !wait.completed
      || typeof wait.completed !== "object" || Array.isArray(wait.completed)) throw new Error("canonical_retained_record_invalid");
    // Failed without explicit non-submission evidence remains unresolved too.
    if (!settled(wait)) blockers.push(row.id);
    waits.push({ ...wait, migration: {
      epoch: client.epoch, retained: true, dispatchBlocked: true, recordSha256: row.sha256,
    } } as unknown as ResumeAfterWait);
  }
  if (JSON.stringify(names.sort()) !== JSON.stringify(expected.sort())) throw new Error("canonical_retained_inventory_changed");
  const after = await fs.lstat(config.directory);
  if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs || (after.mode & 0o777) !== 0o500) throw new Error("canonical_retained_directory_changed");
  return { epoch: client.epoch, waits, ready: blockers.length === 0, blockers };
}

/**
 * Pinned inventory comes from the reviewed writer drain. Independently verify
 * each Linux boot/birth identity is gone. File modes alone cannot prove this.
 * Other platforms need their own reviewed identity verifier before cutover.
 */
export async function assertCanonicalWriterDrain(client: CanonicalAutomationClient): Promise<void> {
  await client.assertCurrent();
  const config = client.config.writer_drain;
  const proof = record(await readCanonicalPinnedJson(config.path, config.sha256));
  if (proof.version !== 1 || proof.kind !== "herder-legacy-writer-drain" || proof.epoch !== client.epoch
    || proof.platform !== "linux" || proof.hostname !== hostname() || !exact(proof.node_ref) || !instant(proof.completed_at)
    || Date.parse(proof.completed_at) > Date.now() + 5000
    || !Array.isArray(proof.sources) || !Array.isArray(proof.writers) || proof.writers.length === 0
    || proof.writers.length > 256 || process.platform !== "linux") throw new Error("canonical_writer_drain_unverified");
  const sources = proof.sources as unknown[];
  if (!sources.every(exact) || new Set(sources).size !== sources.length
    || !sources.includes(client.config.resume_after.directory)
    || (client.config.resume_receipts && !sources.includes(client.config.resume_receipts.path))) throw new Error("canonical_writer_drain_scope_mismatch");
  const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const identities = new Set<string>();
  const covered = new Set<string>();
  for (const value of proof.writers) {
    const writer = record(value);
    const observation = record(writer.observation);
    if (!Number.isSafeInteger(writer.pid) || Number(writer.pid) <= 1 || typeof writer.boot_id !== "string"
      || !/^[a-f0-9-]{36}$/.test(writer.boot_id) || typeof writer.start_ticks !== "string" || !/^\d+$/.test(writer.start_ticks)
      || !hash(writer.executable_sha256) || !Array.isArray(writer.sources) || writer.sources.length === 0
      || !writer.sources.every(source => exact(source) && sources.includes(source))
      || !instant(observation.observed_at)
      || Date.parse(observation.observed_at) > Date.parse(proof.completed_at)
      || observation.result !== "identity_absent" || !exact(observation.provider_operation_id)
      || !exact(observation.target) || !exact(observation.method)) throw new Error("canonical_writer_drain_unverified");
    const id = JSON.stringify([writer.boot_id, writer.pid, writer.start_ticks]);
    if (identities.has(id)) throw new Error("canonical_writer_drain_ambiguous");
    identities.add(id);
    for (const source of writer.sources as string[]) covered.add(source);
    if (boot !== writer.boot_id) continue;
    let stat: string;
    try { stat = await fs.readFile(`/proc/${writer.pid}/stat`, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw new Error("canonical_writer_drain_unavailable"); }
    const close = stat.lastIndexOf(")");
    const fields = close > 0 ? stat.slice(close + 2).split(" ") : [];
    if (fields.length < 20 || !/^\d+$/.test(fields[19]!)) throw new Error("canonical_writer_identity_unavailable");
    // A reused PID is acceptable only with a different exact birth identity.
    if (fields[19] === writer.start_ticks) throw new Error("canonical_legacy_writer_still_alive");
  }
  if (sources.some(source => !covered.has(String(source)))) throw new Error("canonical_writer_drain_scope_mismatch");
}

export async function assertRetainedResumeAfterReady(client: CanonicalAutomationClient): Promise<void> {
  await assertCanonicalWriterDrain(client);
  const retained = await readRetainedResumeAfter(client);
  if (!retained.ready) throw new Error("canonical_legacy_waits_unresolved:" + retained.blockers.join(","));
}
