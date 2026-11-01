import { describe, it, expect } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
