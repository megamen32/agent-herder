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
    expect(result.evidence[0]).toMatchObject({ requirementId: "r1", provenance: join(cwd, "result.md"), materialLoaded: true, text: "complete result text\n", freshUntil: expect.any(String) });
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

  it("does not load oversized files and enforces target-count bounds", async () => {
    const { cwd } = await fixture();
    await writeFile(join(cwd, "large.md"), "123456789");
    const result = await collectGoalEvidence({ identity: identity(cwd), requirements, targetRefs: [{ requirementId: "r1", path: "large.md" }], limits: { maxFileBytes: 4 } });
    expect(result.evidence[0]).toMatchObject({ materialLoaded: false, version: "unavailable" });
    await expect(collectGoalEvidence({ identity: identity(cwd), requirements, targetRefs: [
      { requirementId: "r1", path: "large.md" }, { requirementId: "r1", path: "large.md" },
    ], limits: { maxFiles: 1 } })).rejects.toThrow("target count exceeds");
  });
});
