import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { AgentSession } from "./types/index.js";
import { herderEvents, type HerderEventBus } from "./herder-events.js";
import { coordinationNoteResourceUri, coordinationWorkspaceResourceUri, presenceSessionResourceUri, presenceWorkspaceResourceUri } from "./herder-resource-uris.js";

export type CoordinationNoteKind = "working" | "avoid" | "handoff" | "info";

export interface CoordinationNote {
  id: string;
  kind: CoordinationNoteKind;
  message: string;
  cwd: string;
  paths: string[];
  authorHarness?: string;
  authorSessionId: string;
  source?: "manual" | "hook";
  activityKey?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

type NoteFile = { version: 1; notes: CoordinationNote[] };
export type CoordinationNoteCreate = Omit<CoordinationNote, "id" | "createdAt" | "updatedAt" | "expiresAt"> & { ttlSeconds?: number };
export interface CoordinationConflict {
  path: string;
  note: CoordinationNote;
}
export interface CoordinationReservationResult {
  reservations: CoordinationNote[];
  conflicts: CoordinationConflict[];
}
export type CoordinationNoteUpdate = Partial<Pick<CoordinationNote, "kind" | "message" | "paths">> & { ttlSeconds?: number };

const DEFAULT_TTL_SECONDS = 30 * 60;
const DEFAULT_AUTO_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

export function defaultCoordinationNotePath(): string {
  return process.env.AGENT_HERDER_COORDINATION_NOTES || resolve(homedir(), ".local", "state", "agent-herder", "coordination-notes.json");
}

export class CoordinationNoteStore {
  private chain: Promise<unknown> = Promise.resolve();
  /** Per receiving session+board: last injected roster signature + when.
   * All injection channels share these slots so the same information never
   * enters a session twice — only material changes re-inject. Keyed per
   * board because different boards carry different information. */
  private injectionState = new Map<string, { signature: string; at: number }>();
  /** sessionId -> board cwd -> last activity ms. Tracks every workspace a
   * session has actually touched, so turn-start awareness covers all of
   * them, not just the launch directory. */
  private presence = new Map<string, Map<string, number>>();
  constructor(private readonly filePath = defaultCoordinationNotePath(), private readonly events: HerderEventBus = herderEvents) {}

  private publishNote(note: CoordinationNote, action: "created" | "updated" | "deleted" | "changed"): void {
    this.events.publish({ kind: "coordination", uri: "herder://coordination", action, id: note.id });
    this.events.publish({ kind: "coordination", uri: coordinationNoteResourceUri(note.id), action, id: note.id });
    this.events.publish({ kind: "coordination", uri: coordinationWorkspaceResourceUri(note.cwd), action: "changed", id: note.id });
  }

  private publishPresence(sessionId: string, cwd?: string, action: "created" | "updated" | "deleted" | "changed" = "changed"): void {
    this.events.publish({ kind: "presence", uri: "herder://presence", action: "changed", id: sessionId });
    this.events.publish({ kind: "presence", uri: presenceSessionResourceUri(sessionId), action, id: sessionId });
    if (cwd) this.events.publish({ kind: "presence", uri: presenceWorkspaceResourceUri(cwd), action: "changed", id: sessionId });
  }

  private touchPresence(sessionId: string, board: string): void {
    const boards = this.presence.get(sessionId) ?? new Map<string, number>();
    boards.set(board, Date.now());
    this.presence.set(sessionId, boards);
  }

  /** Boards a session has touched recently, launch directory first. */
  private boardsForSession(sessionId: string, fallbackCwd: string): string[] {
    const now = Date.now();
    const boards = this.presence.get(sessionId);
    const recent: string[] = [];
    if (boards) {
      for (const [board, seen] of [...boards.entries()].sort((x, y) => y[1] - x[1])) {
        if (now - seen > 24 * 60 * 60 * 1000) { boards.delete(board); continue; }
        recent.push(board);
      }
    }
    const fallback = resolve(fallbackCwd);
    return [fallback, ...recent.filter((board) => board !== fallback)].slice(0, 10);
  }

  async create(input: CoordinationNoteCreate): Promise<CoordinationNote> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const now = new Date();
      const ttl = boundedTtl(input.ttlSeconds);
      const cwd = canonicalCwd(input.cwd);
      const note: CoordinationNote = {
        id: randomUUID(),
        kind: input.kind,
        message: boundedMessage(input.message),
        cwd,
        paths: normalizePathsForCwd(input.paths, cwd),
        ...(input.authorHarness ? { authorHarness: input.authorHarness } : {}),
        authorSessionId: requiredText(input.authorSessionId, "authorSessionId", 256),
        ...(input.source ? { source: input.source } : {}),
        ...(input.activityKey ? { activityKey: input.activityKey } : {}),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
      };
      file.notes.push(note);
      await this.write(file);
      this.publishNote(note, "created");
      this.publishPresence(note.authorSessionId, note.cwd);
      return note;
    });
  }

  async list(filters: { cwd?: string; path?: string; authorSessionId?: string; includeExpired?: boolean } = {}): Promise<CoordinationNote[]> {
    return this.serial(async () => {
      const file = filters.includeExpired ? await this.read() : await this.readAndPrune();
      const cwd = filters.cwd ? canonicalCwd(filters.cwd) : undefined;
      const path = filters.path?.trim();
      return file.notes
        .filter((note) => !filters.authorSessionId || note.authorSessionId === filters.authorSessionId)
        .filter((note) => !cwd || sameWorkspace(note.cwd, cwd))
        .filter((note) => !path || note.paths.length === 0 || note.paths.some((candidate) => pathMatches(candidate, path)))
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    });
  }

  async get(id: string): Promise<CoordinationNote | null> {
    const notes = await this.list();
    return notes.find((note) => note.id === id) ?? null;
  }

  async update(id: string, authorSessionId: string, patch: CoordinationNoteUpdate): Promise<CoordinationNote> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const note = file.notes.find((candidate) => candidate.id === id);
      if (!note) throw new Error(`Coordination note '${id}' not found or expired`);
      assertOwner(note, authorSessionId);
      if (patch.kind) note.kind = patch.kind;
      if (patch.message !== undefined) note.message = boundedMessage(patch.message);
      if (patch.paths !== undefined) note.paths = normalizePathsForCwd(patch.paths, note.cwd);
      if (patch.ttlSeconds !== undefined) note.expiresAt = new Date(Date.now() + boundedTtl(patch.ttlSeconds) * 1000).toISOString();
      note.updatedAt = new Date().toISOString();
      await this.write(file);
      this.publishNote(note, "updated");
      this.publishPresence(note.authorSessionId, note.cwd);
      return note;
    });
  }

  async delete(id: string, authorSessionId: string): Promise<boolean> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const index = file.notes.findIndex((candidate) => candidate.id === id);
      if (index < 0) return false;
      assertOwner(file.notes[index], authorSessionId);
      const [removed] = file.notes.splice(index, 1);
      await this.write(file);
      this.publishNote(removed, "deleted");
      this.publishPresence(removed.authorSessionId, removed.cwd);
      return true;
    });
  }

  async reservePaths(input: { harness: string; sessionId: string; cwd: string; paths: string[]; ttlSeconds?: number }): Promise<CoordinationReservationResult> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const cwd = canonicalCwd(input.cwd);
      this.touchPresence(input.sessionId, cwd);
      const paths = normalizePathsForCwd(input.paths, cwd);
      const ttl = boundedTtl(input.ttlSeconds ?? autoTtlSeconds());
      const now = new Date();
      const conflicts: CoordinationConflict[] = [];
      const reservations: CoordinationNote[] = [];
      for (const path of paths) {
        for (const note of file.notes) {
          if (note.authorSessionId === input.sessionId || !sameWorkspace(note.cwd, cwd)) continue;
          if (note.paths.some((candidate) => pathMatches(candidate, path))) conflicts.push({ path, note });
        }
        const activityKey = `hook:${input.sessionId}:${path}`;
        let note = file.notes.find((candidate) => candidate.activityKey === activityKey);
        if (!note) {
          note = {
            id: randomUUID(), kind: "working", message: `Auto-reserved after file activity: ${path}`, cwd, paths: [path],
            authorHarness: input.harness, authorSessionId: requiredText(input.sessionId, "sessionId", 256),
            source: "hook", activityKey, createdAt: now.toISOString(), updatedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
          };
          file.notes.push(note);
        } else {
          note.updatedAt = now.toISOString();
          note.expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
          note.authorHarness = input.harness;
        }
        reservations.push(note);
      }
      if (paths.length > 0) {
        await this.write(file);
        this.events.publish({ kind: "coordination", uri: "herder://coordination", action: "changed", id: input.sessionId });
        this.events.publish({ kind: "coordination", uri: coordinationWorkspaceResourceUri(cwd), action: "changed", id: input.sessionId });
        this.publishPresence(input.sessionId, cwd);
      }
      return { reservations, conflicts: dedupeConflicts(conflicts) };
    });
  }

  async heartbeatSession(input: { sessionId: string; cwd: string; ttlSeconds?: number }): Promise<CoordinationNote[]> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const cwd = canonicalCwd(input.cwd);
      this.touchPresence(input.sessionId, cwd);
      const ttl = boundedTtl(input.ttlSeconds ?? autoTtlSeconds());
      const now = new Date();
      const touched: CoordinationNote[] = [];
      for (const note of file.notes) {
        if (note.source !== "hook" || note.authorSessionId !== input.sessionId || !sameWorkspace(note.cwd, cwd)) continue;
        note.updatedAt = now.toISOString();
        note.expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
        touched.push(note);
      }
      if (touched.length > 0) {
        await this.write(file);
        this.events.publish({ kind: "coordination", uri: "herder://coordination", action: "changed", id: input.sessionId });
        this.events.publish({ kind: "coordination", uri: coordinationWorkspaceResourceUri(cwd), action: "changed", id: input.sessionId });
        this.publishPresence(input.sessionId, cwd);
      }
      return touched;
    });
  }

  async findConflicts(input: { sessionId: string; cwd: string; paths: string[] }): Promise<CoordinationConflict[]> {
    const cwd = canonicalCwd(input.cwd);
    const paths = normalizePathsForCwd(input.paths, cwd);
    const notes = await this.list({ cwd });
    const conflicts: CoordinationConflict[] = [];
    for (const path of paths) for (const note of notes) {
      if (note.authorSessionId === input.sessionId) continue;
      if (note.paths.some((candidate) => pathMatches(candidate, path))) conflicts.push({ path, note });
    }
    return dedupeConflicts(conflicts);
  }

  async renderForSession(session: { id: string; harness: string; cwd: string }): Promise<string | null> {
    const blocks: string[] = [];
    for (const board of this.boardsForSession(session.id, session.cwd)) {
      const block = await this.renderBoard(session, board, "agent-herder-coordination");
      if (block) blocks.push(block);
    }
    return blocks.length > 0 ? blocks.join("\n\n") : null;
  }

  /**
   * Roster of other agents recently active on one board (a workspace), for
   * file-activity injection: who they are and which paths they are touching.
   * Shares the per-board injection-dedup slot with renderForSession so the
   * same information never enters a session twice — only material changes
   * (author/kind/message/paths set) or the staleness window re-inject.
   */
  async renderWorkspacePeers(session: { id: string; harness: string; cwd: string }): Promise<string | null> {
    return this.renderBoard(session, session.cwd, "agent-herder-repo-peers");
  }

  private async renderBoard(
    session: { id: string; harness: string },
    board: string,
    tag: string,
  ): Promise<string | null> {
    const notes = (await this.list({ cwd: board })).filter((note) => note.authorSessionId !== session.id);
    if (notes.length === 0) return null;
    if (!this.shouldInject(`${session.id}#${board}`, this.noteSignature(notes))) return null;
    const byAuthor = new Map<string, { harness: string; paths: string[] }>();
    for (const note of notes) {
      const entry = byAuthor.get(note.authorSessionId) ?? { harness: note.authorHarness || "agent", paths: [] };
      entry.harness = note.authorHarness || entry.harness;
      for (const path of note.paths) if (!entry.paths.includes(path)) entry.paths.push(path);
      byAuthor.set(note.authorSessionId, entry);
    }
    const peers = [...byAuthor.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([authorSessionId, info]) => `- [${info.harness}] ${authorSessionId} :: ${info.paths.slice(0, 8).join(", ") || "(workspace-level)"}`);
    const declared = (await this.list({ cwd: board, authorSessionId: session.id })).some((note) => note.source !== "hook");
    const declaration = declared
      ? []
      : ["You have not declared your own task yet — do it now with one note (Agent Herder coordination_note_create: kind=\"working\", message=<one line: what you are doing>, paths=<files you own>) and update it when your goal changes."];
    if (tag === "agent-herder-repo-peers") {
      return [
        `<agent-herder-repo-peers board="${basename(board)}">`,
        "Other agents recently active in this repo. Before overlapping work, contact them via Agent Herder send_message with sessionId:",
        ...declaration,
        ...peers,
        "</agent-herder-repo-peers>",
      ].join("\n");
    }
    return [
      `<agent-herder-coordination board="${basename(board)}">`,
      `Active coordination notes from other agents in this workspace (${basename(board)}). Respect path ownership. If a note conflicts with your task, use Agent Herder send_message to contact its author before editing.`,
      ...declaration,
      ...notes.map((note) => {
        const paths = note.paths.length ? ` paths=${note.paths.join(",")}` : "";
        const author = `${note.authorHarness || "agent"}:${note.authorSessionId}`;
        return `- [${note.kind}] note=${note.id} author=${author} until=${note.expiresAt}${paths} :: ${note.message}`;
      }),
      "</agent-herder-coordination>",
    ].join("\n");
  }

  /**
   * Session wrapped up (harness Stop hook with no next goal): drop its
   * auto-reserved leases and presence from every board so peers stop seeing
   * a dead agent. Deliberate manual notes survive — they carry their own TTL
   * and may be intentional handoffs.
   */
  async endSession(sessionId: string): Promise<{ removed: number }> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const before = file.notes.length;
      file.notes = file.notes.filter((note) => !(note.authorSessionId === sessionId && note.source === "hook"));
      const removed = before - file.notes.length;
      if (removed > 0) await this.write(file);
      const boards = [...(this.presence.get(sessionId)?.keys() ?? [])];
      this.presence.delete(sessionId);
      if (removed > 0) this.events.publish({ kind: "coordination", uri: "herder://coordination", action: "changed", id: sessionId });
      this.publishPresence(sessionId, undefined, "deleted");
      for (const cwd of boards) this.events.publish({ kind: "presence", uri: presenceWorkspaceResourceUri(cwd), action: "changed", id: sessionId });
      for (const key of [...this.injectionState.keys()]) {
        if (key.startsWith(`${sessionId}#`)) this.injectionState.delete(key);
      }
      return { removed };
    });
  }

  presenceSnapshot(): Array<{ sessionId: string; boards: Array<{ cwd: string; lastSeenAt: string }> }> {
    return [...this.presence.entries()].map(([sessionId, boards]) => ({
      sessionId,
      boards: [...boards.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cwd, seen]) => ({ cwd, lastSeenAt: new Date(seen).toISOString() })),
    }));
  }

  presenceForSession(sessionId: string): { sessionId: string; boards: Array<{ cwd: string; lastSeenAt: string }> } | null {
    return this.presenceSnapshot().find((entry) => entry.sessionId === sessionId) ?? null;
  }

  presenceForWorkspace(cwd: string): Array<{ sessionId: string; lastSeenAt: string }> {
    const canonical = canonicalCwd(cwd);
    return this.presenceSnapshot()
      .flatMap((entry) => entry.boards.filter((board) => sameWorkspace(board.cwd, canonical)).map((board) => ({ sessionId: entry.sessionId, lastSeenAt: board.lastSeenAt })))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  /** True when this roster differs from what the session last saw, or the
   * last injection is old enough that context compaction may have eaten it. */
  private shouldInject(sessionId: string, signature: string): boolean {
    const previous = this.injectionState.get(sessionId);
    const now = Date.now();
    const reshowMs = Number(process.env.AGENT_HERDER_INJECTION_RESHOW_MS || 45 * 60 * 1000);
    if (previous && previous.signature === signature && now - previous.at < reshowMs) return false;
    this.injectionState.set(sessionId, { signature, at: now });
    return true;
  }

  /** Volatile-field-free fingerprint: TTL refreshes and id churn must not
   * re-trigger an injection; only the informative content counts. */
  private noteSignature(notes: CoordinationNote[]): string {
    return notes
      .map((note) => `${note.authorSessionId}|${note.kind}|${note.message}|${note.paths.join(",")}`)
      .sort()
      .join("\n");
  }

  async inject(session: { id: string; harness: string; cwd: string }, message: string): Promise<string> {
    await this.heartbeatSession({ sessionId: session.id, cwd: session.cwd });
    if (message.includes("<agent-herder-coordination>")) return message;
    const context = await this.renderForSession(session);
    return context ? `${context}\n\n${message}` : message;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => this.withFileLock(fn);
    const next = this.chain.then(run, run);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    await mkdir(dirname(this.filePath), { recursive: true });
    let acquired = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await mkdir(lockPath);
        acquired = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > 30_000) await rm(lockPath, { recursive: true, force: true });
        } catch { /* lock changed between checks */ }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!acquired) throw new Error("Timed out acquiring coordination note store lock");
    try { return await fn(); }
    finally { await rm(lockPath, { recursive: true, force: true }); }
  }

  private async read(): Promise<NoteFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as NoteFile;
      return { version: 1, notes: Array.isArray(parsed.notes) ? parsed.notes : [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, notes: [] };
      throw error;
    }
  }

  private async readAndPrune(): Promise<NoteFile> {
    const file = await this.read();
    const now = Date.now();
    const active = file.notes.filter((note) => Date.parse(note.expiresAt) > now);
    if (active.length !== file.notes.length) {
      file.notes = active;
      await this.write(file);
    }
    return file;
  }

  private async write(file: NoteFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, this.filePath);
  }
}

export const coordinationNotes = new CoordinationNoteStore();

export function autoTtlSeconds(): number {
  const configured = Number(process.env.AGENT_HERDER_AUTO_TTL_SECONDS || DEFAULT_AUTO_TTL_SECONDS);
  return Number.isFinite(configured) && configured >= 60 && configured <= MAX_TTL_SECONDS
    ? Math.round(configured)
    : DEFAULT_AUTO_TTL_SECONDS;
}

function boundedTtl(value?: number): number {
  const ttl = value ?? DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl < 60 || ttl > MAX_TTL_SECONDS) throw new Error(`ttlSeconds must be between 60 and ${MAX_TTL_SECONDS}`);
  return Math.round(ttl);
}
function requiredText(value: string, field: string, max: number): string {
  const text = value?.trim();
  if (!text) throw new Error(`${field} is required`);
  if (text.length > max) throw new Error(`${field} is too long`);
  return text;
}
function boundedMessage(value: string): string { return requiredText(value, "message", 4000); }
function canonicalCwd(value: string): string {
  const text = requiredText(value, "cwd", 4096).replace(/^~(?=\/|$)/, homedir());
  if (!isAbsolute(text)) throw new Error("cwd must be absolute or home-relative");
  return resolve(text);
}
function normalizePaths(paths: string[]): string[] {
  return [...new Set((paths ?? []).map((path) => path.trim()).filter(Boolean).slice(0, 64))];
}
function normalizePathsForCwd(paths: string[], cwd: string): string[] {
  return normalizePaths(paths).map((path) => {
    const expanded = path.replace(/^~(?=\/|$)/, homedir());
    if (!isAbsolute(expanded)) return expanded.replace(/^\.\//, "");
    const rel = relative(cwd, resolve(expanded));
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel : expanded;
  });
}
function sameWorkspace(a: string, b: string): boolean {
  const relAB = relative(a, b); const relBA = relative(b, a);
  return relAB === "" || (!relAB.startsWith(`..${sep}`) && relAB !== "..") || (!relBA.startsWith(`..${sep}`) && relBA !== "..");
}
function pathMatches(candidate: string, target: string): boolean {
  const c = candidate.replace(/^\.\//, ""); const t = target.replace(/^\.\//, "");
  return t === c || t.startsWith(`${c}/`) || c.startsWith(`${t}/`);
}
function assertOwner(note: CoordinationNote, authorSessionId: string): void {
  if (note.authorSessionId !== authorSessionId.trim()) throw new Error(`Coordination note '${note.id}' belongs to another session`);
}

function dedupeConflicts(conflicts: CoordinationConflict[]): CoordinationConflict[] {
  const seen = new Set<string>();
  return conflicts.filter((item) => {
    const key = `${item.path}\0${item.note.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
