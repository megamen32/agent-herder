import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TranscriptArchive,
  buildTranscriptArchiveCard,
  type ArchivedTranscript,
} from "../src/transcript-archive.js";
import { handleGetTranscript } from "../src/mcp-tools/handlers.js";
import type { HarnessAdapter } from "../src/types/index.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-herder-archive-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function transcript(id: string, cwd: string, body: string): ArchivedTranscript {
  return {
    harness: "opencode",
    sessionId: id,
    cwd,
    raw: {
      bytes: Buffer.from(body),
      complete: true,
      source: { kind: "native-file", location: `/source/${id}.jsonl`, format: "jsonl" },
      timestampCoverage: "native",
    },
  };
}

describe("TranscriptArchive", () => {
  it("exports the target and in-workspace lineage, records CWD exclusions, and atomically overwrites a session", async () => {
    const root = await workspace();
    const foreign = await workspace();
    const archive = new TranscriptArchive({ workspaceRoot: root });
    const result = await archive.exportLineage({
      target: transcript("lead", root, "first canonical export"),
      related: [
        transcript("child", join(root, "worker"), "child transcript"),
        transcript("outside", foreign, "must stay outside this archive"),
      ],
    });

    expect(result.targetPath).toMatch(/\.agent-herder\/transcripts\/opencode\/lead\.jsonl$/);
    expect(await readFile(result.targetPath, "utf8")).toContain("first canonical export");
    expect(await readFile(join(root, ".agent-herder", "transcripts", "opencode", "child.jsonl"), "utf8")).toContain("child transcript");
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    expect(manifest.target).toMatchObject({ complete: true, source: { kind: "native-file", format: "jsonl" }, timestampCoverage: "native" });
    expect(manifest.excluded).toEqual([{ harness: "opencode", sessionId: "outside", reason: "outside_workspace" }]);

    await archive.exportLineage({ target: transcript("lead", root, "replacement export"), related: [] });
    const overwritten = await readFile(result.targetPath, "utf8");
    expect(overwritten).toContain("replacement export");
    expect(overwritten).not.toContain("first canonical export");
  });

  it("removes archives older than retention by modification time before evicting newer files for size", async () => {
    const root = await workspace();
    const archive = new TranscriptArchive({ workspaceRoot: root, retentionMs: 1_000, maxBytes: 1_000_000 });
    const old = await archive.exportLineage({ target: transcript("old", root, "old export"), related: [] });
    await utimes(old.targetPath, new Date(0), new Date(0));
    await utimes(old.manifestPath, new Date(0), new Date(0));
    const fresh = await archive.exportLineage({ target: transcript("fresh", root, "fresh export"), related: [] });

    expect(fresh.cleanup.removed).toContain(old.targetPath);
    await expect(readFile(old.targetPath, "utf8")).rejects.toThrow();
    await expect(readFile(old.manifestPath, "utf8")).rejects.toThrow();
  });

  it("gives the agent a compact actionable card instead of an over-budget inline transcript", () => {
    const card = buildTranscriptArchiveCard({
      targetPath: "/workspace/.agent-herder/transcripts/opencode/lead.md",
      manifestPath: "/workspace/.agent-herder/transcripts/opencode/lead.manifest.json",
      estimatedTokens: 8_193,
      inlineTokenBudget: 8_192,
      sessionId: "lead",
    });

    expect(card).toContain("Inline context omitted");
    expect(card).toContain('query="keywords"');
    expect(card).toContain('regex="ERR(or)?"');
    expect(card).toContain('after="2026-07-30T10:00:00Z"');
  });

  it("rejects an archive directory that could escape the MCP process CWD", async () => {
    const root = await workspace();
    expect(() => new TranscriptArchive({ workspaceRoot: root, archiveDir: "/tmp/elsewhere" })).toThrow(
      "relative to the MCP process CWD",
    );
  });

  it("refuses symlinked archive segments and untrusted harness path components", async () => {
    const root = await workspace();
    const escaped = await workspace();
    await mkdir(join(root, ".agent-herder"));
    await symlink(escaped, join(root, ".agent-herder", "transcripts"));
    await expect(new TranscriptArchive({ workspaceRoot: root }).exportLineage({ target: transcript("lead", root, "raw"), related: [] }))
      .rejects.toThrow("symlink");

    const safeRoot = await workspace();
    const unsafe = transcript("lead", safeRoot, "raw");
    unsafe.harness = "../escape";
    await expect(new TranscriptArchive({ workspaceRoot: safeRoot }).exportLineage({ target: unsafe, related: [] }))
      .rejects.toThrow("Unsupported transcript archive harness");
  });

  it("archives raw target and in-workspace child on every get_transcript request", async () => {
    const root = await workspace();
    const lead = { id: "lead", harness: "opencode" as const, status: "idle" as const, title: "lead", cwd: root, lastActivity: new Date().toISOString() };
    const child = { ...lead, id: "child", cwd: join(root, "worker") };
    const grandchild = { ...lead, id: "grandchild", cwd: join(root, "worker", "nested") };
    const adapter = {
      type: "opencode",
      name: "test",
      getSession: async (id: string) => id === "lead" ? lead : id === "child" ? child : id === "grandchild" ? grandchild : null,
      listSessions: async () => [lead, child, grandchild],
      getTranscript: async () => "display transcript only",
      getRawTranscript: async (id: string) => ({
        bytes: Buffer.from(`{\"session\":\"${id}\"}\n`),
        complete: true,
        source: { kind: "native-file" as const, location: `/source/${id}.jsonl`, format: "jsonl" as const },
        timestampCoverage: "native" as const,
      }),
      getParent: async () => null,
      listChildren: async (id: string) => id === "lead" ? [child] : id === "child" ? [grandchild, lead] : [],
    } as unknown as HarnessAdapter;
    const archive = new TranscriptArchive({ workspaceRoot: root });

    const result = await handleGetTranscript(new Map([["opencode", adapter]]), { sessionId: "lead", harness: "opencode" }, archive);

    expect(result).toContain("Archive:");
    expect(await readFile(join(root, ".agent-herder", "transcripts", "opencode", "lead.jsonl"), "utf8")).toBe('{"session":"lead"}\n');
    expect(await readFile(join(root, ".agent-herder", "transcripts", "opencode", "child.jsonl"), "utf8")).toBe('{"session":"child"}\n');
    expect(await readFile(join(root, ".agent-herder", "transcripts", "opencode", "grandchild.jsonl"), "utf8")).toBe('{"session":"grandchild"}\n');
  });
});
