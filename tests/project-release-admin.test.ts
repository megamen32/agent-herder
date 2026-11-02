import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat, realpath, symlink, rename, open } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ProjectReleaseLeaseStore } from "../src/project-release-lease.js";
import { runReleaseAdmin } from "../src/project-release-admin.js";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

describe("offline release authority route", () => {
  it("rejects symlink and lexical ledger aliases without touching authority state", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "release-admin-alias-")));
    const ledger = join(base, "ledger.json"), alias = join(base, "alias.json");
    const initial = JSON.stringify({ version: 1, projects: {} });
    try {
      await writeFile(ledger, initial, { mode: 0o600 });
      await symlink(ledger, alias);
      for (const path of [alias, base + "/./ledger.json"]) {
        await expect(runReleaseAdmin({ ledger: path, authorityHost: hostname(),
          request: { action: "status", cwd: base } }))
          .rejects.toThrow("release_admin_canonical_ledger_required");
      }
      expect(await readFile(ledger, "utf8")).toBe(initial);
      await expect(stat(alias + ".lock")).rejects.toThrow();
      await expect(stat(ledger + ".lock")).rejects.toThrow();
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it("rolls back the acquired project on proof-write failure even after cwd disappears", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "release-admin-rollback-")));
    const repo = join(base, "repo"), ledger = join(base, "ledger.json");
    const proofOut = join(base, "proof.json");
    const owner = { hostId: hostname(), harness: "test", nativeSessionId: "rollback" };
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    try {
      execFileSync("git", ["init", "-q", repo]);
      const project = await realpath(join(repo, ".git"));
      await writeFile(ledger, JSON.stringify({ version: 1, projects: {} }), { mode: 0o600 });
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const handle = await actual.open(...args);
        vi.spyOn(handle, "writeFile").mockImplementationOnce(async () => {
          await rename(repo, join(base, "moved-repo"));
          throw new Error("injected_proof_write_failure");
        });
        return handle;
      });
      await expect(runReleaseAdmin({ ledger, authorityHost: hostname(), proofOut,
        request: { action: "acquire", cwd: repo, owner } }))
        .rejects.toThrow("injected_proof_write_failure");
      const state = JSON.parse(await readFile(ledger, "utf8"));
      expect(state.projects[project].lease).toBeUndefined();
      await expect(stat(proofOut)).rejects.toThrow();
    } finally {
      vi.mocked(open).mockReset();
      vi.mocked(open).mockImplementation(actual.open);
      await rm(base, { recursive: true, force: true });
    }
  });

  it("requireExisting store never initializes missing authority state", async () => {
    const base = await mkdtemp(join(tmpdir(), "release-admin-missing-"));
    const ledger = join(base, "ledger.json");
    try {
      const store = new ProjectReleaseLeaseStore(ledger, Date.now, true);
      await expect(store.status("/fixture/project")).rejects.toThrow();
      await expect(stat(ledger)).rejects.toThrow();
    } finally { await rm(base, { recursive: true, force: true }); }
  });
  it("requires existing authority, preserves common key, rejects competition and keeps capability in protected file", async () => {
    const base = await mkdtemp(join(tmpdir(), "release-admin-"));
    try {
      const repo = join(base, "repo"), linked = join(base, "linked");
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
      execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "linked", linked]);
      const ledger = join(base, "ledger.json"), proofOut = join(base, "proof.json");
      const owner = { hostId: hostname(), harness: "test", nativeSessionId: "one" };
      const options = { ledger, authorityHost: hostname(), request: { action: "status", cwd: repo } };
      await expect(runReleaseAdmin(options)).rejects.toThrow();
      await expect(stat(ledger)).rejects.toThrow();
      await writeFile(ledger, JSON.stringify({ version: 1, projects: {} }), { mode: 0o600 });
      await expect(runReleaseAdmin({ ...options, authorityHost: "wrong-host" })).rejects.toThrow("authority_mismatch");
      const acquired = await runReleaseAdmin({ ...options, proofOut, request: { action: "acquire", cwd: repo, owner } });
      const proof = JSON.parse(await readFile(proofOut, "utf8"));
      expect(proof.token).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(acquired)).not.toContain(proof.token);
      expect((await stat(proofOut)).mode & 0o777).toBe(0o600);
      const status = await runReleaseAdmin({ ...options, request: { action: "status", cwd: linked } });
      expect(status.project).toBe(proof.project);
      await expect(runReleaseAdmin({ ...options, proofOut: join(base, "other.json"), request: { action: "acquire", cwd: linked, owner: { ...owner, nativeSessionId: "two" } } })).rejects.toThrow();
      await expect(stat(join(base, "other.json"))).rejects.toThrow();
      await runReleaseAdmin({ ...options, request: { action: "release", cwd: repo, owner, token: proof.token, fence: proof.fence } });
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
