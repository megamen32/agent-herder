import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RawTranscriptExport } from "./types/index.js";
import { throwIfAborted } from "./abort-utils.js";

export type ArchivedTranscript = {
  harness: string;
  sessionId: string;
  cwd: string;
  raw: RawTranscriptExport;
};

export type TranscriptArchiveConfig = {
  /** The MCP process CWD. Archive roots are constrained beneath this path. */
  workspaceRoot?: string;
  /** Optional relative archive path inside workspaceRoot. */
  archiveDir?: string;
  maxBytes?: number;
  retentionMs?: number;
};

type ExportedEntry = {
  harness: string;
  sessionId: string;
  path: string;
  complete: boolean;
  source: RawTranscriptExport["source"];
  timestampCoverage: RawTranscriptExport["timestampCoverage"];
  limitations?: string[];
};

export type TranscriptArchiveResult = {
  targetPath: string;
  manifestPath: string;
  exported: ExportedEntry[];
  excluded: Array<{ harness: string; sessionId: string; reason: "outside_workspace" | "raw_unavailable" | "lineage_limit" | "foreign_harness" }>;
  cleanup: { removed: string[] };
};

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !path.includes(`..${process.platform === "win32" ? "\\" : "/"}`));
}

async function isRealPathInside(root: string, candidate: string): Promise<boolean> {
  try {
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    return inside(realRoot, realCandidate);
  } catch {
    return false;
  }
}

function fileStem(sessionId: string): string {
  const clean = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (clean === sessionId) return clean;
  return `${clean}-${createHash("sha256").update(sessionId).digest("hex").slice(0, 10)}`;
}

function harnessDirectory(harness: string): string {
  if (["opencode", "claude", "codex", "qoder", "hermes", "zcode", "fast-agent"].includes(harness)) return harness;
  throw new Error(`Unsupported transcript archive harness: ${harness}`);
}

async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  if (!inside(root, directory)) throw new Error("Transcript archive directory escaped the MCP process CWD.");
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("MCP process CWD must be a real directory for transcript archival.");
  let current = root;
  for (const segment of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Transcript archive path contains a non-directory or symlink: ${current}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Transcript archive path is unsafe: ${current}`);
    }
  }
}

async function atomicWrite(path: string, content: Uint8Array | string): Promise<void> {
  await ensureSafeDirectory(dirname(path), dirname(path));
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function extension(raw: RawTranscriptExport): string {
  switch (raw.source.format) {
    case "jsonl": return "jsonl";
    case "json": return "json";
    case "text": return "txt";
    default: return "bin";
  }
}

/**
 * A CWD-constrained archive. It never writes transcript material outside the
 * MCP process workspace, even when another harness reports a foreign CWD.
 */
export class TranscriptArchive {
  readonly workspaceRoot: string;
  readonly archiveRoot: string;
  readonly maxBytes: number;
  readonly retentionMs: number;

  constructor(config: TranscriptArchiveConfig = {}) {
    this.workspaceRoot = resolve(config.workspaceRoot ?? process.cwd());
    if (config.archiveDir && isAbsolute(config.archiveDir)) {
      throw new Error("Transcript archive directory must be relative to the MCP process CWD.");
    }
    this.archiveRoot = resolve(this.workspaceRoot, config.archiveDir ?? ".agent-herder/transcripts");
    if (!inside(this.workspaceRoot, this.archiveRoot)) {
      throw new Error("Transcript archive directory must remain inside the MCP process CWD.");
    }
    this.maxBytes = config.maxBytes ?? 100 * 1024 * 1024;
    this.retentionMs = config.retentionMs ?? 3 * 24 * 60 * 60 * 1000;
  }

  async exportLineage(input: {
    target: ArchivedTranscript;
    related: ArchivedTranscript[];
    excluded?: TranscriptArchiveResult["excluded"];
  }, signal?: AbortSignal): Promise<TranscriptArchiveResult> {
    throwIfAborted(signal);
    const snapshots = [input.target, ...input.related];
    const exported: ExportedEntry[] = [];
    const excluded: TranscriptArchiveResult["excluded"] = [...(input.excluded ?? [])];

    await ensureSafeDirectory(this.workspaceRoot, this.archiveRoot);
    throwIfAborted(signal);
    for (const snapshot of snapshots) {
      throwIfAborted(signal);
      if (!await isRealPathInside(this.workspaceRoot, snapshot.cwd)) {
        excluded.push({ harness: snapshot.harness, sessionId: snapshot.sessionId, reason: "outside_workspace" });
        continue;
      }
      const directory = join(this.archiveRoot, harnessDirectory(snapshot.harness));
      await ensureSafeDirectory(this.workspaceRoot, directory);
      const path = join(directory, `${fileStem(snapshot.sessionId)}.${extension(snapshot.raw)}`);
      await atomicWrite(path, snapshot.raw.bytes);
      throwIfAborted(signal);
      exported.push({
        harness: snapshot.harness,
        sessionId: snapshot.sessionId,
        path,
        complete: snapshot.raw.complete,
        source: snapshot.raw.source,
        timestampCoverage: snapshot.raw.timestampCoverage,
        limitations: snapshot.raw.limitations,
      });
    }

    const target = exported.find((entry) => entry.harness === input.target.harness && entry.sessionId === input.target.sessionId);
    if (!target) throw new Error("The requested transcript is outside the MCP process CWD and cannot be archived.");
    const manifestPath = join(this.archiveRoot, input.target.harness, `${fileStem(input.target.sessionId)}.manifest.json`);
    throwIfAborted(signal);
    await atomicWrite(manifestPath, `${JSON.stringify({
      format: "agent-herder-transcript-manifest-v1",
      workspaceRoot: this.workspaceRoot,
      target,
      exported,
      excluded,
      modifiedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    throwIfAborted(signal);
    const cleanup = await this.cleanup(Date.now(), new Set([...exported.map((entry) => entry.path), manifestPath]), signal);
    return { targetPath: target.path, manifestPath, exported, excluded, cleanup };
  }

  async cleanup(now = Date.now(), protectedPaths = new Set<string>(), signal?: AbortSignal): Promise<{ removed: string[] }> {
    throwIfAborted(signal);
    const files = await this.files();
    const removed: string[] = [];
    const bundles = new Map<string, Array<{ path: string; size: number; mtimeMs: number }>>();
    for (const file of files) {
      const key = file.path.endsWith(".manifest.json")
        ? file.path.slice(0, -".manifest.json".length)
        : file.path.slice(0, file.path.lastIndexOf("."));
      bundles.set(key, [...(bundles.get(key) ?? []), file]);
    }
    const grouped = [...bundles.values()].map((bundle) => ({
      bundle,
      size: bundle.reduce((sum, file) => sum + file.size, 0),
      mtimeMs: Math.max(...bundle.map((file) => file.mtimeMs)),
      protected: bundle.some((file) => protectedPaths.has(file.path)),
    }));
    const removeBundle = async (group: typeof grouped[number]): Promise<void> => {
      for (const file of group.bundle) {
        try {
          await unlink(file.path);
          removed.push(file.path);
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    };
    for (const group of grouped.filter((group) => !group.protected && now - group.mtimeMs > this.retentionMs)) {
      throwIfAborted(signal);
      await removeBundle(group);
    }
    const retained = grouped.filter((group) => group.protected || now - group.mtimeMs <= this.retentionMs);
    let total = retained.reduce((sum, group) => sum + group.size, 0);
    for (const group of retained.filter((group) => !group.protected).sort((left, right) => left.mtimeMs - right.mtimeMs)) {
      throwIfAborted(signal);
      if (total <= this.maxBytes) break;
      await removeBundle(group);
      total -= group.size;
    }
    return { removed };
  }

  private async files(directory = this.archiveRoot): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const nested = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return this.files(path);
        if (!entry.isFile()) return [];
        const info = await stat(path);
        return [{ path, size: info.size, mtimeMs: info.mtimeMs }];
      }));
      return nested.flat();
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read archive settings at use time so a server always honours its launch CWD. */
export function transcriptArchiveFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  workspaceRoot = process.cwd(),
): TranscriptArchive {
  return new TranscriptArchive({
    workspaceRoot,
    archiveDir: environment.AGENT_HERDER_TRANSCRIPT_ARCHIVE_DIR || undefined,
    maxBytes: positiveInteger(environment.AGENT_HERDER_TRANSCRIPT_ARCHIVE_MAX_BYTES, 100 * 1024 * 1024),
    retentionMs: positiveInteger(environment.AGENT_HERDER_TRANSCRIPT_ARCHIVE_RETENTION_DAYS, 3) * 24 * 60 * 60 * 1000,
  });
}

export function buildTranscriptArchiveCard(input: {
  targetPath: string;
  manifestPath: string;
  sessionId: string;
  complete: boolean;
}): string {
  return [
    `Transcript exported: ${input.targetPath}`,
    `Lineage manifest: ${input.manifestPath}`,
    `Completeness: ${input.complete ? "complete native source" : "partial source; inspect manifest limitations"}.`,
    "Use ordinary workspace tools against the exported file:",
    `  sed -n '1,20p' -- ${JSON.stringify(input.targetPath)}`,
    `  tail -n 20 -- ${JSON.stringify(input.targetPath)}`,
    `  rg -n --fixed-strings 'words to find' -- ${JSON.stringify(input.targetPath)}`,
    `  rg -n -e 'ERR(or)?' -- ${JSON.stringify(input.targetPath)}`,
    `  rg -n '2026-07-30T10:' -- ${JSON.stringify(input.targetPath)}`,
    `Session ID: ${input.sessionId}`,
  ].join("\n");
}
