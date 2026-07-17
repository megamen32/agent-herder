import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const execFileAsync = promisify(execFile);

export type LocalTranscriptHarness = "claude" | "codex";

export interface LocalTranscriptSearchOptions {
  harnesses: LocalTranscriptHarness[];
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  folder?: string;
  maxAge?: number;
  maxSessions: number;
  maxMatches: number;
}

export interface LocalTranscriptMatch {
  harness: LocalTranscriptHarness;
  sessionId: string;
  agentId?: string;
  cwd: string;
  filePath: string;
  lineNumber: number;
  snippet: string;
}

export interface LocalTranscriptSearchResult {
  scannedFiles: number;
  matchedFiles: number;
  matches: LocalTranscriptMatch[];
}

interface TranscriptRoot {
  harness: LocalTranscriptHarness;
  path: string;
}

interface TranscriptMetadata {
  sessionId: string;
  agentId?: string;
  cwd: string;
  modifiedAt: number;
}

interface RipgrepMatch {
  type?: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

/**
 * Search local Claude and Codex JSONL stores with rg and attach session/CWD metadata.
 */
export async function searchLocalTranscripts(
  options: LocalTranscriptSearchOptions
): Promise<LocalTranscriptSearchResult> {
  const roots = getTranscriptRoots(options.harnesses);
  const results = await Promise.all(roots.map((root) => searchRoot(root, options)));
  return results.reduce(
    (total, result) => ({
      scannedFiles: total.scannedFiles + result.scannedFiles,
      matchedFiles: total.matchedFiles + result.matchedFiles,
      matches: [...total.matches, ...result.matches].slice(0, options.maxMatches),
    }),
    { scannedFiles: 0, matchedFiles: 0, matches: [] } satisfies LocalTranscriptSearchResult
  );
}

function getTranscriptRoots(harnesses: LocalTranscriptHarness[]): TranscriptRoot[] {
  return harnesses.map((harness) => ({
    harness,
    path: harness === "claude"
      ? join(homedir(), ".claude", "projects")
      : join(process.env.CODEX_DATA_DIR || join(homedir(), ".codex"), "sessions"),
  }));
}

async function searchRoot(
  root: TranscriptRoot,
  options: LocalTranscriptSearchOptions
): Promise<LocalTranscriptSearchResult> {
  const [files, matches] = await Promise.all([
    listTranscriptFiles(root.path),
    runRipgrep(root.path, options),
  ]);
  const metadataCache = new Map<string, TranscriptMetadata | null>();
  const matchingFiles = new Set<string>();
  const result: LocalTranscriptMatch[] = [];

  for (const match of matches) {
    if (result.length >= options.maxMatches) break;
    const filePath = match.data?.path?.text;
    if (!filePath) continue;
    let metadata = metadataCache.get(filePath);
    if (metadata === undefined) {
      metadata = await readMetadata(filePath, root.harness);
      metadataCache.set(filePath, metadata);
    }
    if (!metadata || !matchesFolder(metadata.cwd, options.folder) || !matchesAge(metadata.modifiedAt, options.maxAge)) continue;
    if (matchingFiles.size >= options.maxSessions && !matchingFiles.has(filePath)) continue;
    matchingFiles.add(filePath);
    result.push({
      harness: root.harness,
      sessionId: metadata.sessionId,
      agentId: metadata.agentId,
      cwd: metadata.cwd,
      filePath,
      lineNumber: match.data?.line_number || 0,
      snippet: (match.data?.lines?.text || "").trim().slice(0, 300),
    });
  }

  return { scannedFiles: files.length, matchedFiles: matchingFiles.size, matches: result };
}

async function listTranscriptFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("rg", ["--files", "--glob", "*.jsonl", root], { maxBuffer: 4 * 1024 * 1024 });
    return stdout.split("\n").filter(Boolean);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("rg is required for local transcript search");
    return [];
  }
}

async function runRipgrep(root: string, options: LocalTranscriptSearchOptions): Promise<RipgrepMatch[]> {
  const args = ["--json", "--no-messages", "--glob", "*.jsonl", "--max-count", String(Math.min(options.maxMatches, 3))];
  if (!options.regex) args.push("--fixed-strings");
  if (!options.caseSensitive) args.push("--ignore-case");
  args.push("--", options.query, root);
  const candidateLimit = Math.max(options.maxMatches * 20, options.maxMatches);
  return new Promise<RipgrepMatch[]>((resolvePromise, reject) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "ignore"] });
    const matches: RipgrepMatch[] = [];
    let buffer = "";
    let stoppedAtLimit = false;
    let settled = false;
    const consume = (flush: boolean): void => {
      const lines = buffer.split("\n");
      buffer = flush ? "" : lines.pop() || "";
      for (const line of lines) {
        const parsed = parseRipgrepMatch(line);
        if (parsed.length === 0) continue;
        matches.push({
          type: "match",
          data: {
            path: parsed[0].data?.path,
            line_number: parsed[0].data?.line_number,
            lines: { text: (parsed[0].data?.lines?.text || "").slice(0, 600) },
          },
        });
        if (matches.length >= candidateLimit) {
          stoppedAtLimit = true;
          child.kill("SIGTERM");
          return;
        }
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      consume(false);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if ((err as NodeJS.ErrnoException).code === "ENOENT") reject(new Error("rg is required for local transcript search"));
      else reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      consume(true);
      if (stoppedAtLimit || code === 0 || code === 1) resolvePromise(matches);
      else reject(new Error(`rg exited with code ${code}`));
    });
  });
}

function parseRipgrepMatch(line: string): RipgrepMatch[] {
  try {
    const event = JSON.parse(line) as RipgrepMatch;
    return event.type === "match" ? [event] : [];
  } catch {
    return [];
  }
}

async function readMetadata(filePath: string, harness: LocalTranscriptHarness): Promise<TranscriptMetadata | null> {
  try {
    const [content, fileStat] = await Promise.all([
      readFile(filePath, "utf8"),
      stat(filePath),
    ]);
    const objects = content.split("\n").slice(0, 40).flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
    const cwd = findString(objects, new Set(["cwd"]));
    const sessionId = findString(objects, new Set(["sessionId", "session_id"])) || basename(filePath, ".jsonl").replace(/^rollout-[^-]+-\d{2}-\d{2}-\d{2}-/, "");
    if (!cwd || !sessionId) return null;
    const agentId = filePath.match(/\/subagents\/(agent-[^/]+)\.jsonl$/)?.[1];
    return { sessionId, agentId, cwd, modifiedAt: fileStat.mtimeMs };
  } catch {
    return null;
  }
}

function findString(values: unknown[], keys: Set<string>): string | undefined {
  for (const value of values) {
    const found = findStringInValue(value, keys, 0);
    if (found) return found;
  }
  return undefined;
}

function findStringInValue(value: unknown, keys: Set<string>, depth: number): string | undefined {
  if (depth > 4 || value === null || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key) && typeof child === "string") return child;
    const nested = findStringInValue(child, keys, depth + 1);
    if (nested) return nested;
  }
  return undefined;
}

function matchesFolder(candidate: string, folder?: string): boolean {
  if (!folder) return true;
  const root = resolve(folder.replace(/^~/, homedir()));
  const path = resolve(candidate);
  const relativePath = relative(root, path);
  return relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith("../"));
}

function matchesAge(modifiedAt: number, maxAge?: number): boolean {
  return maxAge === undefined || maxAge === 0 || modifiedAt >= Date.now() - maxAge * 1000;
}
