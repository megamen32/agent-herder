import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGoalEvidence } from "./goal-evidence.js";

const roots: string[] = [];
async function fixture(): Promise<{ root: string; cwd: string; outside: string }> {
  const root = await mkdtemp(join(tmpdir(), "herder-goal-evidence-")); roots.push(root);
  const cwd = join(root, "project"); await mkdir(cwd);
  const outside = join(root, "outside.md"); await writeFile(outside, "outside secret");
  return { root, cwd, outside };
}
const identity = (cwd: string) => ({ harness: "codex", sessionId: "evidence-test", cwd });
const requirements = [{ id: "r1", text: "Verify result", sourceEventIds: ["human-1"] }];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("collectGoalEvidence", () => {
  it("reads only explicit stable in-project text and reports hash provenance", async () => {
    const { cwd } = await fixture();
    await writeFile(join(cwd, "result.md"), "complete result text\n");
    const result = await collectGoalEvidence({ identity: identity(cwd), requirements, targetRefs: [{ requirementId: "r1", path: "result.md" }] });
    expect(result.unavailable).toEqual([]);
    expect(result.materials).toHaveLength(1);
    expect(result.materials[0]).toMatchObject({ path: join(cwd, "result.md"), text: "complete result text\n", complete: true, version: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    expect(result.evidence[0]).toMatchObject({ requirementId: "r1", provenance: join(cwd, "result.md"), materialLoaded: true, freshUntil: expect.any(String) });
    expect(result.evidence[0]?.text).toBeUndefined();
  });

  it("refuses outside symlinks and credential-like paths without marking them loaded", async () => {
    const { cwd, outside } = await fixture();
    await symlink(outside, join(cwd, "linked.md"));
    await writeFile(join(cwd, ".env.local"), "API_TOKEN=x");
    await writeFile(join(cwd, "session-token.txt"), "token");
    const result = await collectGoalEvidence({ identity: identity(cwd), requirements, targetRefs: [
      { requirementId: "r1", path: "linked.md" },
      { requirementId: "r1", path: ".env.local" },
      { requirementId: "r1", path: "session-token.txt" },
    ] });
    expect(result.materials).toEqual([]);
    expect(result.evidence).toHaveLength(3);
    expect(result.evidence.every((item) => !item.materialLoaded && item.version === "unavailable" && !item.text)).toBe(true);
    expect(result.unavailable).toHaveLength(3);
  });

  it("does not load oversized files and enforces raw-reference bounds", async () => {
    const { cwd } = await fixture();
    await writeFile(join(cwd, "large.md"), "123456789");
    const result = await collectGoalEvidence({ identity: identity(cwd), requirements, targetRefs: [{ requirementId: "r1", path: "large.md" }], limits: { maxFileBytes: 4 } });
    expect(result.evidence[0]).toMatchObject({ materialLoaded: false, version: "unavailable" });
    await expect(collectGoalEvidence({ identity: identity(cwd), requirements, targetRefs: [
      { requirementId: "r1", path: "large.md" }, { requirementId: "r1", path: "large.md" },
    ], limits: { maxFiles: 1 } })).rejects.toThrow("target reference count exceeds");
  });

  it("reads and returns materials per unique physical path while preserving per-requirement evidence IDs", async () => {
    const { cwd } = await fixture();
    const paths = ["one.md", "two.md"];
    await writeFile(join(cwd, paths[0]!), "material one\n");
    await writeFile(join(cwd, paths[1]!), "material two\n");
    const manyRequirements = Array.from({ length: 20 }, (_, i) => ({ id: `r${i + 1}`, text: `Requirement ${i + 1}`, sourceEventIds: ["human-1"] }));
    const targetRefs = manyRequirements.flatMap((requirement) => paths.map((path) => ({ requirementId: requirement.id, path })));
    const result = await collectGoalEvidence({ identity: identity(cwd), requirements: manyRequirements, targetRefs, limits: { maxFiles: 2 } });
    expect(result.unavailable).toEqual([]);
    expect(result.materials).toHaveLength(2);
    expect(new Set(result.materials.map((item) => item.path))).toEqual(new Set(paths.map((path) => join(cwd, path))));
    expect(result.materials.map((item) => item.text).sort()).toEqual(["material one\n", "material two\n"]);
    expect(result.evidence).toHaveLength(40);
    expect(new Set(result.evidence.map((item) => item.id)).size).toBe(40);
    for (const path of paths) {
      const versions = new Set(result.evidence.filter((item) => item.provenance === join(cwd, path)).map((item) => item.version));
      expect(versions.size).toBe(1);
      expect(versions.values().next().value).toMatch(/^sha256:[a-f0-9]{64}$/);
    }
  });

  it("refuses more unique physical files than the configured limit", async () => {
    const { cwd } = await fixture();
    for (const path of ["one.md", "two.md", "three.md"]) await writeFile(join(cwd, path), path);
    const twoRequirements = ["r1", "r2"].map((id) => ({ id, text: id, sourceEventIds: ["human-1"] }));
    const result = await collectGoalEvidence({ identity: identity(cwd), requirements: twoRequirements, targetRefs: [
      { requirementId: "r1", path: "one.md" }, { requirementId: "r1", path: "two.md" }, { requirementId: "r2", path: "three.md" },
    ], limits: { maxFiles: 2 } });
    expect(result.materials).toHaveLength(2);
    expect(result.evidence).toHaveLength(3);
    expect(result.evidence.at(-1)).toMatchObject({ materialLoaded: false, version: "unavailable" });
    expect(result.unavailable).toHaveLength(1);
  });
});
