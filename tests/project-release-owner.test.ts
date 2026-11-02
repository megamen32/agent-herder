import { describe, it, expect } from "vitest";
import { chmod, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { getuid } from "node:process";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { releaseProject } from "../src/mcp/project-release-tools.js";

describe("releaseProject git identity", () => {
  it("resolves the same common Git directory from main checkout and linked worktree", async () => {
    const base = await mkdtemp(join(tmpdir(), "herder-release-owner-"));
    const repo = join(base, "repo");
    const linked = join(base, "linked");
    try {
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "initial"]);
      execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "review", linked]);
      const common = await realpath(join(repo, ".git"));
      expect(await releaseProject(repo)).toBe(common);
      expect(await releaseProject(linked)).toBe(common);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// This specifically proves root Herder does not need safe.directory to inspect
// a UID1000 repository. Run only in a disposable root-capable test environment.
describe.skipIf(getuid?.() !== 0)("root Herder Git probe", () => {
  it("uses repository owner for main, linked and symlink while plain root Git refuses", async () => {
    const base = await mkdtemp(join(tmpdir(), "herder-root-owner-"));
    const repo = join(base, "repo"), linked = join(base, "linked"), alias = join(base, "alias");
    await chmod(base, 0o755);
    const uid = Number(process.env.HERDER_OWNER_TEST_UID ?? "1000");
    if (!Number.isInteger(uid) || uid <= 0) throw new Error("invalid test uid");
    try {
      execFileSync("install", ["-d", "-o", String(uid), "-g", String(uid), repo, linked]);
      // Use the already-existing owner identity; no changes to production paths.
      const command = (argv: string[]) => execFileSync("git", argv, { uid, gid: uid });
      command(["init", "-q", repo]);
      command(["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"]);
      command(["-C", repo, "worktree", "add", "-q", "-b", "fixture-review", linked]);
      await symlink(repo, alias);
      const common = await realpath(join(repo, ".git"));
      expect(await releaseProject(repo)).toBe(common);
      expect(await releaseProject(linked)).toBe(common);
      expect(await releaseProject(alias)).toBe(common);
      expect(() => execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      })).toThrow(/dubious ownership/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
