import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { abortError, throwIfAborted } from "./abort-utils.js";

const DEFAULT_MAX_ARCHIVE_BYTES = 10 * 1024 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 100_000;
const MANIFEST_FORMAT = "agent-herder-chatgpt-account-export.v1";

export type ChatGptAccountExportDelivery = "email_or_sms";

/** Minimal browser seam for the one consequential ChatGPT account-export click path. */
export interface ChatGptAccountExportDriver {
  requestAccountExport(signal?: AbortSignal): Promise<{
    requestedAt: string;
    delivery: ChatGptAccountExportDelivery;
    status: "requested" | "already_requested";
  }>;
}

export interface ChatGptAccountArchiveOptions {
  /** Persistent local destination for the native ZIP and its bounded manifest. */
  archiveRoot?: string;
  maxArchiveBytes?: number;
  maxEntries?: number;
  unzipBin?: string;
  now?: () => Date;
}

export interface RequestAccountExportInput {
  confirmation: string;
}

export interface RequestAccountExportResult {
  requestedAt: string;
  delivery: ChatGptAccountExportDelivery;
  status: "requested" | "already_requested";
  nextStep: "download_zip_then_import_account_export";
}

export interface ImportAccountExportInput {
  /** Absolute path to the ZIP downloaded from the account's export email/SMS link. */
  sourcePath: string;
}

export interface AccountExportEntryCounts {
  total: number;
  conversationSources: number;
  researchCandidates: number;
  fileCandidates: number;
  other: number;
}

export interface ImportedAccountExport {
  archiveId: string;
  archivePath: string;
  manifestPath: string;
  bytes: number;
  sha256: string;
  entries: AccountExportEntryCounts;
}

export interface AccountExportSummary extends ImportedAccountExport {
  importedAt: string;
}

interface AccountExportManifest extends AccountExportSummary {
  format: typeof MANIFEST_FORMAT;
  sourceName: string;
  entryNames: string[];
}

/** Error code suitable for a compact MCP response without exposing archive contents. */
export class ChatGptAccountArchiveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ChatGptAccountArchiveError";
  }
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.startsWith(`..${sep}`));
}

async function ensureRoot(rootInput: string): Promise<string> {
  await mkdir(rootInput, { recursive: true, mode: 0o700 });
  const metadata = await lstat(rootInput);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ChatGptAccountArchiveError("unsafe_archive_root", "archiveRoot must be a real directory");
  }
  return realpath(rootInput);
}

async function ensureChildDirectory(root: string, child: string): Promise<string> {
  const target = resolve(root, child);
  if (!inside(root, target)) throw new ChatGptAccountArchiveError("unsafe_archive_path", "archive child escaped archiveRoot");
  await mkdir(target, { recursive: true, mode: 0o700 });
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ChatGptAccountArchiveError("unsafe_archive_path", "archive child must be a real directory");
  }
  const actual = await realpath(target);
  if (!inside(root, actual)) throw new ChatGptAccountArchiveError("unsafe_archive_path", "archive child resolved outside archiveRoot");
  return actual;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function copyAbortable(sourcePath: string, targetPath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const source = createReadStream(sourcePath);
  const target = createWriteStream(targetPath, { mode: 0o600 });
  if (signal) await pipeline(source, target, { signal });
  else await pipeline(source, target);
  throwIfAborted(signal);
}

async function sha256(path: string, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const source = createReadStream(path);
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); source.destroy(); rejectHash(error); };
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    source.on("data", (chunk: string | Buffer) => { hash.update(chunk); });
    source.on("error", fail);
    source.on("end", () => { if (settled) return; settled = true; cleanup(); resolveHash(hash.digest("hex")); });
  });
}

function safeZipEntry(entry: string): string {
  if (!entry || entry.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(entry)) {
    throw new ChatGptAccountArchiveError("invalid_zip_entry", "account export contains an invalid ZIP entry name");
  }
  if (entry.includes("\\") || entry.startsWith("/") || /^[A-Za-z]:/u.test(entry)) {
    throw new ChatGptAccountArchiveError("invalid_zip_entry", "account export contains an unsafe ZIP entry path");
  }
  const segments = entry.split("/");
  if (segments.some((segment, index) => segment === ".." || segment === "." || (segment === "" && index !== segments.length - 1))) {
    throw new ChatGptAccountArchiveError("invalid_zip_entry", "account export contains a non-canonical ZIP entry path");
  }
  return entry;
}

async function listZipEntries(unzipBin: string, archivePath: string, maxEntries: number, signal?: AbortSignal): Promise<string[]> {
  throwIfAborted(signal);
  const maxOutputBytes = Math.max(1_024 * 1_024, maxEntries * 256);
  return new Promise((resolveEntries, rejectEntries) => {
    const child = spawn(unzipBin, ["-Z", "-1", archivePath], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      child.kill();
      rejectEntries(error);
    };
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > maxOutputBytes) {
        fail(new ChatGptAccountArchiveError("zip_listing_too_large", "account export ZIP has too many or too-long entries"));
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", () => fail(new ChatGptAccountArchiveError("zip_tool_unavailable", "unzip is required to inspect the downloaded ChatGPT export")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new ChatGptAccountArchiveError("invalid_export_zip", `could not inspect the ChatGPT export ZIP${stderr ? ": " + stderr.slice(0, 160) : ""}`));
        return;
      }
      const entries = stdout.split(/\r?\n/u).filter(Boolean).map(safeZipEntry);
      if (entries.length > maxEntries) {
        fail(new ChatGptAccountArchiveError("zip_entry_limit", `account export ZIP exceeds the ${maxEntries} entry limit`));
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolveEntries(entries);
    });
  });
}

function entryCounts(entryNames: readonly string[]): AccountExportEntryCounts {
  const counts: AccountExportEntryCounts = { total: entryNames.length, conversationSources: 0, researchCandidates: 0, fileCandidates: 0, other: 0 };
  for (const entry of entryNames) {
    if (entry.endsWith("/")) {
      counts.other += 1;
      continue;
    }
    const lower = entry.toLocaleLowerCase();
    if (/(^|\/)(conversations?(?:[_-]?\d+)?\.json|chat\.html)$/u.test(lower)) {
      counts.conversationSources += 1;
    } else if (/(deep[_ -]?research|research[_ -]?(report|output|result))/u.test(lower)) {
      counts.researchCandidates += 1;
    } else if (/(^|\/)(assets?|files?|uploads?)(\/|$)|\.(?:pdf|md|markdown|txt|docx?|xlsx?|csv|pptx?|png|jpe?g|webp|gif|svg|zip|mp3|mp4|mov|wav)$/u.test(lower)) {
      counts.fileCandidates += 1;
    } else {
      counts.other += 1;
    }
  }
  return counts;
}

function isManifest(value: unknown): value is AccountExportManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<AccountExportManifest>;
  return manifest.format === MANIFEST_FORMAT
    && typeof manifest.archiveId === "string"
    && typeof manifest.archivePath === "string"
    && typeof manifest.manifestPath === "string"
    && typeof manifest.bytes === "number"
    && typeof manifest.sha256 === "string"
    && typeof manifest.importedAt === "string"
    && Array.isArray(manifest.entryNames)
    && Boolean(manifest.entries && typeof manifest.entries === "object");
}

/**
 * Keeps a native ChatGPT account export immutable and indexes only its names
 * and aggregate categories. This is intentionally an importer, not a lossy
 * HTML/Markdown conversion: the first archive must preserve the real source.
 */
export class ChatGptAccountArchive {
  readonly archiveRoot: string;
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  private readonly unzipBin: string;
  private readonly now: () => Date;
  private requestInFlight = false;

  constructor(
    private readonly exportDriver: ChatGptAccountExportDriver | undefined,
    options: ChatGptAccountArchiveOptions = {},
  ) {
    this.archiveRoot = resolve(options.archiveRoot ?? "chatgpt-account-archive");
    this.maxArchiveBytes = options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.unzipBin = options.unzipBin ?? "unzip";
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.maxArchiveBytes) || this.maxArchiveBytes < 1 || !Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new ChatGptAccountArchiveError("invalid_archive_options", "archive bounds must be positive safe integers");
    }
  }

  /** Request the official asynchronous ChatGPT account export. */
  async requestAccountExport(input: RequestAccountExportInput, signal?: AbortSignal): Promise<RequestAccountExportResult> {
    throwIfAborted(signal);
    if (input.confirmation !== "REQUEST_ACCOUNT_EXPORT") {
      throw new ChatGptAccountArchiveError("confirmation_required", "request_account_export requires confirmation REQUEST_ACCOUNT_EXPORT");
    }
    if (!this.exportDriver) {
      throw new ChatGptAccountArchiveError("export_driver_unavailable", "this MCP process has no authenticated ChatGPT account-export browser driver");
    }
    if (this.requestInFlight) {
      throw new ChatGptAccountArchiveError("export_request_in_progress", "another account-export request is in progress in this MCP session");
    }
    this.requestInFlight = true;
    try {
      const result = await this.exportDriver.requestAccountExport(signal);
      throwIfAborted(signal);
      return { ...result, nextStep: "download_zip_then_import_account_export" };
    } finally {
      this.requestInFlight = false;
    }
  }

  /** Copy the downloaded native ZIP and write an inspectable manifest without extracting untrusted paths. */
  async importAccountExport(input: ImportAccountExportInput, signal?: AbortSignal): Promise<ImportedAccountExport> {
    throwIfAborted(signal);
    if (!input.sourcePath || !input.sourcePath.trim()) {
      throw new ChatGptAccountArchiveError("invalid_source_path", "sourcePath is required");
    }
    const sourcePath = resolve(input.sourcePath);
    throwIfAborted(signal);
    const source = await lstat(sourcePath).catch(() => {
      throw new ChatGptAccountArchiveError("source_not_found", "downloaded ChatGPT export ZIP was not found");
    });
    if (!source.isFile() || source.isSymbolicLink()) {
      throw new ChatGptAccountArchiveError("invalid_source_path", "sourcePath must be a real ZIP file");
    }
    if (source.size < 1 || source.size > this.maxArchiveBytes) {
      throw new ChatGptAccountArchiveError("archive_size_limit", `account export ZIP must be between 1 byte and ${this.maxArchiveBytes} bytes`);
    }
    if (!/\.zip$/iu.test(basename(sourcePath))) {
      throw new ChatGptAccountArchiveError("invalid_source_path", "sourcePath must name a .zip account export");
    }

    const root = await ensureRoot(this.archiveRoot);
    const rawDirectory = await ensureChildDirectory(root, "raw");
    const manifestDirectory = await ensureChildDirectory(root, "manifests");
    const digest = await sha256(sourcePath, signal);
    throwIfAborted(signal);
    const sourceAfterHash = await stat(sourcePath);
    if (sourceAfterHash.size !== source.size) {
      throw new ChatGptAccountArchiveError("source_changed", "downloaded account export changed while being imported");
    }
    const importedAt = this.now().toISOString();
    const archiveId = `${importedAt.replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
    const archivePath = join(rawDirectory, `chatgpt-account-${archiveId}-${digest.slice(0, 12)}.zip`);
    const temporary = `${archivePath}.${process.pid}.${randomUUID()}.tmp`;
    let entryNames: string[];
    try {
      await copyAbortable(sourcePath, temporary, signal);
      await chmod(temporary, 0o600);
      const copied = await stat(temporary);
      if (copied.size !== source.size || await sha256(temporary, signal) !== digest) {
        throw new ChatGptAccountArchiveError("copy_failed", "copied account export ZIP does not match the source");
      }
      entryNames = await listZipEntries(this.unzipBin, temporary, this.maxEntries, signal);
      throwIfAborted(signal);
      await rename(temporary, archivePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    const manifestPath = join(manifestDirectory, `${archiveId}.manifest.json`);
    const result: ImportedAccountExport = {
      archiveId,
      archivePath,
      manifestPath,
      bytes: source.size,
      sha256: digest,
      entries: entryCounts(entryNames),
    };
    const manifest: AccountExportManifest = {
      format: MANIFEST_FORMAT,
      sourceName: basename(sourcePath),
      importedAt,
      entryNames,
      ...result,
    };
    throwIfAborted(signal);
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return result;
  }

  /** List archive bundles without reading or returning the account's chat text. */
  async listAccountExports(limit = 50): Promise<AccountExportSummary[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new ChatGptAccountArchiveError("invalid_limit", "limit must be an integer from 1 to 100");
    }
    const root = await ensureRoot(this.archiveRoot);
    const manifestDirectory = await ensureChildDirectory(root, "manifests");
    const entries = await readdir(manifestDirectory, { withFileTypes: true });
    const summaries: AccountExportSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".manifest.json")) continue;
      try {
        const path = join(manifestDirectory, entry.name);
        const text = await readFile(path, "utf8");
        const parsed = JSON.parse(text) as unknown;
        if (!isManifest(parsed)) continue;
        summaries.push({
          archiveId: parsed.archiveId,
          archivePath: parsed.archivePath,
          manifestPath: parsed.manifestPath,
          bytes: parsed.bytes,
          sha256: parsed.sha256,
          entries: parsed.entries,
          importedAt: parsed.importedAt,
        });
      } catch {
        // A partial or foreign manifest must not make other account exports invisible.
      }
    }
    return summaries.sort((left, right) => right.importedAt.localeCompare(left.importedAt)).slice(0, limit);
  }
}
