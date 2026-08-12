import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export type ChatGptHistoryView = "unread" | "working" | "recent";

/** A chat discoverable in the currently visible ChatGPT sidebar. */
export interface ChatGptHistoryChat {
  /** Driver-private stable identifier; never returned by the MCP surface. */
  id: string;
  title: string;
  unread: boolean;
  working: boolean;
  /** The visible-sidebar order is represented as an ISO timestamp when no real timestamp is exposed. */
  updatedAt: string;
  /** Stable ChatGPT conversation route when the browser adapter can observe it. */
  sourceRoute?: string;
}

/** One raw, local-only history capture from the owned ChatGPT page. */
export interface ChatGptHistorySegment {
  capturedAt: string;
  page: { url: string };
  /** Deliberately source-shaped data, normally the BrowserClaw a11y snapshot. */
  content: unknown;
}

/** Read-only browser seam for a single owned ChatGPT page. */
export interface ChatGptHistoryArchiveDriver {
  listChats(): Promise<readonly ChatGptHistoryChat[]>;
  openChat(input: { chatId: string }): Promise<ChatGptHistorySegment>;
  scrollBack(): Promise<{ segment: ChatGptHistorySegment; atStart: boolean }>;
}

export interface ChatGptHistoryArchiveOptions {
  archiveRoot?: string;
  /** Preserve the known secretary conversation unless a later task explicitly changes its scope. */
  protectedTitles?: readonly string[];
  maxSegmentBytes?: number;
  now?: () => Date;
}

export interface ListChatHistoryInput {
  view: ChatGptHistoryView;
  limit?: number;
}

export interface PublicChatGptHistoryChat {
  chatRef: string;
  title: string;
  unread: boolean;
  working: boolean;
  updatedAt: string;
}

export interface ListChatHistoryResult {
  view: ChatGptHistoryView;
  semantics: string;
  chats: PublicChatGptHistoryChat[];
}

export interface ExportChatHistoryInput {
  chatRef: string;
  /** Number of newly observed snapshots to persist in this one MCP call. */
  maxSegments?: number;
}

export interface ExportChatHistoryResult {
  chatRef: string;
  archiveId: string;
  archivePath: string;
  manifestPath: string;
  status: "checkpoint" | "complete";
  capturedSegments: number;
  newSegments: number;
  nextStep: "call_cdp_export_chat_again" | "archive_ready";
  /** Best-effort local article renderings generated from the raw snapshots. */
  article?: {
    markdownPath: string;
    htmlPath: string;
  };
}

interface ChatBinding {
  id: string;
  title: string;
  sourceRoute?: string;
}

interface HistorySegmentManifest {
  file: string;
  sha256: string;
  capturedAt: string;
}

interface HistoryManifest {
  format: "agent-herder-chatgpt-history.v1";
  archiveId: string;
  chatRef: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  complete: boolean;
  resume: "same_owned_page" | "reopen_from_bottom";
  segments: HistorySegmentManifest[];
}

interface InMemoryCursor {
  chatRef: string;
  chatId: string;
  archiveId: string;
}

const DEFAULT_ARCHIVE_ROOT = join(homedir(), "archives", "chatgpt-history");
const DEFAULT_MAX_SEGMENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_PROTECTED_TITLES = ["E-Frontier"];
const MANIFEST_FORMAT = "agent-herder-chatgpt-history.v1" as const;
const CHATGPT_ORIGIN = "https://chatgpt.com";

/** A compact, non-transcript error for the history-export MCP surface. */
export class ChatGptHistoryArchiveError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ChatGptHistoryArchiveError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !path.startsWith(`..${sep}`));
}

function normalTitle(value: string): string {
  return value.trim().replace(/[‐‑‒–—−]/gu, "-").replace(/\s+/gu, " ").toLocaleLowerCase();
}

function conversationRoute(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, CHATGPT_ORIGIN);
    return url.origin === CHATGPT_ORIGIN && /^\/c\/[^/]+/u.test(url.pathname) ? url.pathname : undefined;
  } catch {
    return undefined;
  }
}

function routeFromSegment(segment: ChatGptHistorySegment): string | undefined {
  return conversationRoute(segment.page?.url);
}

function opaqueRef(chatId: string): string {
  return `cdp-history:v1:${sha256(chatId).slice(0, 32)}`;
}

function archiveId(chatId: string): string {
  return `chat-${sha256(chatId).slice(0, 24)}`;
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new ChatGptHistoryArchiveError("invalid_limit", `limit must be an integer from 1 to ${maximum}`);
  }
  return limit;
}

function jsonBytes(value: unknown): Buffer {
  try {
    return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8");
  } catch {
    throw new ChatGptHistoryArchiveError("invalid_segment", "history snapshot is not JSON serializable");
  }
}

async function ensureRoot(input: string): Promise<string> {
  const root = resolve(input);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new ChatGptHistoryArchiveError("unsafe_archive_root", "history archive root must be a real directory");
  }
  await chmod(root, 0o700);
  return root;
}

async function writePrivate(path: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function isHistoryManifest(value: unknown): value is HistoryManifest {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<HistoryManifest>;
  return item.format === MANIFEST_FORMAT
    && typeof item.archiveId === "string"
    && typeof item.chatRef === "string"
    && typeof item.title === "string"
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string"
    && typeof item.complete === "boolean"
    && (item.resume === "same_owned_page" || item.resume === "reopen_from_bottom")
    && Array.isArray(item.segments);
}

/**
 * Persists raw ChatGPT history snapshots without returning their contents over
 * MCP. A running archive keeps the browser at its last checkpoint, so the next
 * call continues upward instead of reopening the conversation.
 */
export class ChatGptHistoryArchive {
  private readonly root: string;
  private readonly maxSegmentBytes: number;
  private readonly protectedTitles: ReadonlySet<string>;
  private readonly now: () => Date;
  private readonly bindings = new Map<string, ChatBinding>();
  /** Only one page can be at a scroll checkpoint at a time. */
  private cursor: InMemoryCursor | undefined;
  private readonly inFlight = new Set<string>();

  constructor(private readonly driver: ChatGptHistoryArchiveDriver, options: ChatGptHistoryArchiveOptions = {}) {
    this.root = resolve(options.archiveRoot ?? DEFAULT_ARCHIVE_ROOT);
    this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
    this.protectedTitles = new Set((options.protectedTitles ?? DEFAULT_PROTECTED_TITLES).map(normalTitle));
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.maxSegmentBytes) || this.maxSegmentBytes < 1024) {
      throw new ChatGptHistoryArchiveError("invalid_options", "maxSegmentBytes must be at least 1024");
    }
  }

  /** Return only currently visible sidebar metadata; no chat transcript is returned. */
  async listChats(input: ListChatHistoryInput): Promise<ListChatHistoryResult> {
    const limit = boundedLimit(input.limit, 50, 100);
    const chats = [...await this.driver.listChats()];
    const selected = input.view === "unread"
      ? chats.filter((chat) => chat.unread)
      : input.view === "working"
        ? chats.filter((chat) => chat.working)
        : chats;
    const publicChats = selected.slice(0, limit).map((chat) => {
      const chatRef = opaqueRef(chat.id);
      this.bindings.set(chatRef, { id: chat.id, title: chat.title, ...(chat.sourceRoute ? { sourceRoute: chat.sourceRoute } : {}) });
      return { chatRef, title: chat.title, unread: chat.unread, working: chat.working, updatedAt: chat.updatedAt };
    });
    return {
      view: input.view,
      semantics: input.view === "recent"
        ? "currently visible ChatGPT sidebar order; ChatGPT does not expose a timestamp for every row"
        : "currently visible ChatGPT sidebar state",
      chats: publicChats,
    };
  }

  /** Save a bounded run of raw snapshots and return a resumable local receipt. */
  async exportChat(input: ExportChatHistoryInput): Promise<ExportChatHistoryResult> {
    const maxSegments = boundedLimit(input.maxSegments, 24, 100);
    const binding = this.bindings.get(input.chatRef);
    if (!binding) throw new ChatGptHistoryArchiveError("chat_not_listed", "list chats in this MCP session before exporting one");
    if (this.protectedTitles.has(normalTitle(binding.title))) {
      throw new ChatGptHistoryArchiveError("protected_chat", "E-Frontier is excluded from the history-export canary");
    }
    if (this.inFlight.has(input.chatRef)) {
      throw new ChatGptHistoryArchiveError("export_in_progress", "this chat already has an export operation in progress");
    }
    this.inFlight.add(input.chatRef);
    try {
      return await this.exportBoundChat(input.chatRef, binding, maxSegments);
    } finally {
      this.inFlight.delete(input.chatRef);
    }
  }

  /** Export every currently visible non-protected chat, one bounded page at a time. */
  async exportVisibleChats(input: ExportVisibleChatHistoryInput = {}): Promise<ExportVisibleChatHistoryResult> {
    const maxChats = boundedLimit(input.maxChats, 20, 100);
    const maxSegmentsPerChat = boundedLimit(input.maxSegmentsPerChat, 24, 100);
    const listed = await this.listChats({ view: "recent", limit: maxChats });
    const results: Array<{ chatRef: string; status: "checkpoint" | "complete" | "skipped"; archivePath?: string; article?: { markdownPath: string; htmlPath: string }; error?: string }> = [];
    const seen = new Set<string>();
    for (const chat of listed.chats) {
      if (seen.has(chat.chatRef)) {
        results.push({ chatRef: chat.chatRef, status: "skipped", error: "duplicate_sidebar_row" });
        continue;
      }
      seen.add(chat.chatRef);
      if (this.protectedTitles.has(normalTitle(chat.title))) {
        results.push({ chatRef: chat.chatRef, status: "skipped", error: "protected_chat" });
        continue;
      }
      try {
        const exported = await this.exportChat({ chatRef: chat.chatRef, maxSegments: maxSegmentsPerChat });
        results.push({ chatRef: chat.chatRef, status: exported.status, archivePath: exported.archivePath, ...(exported.article ? { article: exported.article } : {}) });
      } catch (error) {
        results.push({ chatRef: chat.chatRef, status: "skipped", error: error instanceof Error ? error.message.slice(0, 240) : "export_failed" });
      }
    }
    return { requestedChats: listed.chats.length, results };
  }

  /**
   * Materialize the current route-stable archive from snapshots already saved
   * locally. This intentionally does not open, scroll, or alter a ChatGPT page.
   */
  async reconcileVisibleChats(input: ReconcileVisibleChatHistoryInput = {}): Promise<ReconcileVisibleChatHistoryResult> {
    const maxChats = boundedLimit(input.maxChats, 100, 100);
    const listed = await this.listChats({ view: "recent", limit: maxChats });
    const root = await ensureRoot(this.root);
    const sourceSegments = await this.indexRouteSegments(root);
    const results: ReconcileVisibleChatHistoryResult["results"] = [];
    const seen = new Set<string>();
    let reconciledChats = 0;
    let unavailableChats = 0;

    for (const chat of listed.chats) {
      if (seen.has(chat.chatRef)) {
        results.push({ chatRef: chat.chatRef, status: "skipped" });
        continue;
      }
      seen.add(chat.chatRef);
      const binding = this.bindings.get(chat.chatRef);
      if (!binding || this.protectedTitles.has(normalTitle(binding.title))) {
        results.push({ chatRef: chat.chatRef, status: "skipped" });
        continue;
      }
      const route = conversationRoute(binding.sourceRoute);
      const segments = route ? sourceSegments.get(route) : undefined;
      if (!segments || segments.length === 0) {
        unavailableChats += 1;
        results.push({ chatRef: chat.chatRef, status: "unavailable" });
        continue;
      }

      const id = archiveId(binding.id);
      const archivePath = join(root, id);
      if (!inside(root, archivePath)) throw new ChatGptHistoryArchiveError("unsafe_archive_path", "history archive path escaped its root");
      const manifestPath = join(archivePath, "manifest.json");
      const manifest = await this.readManifest(manifestPath, id, chat.chatRef, binding.title);
      await mkdir(join(archivePath, "segments"), { recursive: true, mode: 0o700 });
      let newSegments = 0;
      for (const segment of segments) {
        if (await this.appendSegment(archivePath, manifest, segment)) newSegments += 1;
      }
      manifest.resume = "reopen_from_bottom";
      manifest.updatedAt = this.now().toISOString();
      await writePrivate(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      const article = await this.writeArticleViews(archivePath, binding.title, manifest);
      reconciledChats += 1;
      results.push({ chatRef: chat.chatRef, status: "reconciled", newSegments, archivePath, article });
    }
    return { requestedChats: listed.chats.length, reconciledChats, unavailableChats, results };
  }

  private async exportBoundChat(chatRef: string, binding: ChatBinding, maxSegments: number): Promise<ExportChatHistoryResult> {
    const root = await ensureRoot(this.root);
    const id = archiveId(binding.id);
    const archivePath = join(root, id);
    if (!inside(root, archivePath)) throw new ChatGptHistoryArchiveError("unsafe_archive_path", "history archive path escaped its root");
    const manifestPath = join(archivePath, "manifest.json");
    let manifest = await this.readManifest(manifestPath, id, chatRef, binding.title);
    if (manifest.complete) {
      const article = await this.writeArticleViews(archivePath, binding.title, manifest);
      return this.receipt(chatRef, manifest, archivePath, manifestPath, "complete", 0, article);
    }

    const cursor = this.cursor;
    let segment: ChatGptHistorySegment | undefined;
    if (!cursor || cursor.chatRef !== chatRef || cursor.chatId !== binding.id || cursor.archiveId !== id) {
      segment = await this.driver.openChat({ chatId: binding.id });
      manifest.resume = "reopen_from_bottom";
    } else {
      manifest.resume = "same_owned_page";
    }
    // Do not leave an empty per-chat archive behind if the fresh semantic click
    // proves this sidebar row is not a conversation.
    await mkdir(join(archivePath, "segments"), { recursive: true, mode: 0o700 });

    let newSegments = 0;
    let scannedSegments = 0;
    let atStart = false;
    while (true) {
      if (segment) {
        const appended = await this.appendSegment(archivePath, manifest, segment);
        if (appended) newSegments += 1;
        scannedSegments += 1;
        manifest.updatedAt = this.now().toISOString();
        await writePrivate(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      if (atStart) {
          manifest.complete = true;
          manifest.resume = "same_owned_page";
          manifest.updatedAt = this.now().toISOString();
          await writePrivate(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
          if (this.cursor?.chatRef === chatRef) this.cursor = undefined;
          const article = await this.writeArticleViews(archivePath, binding.title, manifest);
          return this.receipt(chatRef, manifest, archivePath, manifestPath, "complete", newSegments, article);
        }
        // `maxSegments` is a bound on newly persisted source views. After a
        // restart the driver reopens at the bottom, so it must scan already
        // stored snapshots to reach older unseen history.
        if (newSegments >= maxSegments || scannedSegments >= 500) {
          this.cursor = { chatRef, chatId: binding.id, archiveId: id };
          const article = await this.writeArticleViews(archivePath, binding.title, manifest);
          return this.receipt(chatRef, manifest, archivePath, manifestPath, "checkpoint", newSegments, article);
        }
      }

      const next = await this.driver.scrollBack();
      segment = next.segment;
      atStart = next.atStart;
    }
  }

  private async readManifest(manifestPath: string, id: string, chatRef: string, title: string): Promise<HistoryManifest> {
    try {
      const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!isHistoryManifest(parsed) || parsed.archiveId !== id || parsed.chatRef !== chatRef) {
        throw new ChatGptHistoryArchiveError("invalid_manifest", "existing history manifest does not match this chat export");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const now = this.now().toISOString();
      return {
        format: MANIFEST_FORMAT,
        archiveId: id,
        chatRef,
        title,
        createdAt: now,
        updatedAt: now,
        complete: false,
        resume: "reopen_from_bottom",
        segments: [],
      };
    }
  }

  private async appendSegment(archivePath: string, manifest: HistoryManifest, segment: ChatGptHistorySegment): Promise<boolean> {
    const payload = jsonBytes(segment);
    if (payload.byteLength > this.maxSegmentBytes) {
      throw new ChatGptHistoryArchiveError("segment_too_large", "one raw history segment exceeds the configured archive bound");
    }
    // `capturedAt` intentionally changes every run. Deduplicate the source view,
    // not the receipt timestamp, so a service restart can continue the same archive.
    const digest = sha256(JSON.stringify({ page: segment.page, content: segment.content }));
    if (manifest.segments.some((entry) => entry.sha256 === digest)) return false;
    const file = `${String(manifest.segments.length + 1).padStart(6, "0")}.json`;
    await writePrivate(join(archivePath, "segments", file), payload);
    manifest.segments.push({ file, sha256: digest, capturedAt: segment.capturedAt });
    return true;
  }

  private async indexRouteSegments(root: string): Promise<Map<string, ChatGptHistorySegment[]>> {
    const byRoute = new Map<string, ChatGptHistorySegment[]>();
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const segmentDir = join(root, entry.name, "segments");
      let files: string[];
      try {
        files = await readdir(segmentDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
          const segment = JSON.parse(await readFile(join(segmentDir, file), "utf8")) as ChatGptHistorySegment;
          const route = routeFromSegment(segment);
          if (!route) continue;
          const matching = byRoute.get(route) ?? [];
          matching.push(segment);
          byRoute.set(route, matching);
        } catch {
          // Preserve other raw source snapshots if a legacy segment is unreadable.
        }
      }
    }
    return byRoute;
  }

  private async writeArticleViews(
    archivePath: string,
    title: string,
    manifest: HistoryManifest,
  ): Promise<{ markdownPath: string; htmlPath: string }> {
    const rendered: unknown[] = [];
    for (const entry of manifest.segments) {
      try {
        const segment = JSON.parse(await readFile(join(archivePath, "segments", entry.file), "utf8")) as ChatGptHistorySegment;
        rendered.push(segment.content);
      } catch {
        // Preserve the raw archive even if one optional rendering input cannot
        // be read. The remaining source snapshots still form a useful article.
      }
    }
    const articleDir = join(archivePath, "article");
    const markdownPath = join(articleDir, "article.md");
    const htmlPath = join(articleDir, "article.html");
    const state = manifest.complete ? "complete" : "partial checkpoint";
    const markdown = `# ${title}\n\n_Source: best-effort ${state} rendering of ${manifest.segments.length} raw ChatGPT history snapshots._\n\n${rendered.map(renderMarkdownValue).join("\n\n---\n\n")}\n`;
    const html = `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:72rem;margin:2rem auto;padding:0 1rem;line-height:1.5}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f6f6;padding:1rem;border-radius:.5rem}</style></head><body><h1>${escapeHtml(title)}</h1><p>Source: best-effort ${state} rendering of ${manifest.segments.length} raw ChatGPT history snapshots.</p>${rendered.map((value) => `<pre>${escapeHtml(renderMarkdownValue(value))}</pre>`).join("\n")}</body></html>\n`;
    await writePrivate(markdownPath, markdown);
    await writePrivate(htmlPath, html);
    return { markdownPath, htmlPath };
  }

  private receipt(
    chatRef: string,
    manifest: HistoryManifest,
    archivePath: string,
    manifestPath: string,
    status: "checkpoint" | "complete",
    newSegments: number,
    article?: { markdownPath: string; htmlPath: string },
  ): ExportChatHistoryResult {
    return {
      chatRef,
      archiveId: manifest.archiveId,
      archivePath,
      manifestPath,
      status,
      capturedSegments: manifest.segments.length,
      newSegments,
      nextStep: status === "complete" ? "archive_ready" : "call_cdp_export_chat_again",
      ...(article ? { article } : {}),
    };
  }
}

export interface ExportVisibleChatHistoryInput {
  /** Upper bound for currently visible sidebar chats in this one call. */
  maxChats?: number;
  /** Upper bound for raw history snapshots per chat in this one call. */
  maxSegmentsPerChat?: number;
}

export interface ExportVisibleChatHistoryResult {
  requestedChats: number;
  results: Array<{
    chatRef: string;
    status: "checkpoint" | "complete" | "skipped";
    archivePath?: string;
    article?: { markdownPath: string; htmlPath: string };
    error?: string;
  }>;
}

export interface ReconcileVisibleChatHistoryInput {
  /** Upper bound for visible chats whose existing raw snapshots are materialized. */
  maxChats?: number;
}

export interface ReconcileVisibleChatHistoryResult {
  requestedChats: number;
  reconciledChats: number;
  unavailableChats: number;
  results: Array<{
    chatRef: string;
    status: "reconciled" | "unavailable" | "skipped";
    newSegments?: number;
    archivePath?: string;
    article?: { markdownPath: string; htmlPath: string };
  }>;
}

function renderMarkdownValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unrenderable source snapshot]";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
