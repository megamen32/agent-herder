import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TranscriptArchive,
  buildTranscriptArchiveCard,
  type ArchivedTranscript,
} from "../src/transcript-archive.js";
import { toolDefinitions } from "../src/mcp-tools/definitions.js";
import { handleExportTranscript } from "../src/mcp-tools/handlers.js";
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
  it("exports the requested adapter transcript even when the session cwd differs from the archive cwd", async () => {
    const root = await workspace();
    const outside = await workspace();
    const session = { id:"target", harness:"codex" as const, status:"idle" as const, title:"target", cwd:outside, lastActivity:new Date().toISOString() };
    const adapter = { type:"codex", name:"Codex", getSession:async () => session,
      getRawTranscript:async () => ({ bytes:Buffer.from('{"type":"session_meta"}\n'), complete:true,
        source:{kind:"native-api",location:"fixture",format:"jsonl"}, timestampCoverage:"native" }) } as unknown as HarnessAdapter;
    const result = await handleExportTranscript(new Map([["codex",adapter]]), {sessionId:"target",harness:"codex"}, new TranscriptArchive({workspaceRoot:root}));
    expect(result).toContain("Transcript exported:");
    expect(await readFile(join(root,'.agent-herder/transcripts/codex/target.jsonl'),'utf8')).toContain('session_meta');
  });
  it("pages the tail of native messages and reports the retained full transcript", async () => {
    const root=await workspace();
    const session={id:"tail",harness:"codex" as const,status:"idle" as const,title:"tail",cwd:root,lastActivity:new Date().toISOString()};
    const adapter={type:"codex",name:"Codex",getSession:async()=>session,
      getSessionMessages:async()=>[1,2,3,4,5].map(i=>({id:String(i),role:"user",text:`message ${i}`})),
      getRawTranscript:async()=>({bytes:Buffer.from("one\ntwo\nthree\n"),complete:true,source:{kind:"native-api",location:"fixture",format:"jsonl"},timestampCoverage:"native"})} as unknown as HarnessAdapter;
    const result=JSON.parse(await handleExportTranscript(new Map([["codex",adapter]]),{sessionId:"tail",format:"messages",tail:4,offset:1,limit:2},new TranscriptArchive({workspaceRoot:root})));
    expect(result.records.map((m:{id:string})=>m.id)).toEqual(["3","4"]);
    expect(result.truncated).toBe(true); expect(result.fullPath).toContain("tail.jsonl");
    const raw=JSON.parse(await handleExportTranscript(new Map([["codex",adapter]]),{sessionId:"tail",format:"raw",tail:2,limit:1,maxBytes:1024},new TranscriptArchive({workspaceRoot:root})));
    expect(raw.records).toEqual(["two"]); expect(raw.truncated).toBe(true);
  });
  it("bounds the returned page while preserving the full export", async () => {
    const root=await workspace(); const session={id:"large",harness:"codex" as const,status:"idle" as const,title:"large",cwd:root,lastActivity:new Date().toISOString()};
    const body="x".repeat(5000); const adapter={type:"codex",name:"Codex",getSession:async()=>session,
      getRawTranscript:async()=>({bytes:Buffer.from(body),complete:true,source:{kind:"native-api",location:"fixture",format:"text"},timestampCoverage:"native"})} as unknown as HarnessAdapter;
    const result=JSON.parse(await handleExportTranscript(new Map([["codex",adapter]]),{sessionId:"large",format:"raw",maxBytes:1024},new TranscriptArchive({workspaceRoot:root})));
    expect(result.truncated).toBe(true); expect(result.records).toEqual([]); expect((await readFile(result.fullPath,"utf8")).length).toBe(5000);
  });
  it("exports the target and in-workspace lineage, records CWD exclusions, and atomically overwrites a session", async () => {
    const root = await workspace();
    const foreign = await workspace();
    await mkdir(join(root, "worker"));
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

  it("archives ZCode native API transcripts under the ZCode namespace", async () => {
    const root = await workspace();
    const zcodeTranscript = transcript("zcode-session", root, "zcode raw");
    zcodeTranscript.harness = "zcode";
    const result = await new TranscriptArchive({ workspaceRoot: root }).exportLineage({ target: zcodeTranscript, related: [] });

    expect(result.targetPath).toMatch(/\.agent-herder\/transcripts\/zcode\/zcode-session\.jsonl$/);
    expect(await readFile(result.targetPath, "utf8")).toBe("zcode raw");
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

  it("gives the agent a compact actionable card for every export", () => {
    const card = buildTranscriptArchiveCard({
      targetPath: "/workspace/.agent-herder/transcripts/opencode/lead.md",
      manifestPath: "/workspace/.agent-herder/transcripts/opencode/lead.manifest.json",
      sessionId: "lead",
      complete: true,
    });

    expect(card).toContain("complete native source");
    expect(card).toContain("rg -n --fixed-strings");
    expect(card).toContain("ERR(or)?");
    expect(card).toContain("2026-07-30T10:");
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

  it("exposes export_transcript as the only transcript-facing static tool", () => {
    const names = toolDefinitions.map((tool) => tool.name);
    expect(names).toContain("export_transcript");
    expect(names.filter((name) => /transcript|summarize/.test(name))).toEqual(["export_transcript"]);
  });

  it("exports raw target and in-workspace lineage with a permanent navigation card", async () => {
    const root = await workspace();
    await mkdir(join(root, "worker", "nested"), { recursive: true });
    const lead = { id: "lead", harness: "opencode" as const, status: "idle" as const, title: "lead", cwd: root, lastActivity: new Date().toISOString() };
    const child = { ...lead, id: "child", cwd: join(root, "worker") };
    const grandchild = { ...lead, id: "grandchild", cwd: join(root, "worker", "nested") };
    const adapter = {
      type: "opencode",
      name: "test",
      getSession: async (id: string) => id === "lead" ? lead : id === "child" ? child : id === "grandchild" ? grandchild : null,
      listSessions: async () => [lead, child, grandchild],
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

    const result = await handleExportTranscript(new Map([["opencode", adapter]]), { sessionId: "lead", harness: "opencode" }, archive);

    expect(result).toContain("Transcript exported:");
    expect(result).toContain("sed -n '1,20p'");
    expect(result).toContain("tail -n 20");
    expect(result).toContain("rg -n --fixed-strings");
    expect(await readFile(join(root, ".agent-herder", "transcripts", "opencode", "lead.jsonl"), "utf8")).toBe('{"session":"lead"}\n');
    expect(await readFile(join(root, ".agent-herder", "transcripts", "opencode", "child.jsonl"), "utf8")).toBe('{"session":"child"}\n');
    expect(await readFile(join(root, ".agent-herder", "transcripts", "opencode", "grandchild.jsonl"), "utf8")).toBe('{"session":"grandchild"}\n');
  });

  it("propagates cancellation into a raw transcript read", async () => {
    const root = await workspace();
    const lead = { id: "lead", harness: "opencode" as const, status: "idle" as const, title: "lead", cwd: root, lastActivity: new Date().toISOString() };
    let sawAbort = false;
    let started!: () => void;
    const startedGate = new Promise<void>((resolve) => { started = resolve; });
    const adapter = {
      type: "opencode", name: "cancel-fixture",
      getSession: async () => lead, listSessions: async () => [lead],
      getRawTranscript: async (_id: string, signal?: AbortSignal) => new Promise((_, reject) => {
        started();
        if (signal?.aborted) { const error = new Error("cancelled"); error.name = "AbortError"; reject(error); return; }
        signal?.addEventListener("abort", () => { sawAbort = true; const error = new Error("cancelled"); error.name = "AbortError"; reject(error); }, { once: true });
      }),
    } as unknown as HarnessAdapter;
    const controller = new AbortController();
    const pending = handleExportTranscript(new Map([["opencode", adapter]]), { sessionId: "lead", harness: "opencode" }, new TranscriptArchive({ workspaceRoot: root }), controller.signal);
    await startedGate;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(sawAbort).toBe(true);
  });

  it("excludes foreign-harness and symlinked-CWD relations before reading raw bytes", async () => {
    const root = await workspace();
    const outside = await workspace();
    const linked = join(root, "linked-outside");
    await symlink(outside, linked);
    const lead = { id: "lead", harness: "opencode" as const, status: "idle" as const, title: "lead", cwd: root, lastActivity: new Date().toISOString() };
    const wrongHarness = { ...lead, id: "wrong-harness", harness: "codex" as const };
    const symlinked = { ...lead, id: "symlinked", cwd: linked };
    const rawReads: string[] = [];
    const adapter = {
      type: "opencode",
      name: "test",
      getSession: async () => lead,
      listSessions: async () => [lead],
      getRawTranscript: async (id: string) => {
        rawReads.push(id);
        return { bytes: Buffer.from(`{"session":"${id}"}\n`), complete: true, source: { kind: "native-file" as const, location: `/source/${id}.jsonl`, format: "jsonl" as const }, timestampCoverage: "native" as const };
      },
      listChildren: async (id: string) => id === "lead" ? [wrongHarness, symlinked] : [],
    } as unknown as HarnessAdapter;

    const result = await handleExportTranscript(new Map([["opencode", adapter]]), { sessionId: "lead", harness: "opencode" }, new TranscriptArchive({ workspaceRoot: root }));
    const manifestPath = result.split("\n").find((line) => line.startsWith("Lineage manifest: "))!.slice("Lineage manifest: ".length);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    expect(rawReads).toEqual(["lead"]);
    expect(manifest.excluded).toEqual(expect.arrayContaining([
      { harness: "codex", sessionId: "wrong-harness", reason: "foreign_harness" },
      { harness: "opencode", sessionId: "symlinked", reason: "outside_workspace" },
    ]));
  });
});
