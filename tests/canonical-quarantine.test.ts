import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalFixture, sha256 } from "./helpers/canonical-herder-fixture.js";
import { createCanonicalAutomationClient, requireCanonicalMigrationReady } from "../src/canonical-herder.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const id = "wait_" + "a".repeat(32);
  const f = await canonicalFixture([{ id, owner: { harness: "codex", sessionId: "old-native", hostId: "server-100" },
    dependencies: [], message: "historical", state: "cancelled", completed: {}, createdAt: new Date().toISOString(),
  } as any]);
  const jobs = path.join(f.root, "jobs"); await fs.mkdir(jobs, { mode: 0o500 });
  cleanups.push(async () => { await fs.chmod(jobs, 0o700); await f.cleanup(); });
  const write = async (name: string, value: unknown) => {
    const file = path.join(f.root, name); const bytes = JSON.stringify(value) + "\n";
    await fs.chmod(file, 0o600).catch(() => {}); await fs.writeFile(file, bytes, { mode: 0o400 }); await fs.chmod(file, 0o400);
    return { path: file, sha256: sha256(bytes) };
  };
  const ji = await fs.stat(jobs);
  const jobsPin = await write("jobs-seal.json", { version: 1, kind: "herder-legacy-jobs-retained",
    epoch: f.config.epoch, directory: jobs, directory_identity: { device: String(ji.dev), inode: String(ji.ino) }, records: [] });
  const ledger = await write("receipts.json", { version: 1, receipts: {} }); const ri = await fs.stat(ledger.path);
  const receiptPin = await write("receipts-seal.json", { version: 1, kind: "herder-resume-receipts-retained",
    epoch: f.config.epoch, path: ledger.path, sha256: ledger.sha256, sealed_at: new Date().toISOString(),
    file_identity: { device: String(ri.dev), inode: String(ri.ino) } });
  f.config.node_ref = "server-100";
  f.config.resume_receipts = { path: ledger.path, snapshot: receiptPin.path, sha256: receiptPin.sha256 };
  f.drain.sources.push(jobs, ledger.path); f.drain.writers[0]!.sources.push(jobs, ledger.path); await f.writeDrain();
  const waitPath = path.join(f.directory, id + ".json"); const waitHash = sha256(await fs.readFile(waitPath));
  const sources = [{ path: ledger.path, sha256: ledger.sha256 }, { path: waitPath, sha256: waitHash }].sort((a, b) => a.path.localeCompare(b.path));
  const inventory = sha256(sources.map(s => s.path + "\0" + s.sha256 + "\n").sort().join(""));
  const profile = { harness: "codex", node_ref: "server-100", instance_ref: "profile", authority_generation: "generation" };
  const snapshot: any = { version: 1, kind: "herder-legacy-quarantine", epoch: f.config.epoch,
    authority_generation: profile.authority_generation, node_ref: profile.node_ref, instance_ref: profile.instance_ref,
    writer_drain_sha256: f.config.writer_drain.sha256, inventory_sha256: inventory, sources,
    records: [{ record_ref: "resume-after:" + id, source_path: waitPath, source_sha256: waitHash,
      record_sha256: waitHash, request_keys: [id, "resume-after:" + id], outcome: "unknown",
      holds: [{ node_ref: "server-100", instance_ref: "profile", native_session_id: "old-native" }] }] };
  const pin = await write("quarantine.json", snapshot);
  f.config.quarantine = { inventory_sha256: inventory, legacy_jobs: { directory: jobs, snapshot: jobsPin.path, sha256: jobsPin.sha256 },
    snapshots: [{ ...profile, ...pin }] };
  await f.writeConfig();
  const state = { installed: true, stale: false, calls: [] as any[] };
  const proof = () => ({ version: 1, configured: state.installed, epoch: f.config.epoch, required_epoch: f.config.epoch,
    authority_generation: profile.authority_generation, node_ref: profile.node_ref, instance_ref: profile.instance_ref,
    snapshot_sha256: state.stale ? "b".repeat(64) : f.config.quarantine!.snapshots[0]!.sha256,
    inventory_sha256: inventory, writer_drain_sha256: f.config.writer_drain.sha256 });
  const client = async () => (await createCanonicalAutomationClient({ env: f.env, transportFactory: async () => ({
    call: async (_target, tool, args) => {
      state.calls.push({ tool, args });
      if (tool !== "automation" || (args as any).action !== "wait_status") throw new Error("unexpected mutation");
      return { version: 1, configured: true, complete: true, blocked: false, mapped: false,
        reason: "native_session_not_registered", sessionRefs: [], ruleRefs: [], observedAt: new Date().toISOString(),
        migration_authorities: [proof()] };
    },
  }) }))!;
  return { ...f, snapshot, state, client, async rewrite() {
    const pin = await write("quarantine.json", snapshot);
    f.config.quarantine!.snapshots[0] = { ...profile, ...pin }; await f.writeConfig();
  } };
}
describe("scoped migration quarantine readiness", () => {
  it("permits unrelated work only after native proof, preserving UNKNOWN and original bytes", async () => {
    const f = await fixture(); const before = await fs.readFile(path.join(f.directory, f.snapshot.records[0].request_keys[0] + ".json"));
    await expect(requireCanonicalMigrationReady(await f.client())).resolves.toBeUndefined();
    expect(f.snapshot.records[0].outcome).toBe("unknown");
    expect(f.state.calls).toHaveLength(1);
    expect(f.state.calls[0].args.native_session_id).toMatch(/^herder-migration-readiness:/);
    expect(await fs.readFile(path.join(f.directory, f.snapshot.records[0].request_keys[0] + ".json"))).toEqual(before);
  });
  it("does not infer native installation from local snapshots or an unregistered session", async () => {
    const f = await fixture(); f.state.installed = false;
    await expect(requireCanonicalMigrationReady(await f.client())).rejects.toThrow("native_unverified");
    f.state.installed = true; f.state.stale = true;
    await expect(requireCanonicalMigrationReady(await f.client())).rejects.toThrow("native_unverified");
  });
  it("requires exact aliases and target holds for every unknown original", async () => {
    const f = await fixture(); f.snapshot.records[0].request_keys.pop(); await f.rewrite();
    await expect(requireCanonicalMigrationReady(await f.client())).rejects.toThrow("coverage_missing");
    f.snapshot.records[0].request_keys.push("resume-after:" + f.snapshot.records[0].request_keys[0]);
    f.snapshot.records[0].holds[0].native_session_id = "different"; await f.rewrite();
    await expect(requireCanonicalMigrationReady(await f.client())).rejects.toThrow("target_scope_missing");
    expect(f.state.calls).toHaveLength(0);
  });
  it("does not discard an unknown record by relabeling it as accepted", async () => {
    const f = await fixture(); f.snapshot.records[0].outcome = "accepted"; f.snapshot.records[0].holds = []; await f.rewrite();
    await expect(requireCanonicalMigrationReady(await f.client())).rejects.toThrow("coverage_missing");
  });
});
