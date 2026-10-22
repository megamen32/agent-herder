import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, posix } from "node:path";
import { homedir, hostname } from "node:os";
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
  hostId: string;
  paths: string[];
  authorHarness?: string;
  authorSessionId: string;
  source?: "manual" | "hook";
  activityKey?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface WorkspaceDeclaration { sessionId: string; harness: string; hostId: string; cwd: string; expiresAt: string }
export interface WorkspaceObservation { hostId: string; cwd: string; source: "declared" | "coordination_activity"; expiresAt?: string }
type NoteFile = { version: 1; notes: CoordinationNote[]; workspaceDeclarations?: WorkspaceDeclaration[] };
export type CoordinationNoteCreate = Omit<CoordinationNote, "id" | "createdAt" | "updatedAt" | "expiresAt" | "hostId"> & { hostId?: string; ttlSeconds?: number };
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

/**
 * The one normalization point for a machine identity.
 * Undefined, blank and the loopback aliases mean "the machine this process runs on";
 * every other value is trimmed and lower-cased so the same machine always has one spelling.
 */
export function normalizeHostId(input: string | undefined | null, localHostId: string): string {
  const local = typeof localHostId === "string" ? localHostId.trim() : "";
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return local;
  const lowered = raw.toLowerCase();
  if (lowered === "localhost" || lowered === "127.0.0.1" || lowered === "::1" || lowered === "[::1]") return local;
  if (local && lowered === local.toLowerCase()) return local;
  return lowered;
}

export class CoordinationNoteStore {
  private chain: Promise<unknown> = Promise.resolve();
  /** Per receiving session+board: last injected roster signature + when.
   * All injection channels share these slots so the same information never
   * enters a session twice — only material changes re-inject. Keyed per
   * board because different boards carry different information. */
  private injectionState = new Map<string, { signature: string; at: number; notes: Map<string, string> }>();
  /** sessionId -> board cwd -> last activity ms. Tracks every workspace a
   * session has actually touched, so turn-start awareness covers all of
   * them, not just the launch directory. */
  private presence = new Map<string, Map<string, { hostId: string; cwd: string; at: number }>>();
  private workspaceCache = new Map<string, WorkspaceDeclaration>();
  readonly localHostId = hostname();
  constructor(private readonly filePath = defaultCoordinationNotePath(), private readonly events: HerderEventBus = herderEvents) {}

  private publishNote(note: CoordinationNote, action: "created" | "updated" | "deleted" | "changed"): void {
    this.events.publish({ kind: "coordination", uri: "herder://coordination", action, id: note.id });
    this.events.publish({ kind: "coordination", uri: coordinationNoteResourceUri(note.id), action, id: note.id });
    this.events.publish({ kind: "coordination", uri: coordinationWorkspaceResourceUri(workspaceResourcePath(note.hostId, note.cwd, this.localHostId)), action: "changed", id: note.id });
  }

  private publishPresence(sessionId: string, cwd?: string, hostId = this.localHostId, action: "created" | "updated" | "deleted" | "changed" = "changed"): void {
    this.events.publish({ kind: "presence", uri: "herder://presence", action: "changed", id: sessionId });
    this.events.publish({ kind: "presence", uri: presenceSessionResourceUri(sessionId), action, id: sessionId });
    if (cwd) this.events.publish({ kind: "presence", uri: presenceWorkspaceResourceUri(workspaceResourcePath(hostId, cwd, this.localHostId)), action: "changed", id: sessionId });
  }

  private touchPresence(sessionId: string, hostId: string, board: string): void {
    const boards = this.presence.get(sessionId) ?? new Map<string, { hostId: string; cwd: string; at: number }>();
    boards.set(workspaceKey(hostId, board), { hostId, cwd: board, at: Date.now() });
    this.presence.set(sessionId, boards);
  }

  /** Boards a session has touched recently, launch directory first. */
  private boardsForSession(sessionId: string, fallbackCwd: string, fallbackHostId = this.localHostId): Array<{ hostId: string; cwd: string }> {
    const now = Date.now();
    const boards = this.presence.get(sessionId);
    const recent: Array<{ hostId: string; cwd: string }> = [];
    if (boards) {
      for (const [key, board] of [...boards.entries()].sort((x, y) => y[1].at - x[1].at)) {
        if (now - board.at > 24 * 60 * 60 * 1000) { boards.delete(key); continue; }
        recent.push({ hostId: board.hostId, cwd: board.cwd });
      }
    }
    const fallback = { hostId: fallbackHostId, cwd: normalizeWorkspaceCwd(fallbackCwd, fallbackHostId, this.localHostId) };
    const unique = new Map<string, { hostId: string; cwd: string }>([[workspaceKey(fallback.hostId, fallback.cwd), fallback]]);
    for (const board of recent) unique.set(workspaceKey(board.hostId, board.cwd), board);
    return [...unique.values()].slice(0, 10);
  }

  async create(input: CoordinationNoteCreate): Promise<CoordinationNote> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const now = new Date();
      const ttl = boundedTtl(input.ttlSeconds);
      const hostId = requireHostId(input.hostId ?? this.localHostId);
      const cwd = normalizeWorkspaceCwd(input.cwd, hostId, this.localHostId);
      const note: CoordinationNote = {
        id: randomUUID(),
        kind: input.kind,
        message: boundedMessage(input.message),
        cwd,
        hostId,
        paths: normalizePathsForCwd(input.paths, cwd, hostId !== this.localHostId),
        ...(input.authorHarness ? { authorHarness: input.authorHarness } : {}),
        authorSessionId: requiredText(input.authorSessionId, "authorSessionId", 256),
        ...(input.source ? { source: input.source } : {}),
        ...(input.activityKey ? { activityKey: input.activityKey } : {}),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
      };
      file.notes.push(note);
      if (note.kind === "working") this.touchPresence(note.authorSessionId, hostId, cwd);
      await this.write(file);
      this.publishNote(note, "created");
      this.publishPresence(note.authorSessionId, note.cwd, note.hostId);
      return note;
    });
  }

  async list(filters: { cwd?: string; hostId?: string; path?: string; authorSessionId?: string; includeExpired?: boolean } = {}): Promise<CoordinationNote[]> {
    return this.serial(async () => {
      const file = filters.includeExpired ? await this.read() : await this.readAndPrune();
      const hostId = requireHostId(filters.hostId ?? this.localHostId);
      const cwd = filters.cwd ? normalizeWorkspaceCwd(filters.cwd, hostId, this.localHostId) : undefined;
      const path = filters.path?.trim();
      return file.notes
        .filter((note) => note.hostId === hostId)
        .filter((note) => !filters.authorSessionId || note.authorSessionId === filters.authorSessionId)
        .filter((note) => !cwd || sameWorkspace(note.cwd, cwd))
        .filter((note) => !path || note.paths.length === 0 || note.paths.some((candidate) => pathMatches(candidate, path)))
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    });
  }

  async get(id: string): Promise<CoordinationNote | null> {
    return this.serial(async () => (await this.readAndPrune()).notes.find((note) => note.id === id) ?? null);
  }

  async update(id: string, authorSessionId: string, patch: CoordinationNoteUpdate): Promise<CoordinationNote> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const note = file.notes.find((candidate) => candidate.id === id);
      if (!note) throw new Error(`Coordination note '${id}' not found or expired`);
      assertOwner(note, authorSessionId);
      if (patch.kind) note.kind = patch.kind;
      if (patch.message !== undefined) note.message = boundedMessage(patch.message);
      if (patch.paths !== undefined) note.paths = normalizePathsForCwd(patch.paths, note.cwd, note.hostId !== this.localHostId);
      if (patch.ttlSeconds !== undefined) note.expiresAt = new Date(Date.now() + boundedTtl(patch.ttlSeconds) * 1000).toISOString();
      note.updatedAt = new Date().toISOString();
      await this.write(file);
      this.publishNote(note, "updated");
      this.publishPresence(note.authorSessionId, note.cwd, note.hostId);
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
      this.publishPresence(removed.authorSessionId, removed.cwd, removed.hostId);
      return true;
    });
  }

  async reservePaths(input: { harness: string; sessionId: string; cwd: string; hostId?: string; paths: string[]; ttlSeconds?: number }): Promise<CoordinationReservationResult> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const hostId = requireHostId(input.hostId ?? this.localHostId);
      const cwd = normalizeWorkspaceCwd(input.cwd, hostId, this.localHostId);
      this.touchPresence(input.sessionId, hostId, cwd);
      const paths = normalizePathsForCwd(input.paths, cwd, hostId !== this.localHostId).filter(path => !isDeviceSink(path));
      const ttl = boundedTtl(input.ttlSeconds ?? autoTtlSeconds());
      const now = new Date();
      const conflicts: CoordinationConflict[] = [];
      const reservations: CoordinationNote[] = [];
      for (const path of paths) {
        for (const note of file.notes) {
          if (note.authorSessionId === input.sessionId || note.hostId !== hostId || !sameWorkspace(note.cwd, cwd)) continue;
          if (note.paths.some((candidate) => pathMatches(candidate, path))) conflicts.push({ path, note });
        }
        const activityKey = `hook:${JSON.stringify([hostId, input.sessionId, cwd, path])}`;
        let note = file.notes.find((candidate) => candidate.activityKey === activityKey);
        if (!note) {
          note = {
            id: randomUUID(), kind: "working", message: `Auto-reserved after file activity: ${path}`, cwd, hostId, paths: [path],
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
        this.events.publish({ kind: "coordination", uri: coordinationWorkspaceResourceUri(workspaceResourcePath(hostId, cwd, this.localHostId)), action: "changed", id: input.sessionId });
        this.publishPresence(input.sessionId, cwd, hostId);
      }
      return { reservations, conflicts: dedupeConflicts(conflicts) };
    });
  }

  async heartbeatSession(input: { sessionId: string; cwd: string; hostId?: string; ttlSeconds?: number }): Promise<CoordinationNote[]> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const hostId = requireHostId(input.hostId ?? this.localHostId);
      const cwd = normalizeWorkspaceCwd(input.cwd, hostId, this.localHostId);
      this.touchPresence(input.sessionId, hostId, cwd);
      const ttl = boundedTtl(input.ttlSeconds ?? autoTtlSeconds());
      const now = new Date();
      const touched: CoordinationNote[] = [];
      for (const note of file.notes) {
        if (note.source !== "hook" || note.authorSessionId !== input.sessionId || note.hostId !== hostId || !sameWorkspace(note.cwd, cwd)) continue;
        note.updatedAt = now.toISOString();
        note.expiresAt = new Date(now.getTime() + ttl * 1000).toISOString();
        touched.push(note);
      }
      if (touched.length > 0) {
        await this.write(file);
        this.events.publish({ kind: "coordination", uri: "herder://coordination", action: "changed", id: input.sessionId });
        this.events.publish({ kind: "coordination", uri: coordinationWorkspaceResourceUri(workspaceResourcePath(hostId, cwd, this.localHostId)), action: "changed", id: input.sessionId });
        this.publishPresence(input.sessionId, cwd, hostId);
      }
      return touched;
    });
  }

  async findConflicts(input: { sessionId: string; cwd: string; hostId?: string; paths: string[] }): Promise<CoordinationConflict[]> {
    const hostId = requireHostId(input.hostId ?? this.localHostId);
    const cwd = normalizeWorkspaceCwd(input.cwd, hostId, this.localHostId);
    const paths = normalizePathsForCwd(input.paths, cwd, hostId !== this.localHostId).filter(path => !isDeviceSink(path));
    const notes = await this.list({ hostId, cwd });
    const conflicts: CoordinationConflict[] = [];
    for (const path of paths) for (const note of notes) {
      if (note.authorSessionId === input.sessionId) continue;
      if (note.paths.some((candidate) => pathMatches(candidate, path))) conflicts.push({ path, note });
    }
    return dedupeConflicts(conflicts);
  }

  async renderForSession(session: { id: string; harness: string; cwd: string; hostId?: string }): Promise<string | null> {
    const blocks: string[] = [];
    const declared = await this.activeWorkspaceObservation(session.id);
    const fallbackHost = session.hostId ?? this.localHostId;
    const boards = declared
      ? [{ hostId: declared.hostId, cwd: declared.cwd }, ...this.boardsForSession(session.id, declared.cwd, declared.hostId).filter((board) => board.hostId === declared.hostId && !sameWorkspace(board.cwd, declared.cwd))]
      : this.boardsForSession(session.id, session.cwd, fallbackHost);
    for (const board of boards) {
      const block = await this.renderBoard(session, board, "agent-herder-coordination");
      if (block) blocks.push(block);
    }
    return blocks.length > 0 ? boundedCoordinationContext(blocks.join("\n\n")) : null;
  }

  /**
   * Passive file-activity signal. Full current owners and paths remain in
   * coordination_note_list; this avoids repeating a roster on every edit.
   */
  async renderWorkspacePeers(session: { id: string; harness: string; cwd: string; hostId?: string }): Promise<string | null> {
    const hostId = session.hostId ?? this.localHostId;
    const cwd = session.cwd;
    return this.renderBoard(session, { hostId, cwd }, "agent-herder-repo-peers");
  }

  private async renderBoard(
    session: { id: string; harness: string },
    board: { hostId: string; cwd: string },
    tag: string,
  ): Promise<string | null> {
    const notes = (await this.list({ cwd: board.cwd, hostId: board.hostId })).filter((note) => note.authorSessionId !== session.id);
    const key = `${session.id}#${workspaceKey(board.hostId, board.cwd)}`;
    const previous = this.injectionState.get(key);
    const fingerprint = (note: CoordinationNote) => JSON.stringify({ authorSessionId: note.authorSessionId, authorHarness: note.authorHarness || "agent", kind: note.kind, message: note.message, paths: note.paths, source: note.source || "manual" });
    const known = previous?.notes ?? new Map<string, string>();
    if (tag === "agent-herder-repo-peers") {
      const passiveNotes = notes.filter(note => note.source === "hook" && note.kind === "working");
      const passiveIds = new Set(passiveNotes.map(note => note.id));
      const changed = passiveNotes.filter(note => known.get(note.id) !== fingerprint(note));
      const removed = [...known.entries()].filter(([id, value]) => snapshotSource(value) === "hook" && !passiveIds.has(id));
      if (changed.length === 0 && removed.length === 0) return null;
      if (previous && Date.now() - previous.at < 60_000 && changed.length > 0 && removed.length === 0) return null;
      const output = `<agent-herder-repo-peers board="${displayWorkspace(board, this.localHostId)}">Owners +${changed.length}, -${removed.length}.</agent-herder-repo-peers>`;
      const acknowledged = new Map(known);
      // The note list is the authoritative full snapshot. Acknowledge all hook
      // ownership notes represented by that snapshot, while leaving manual
      // decisions/avoid notes for the detailed active renderForSession path.
      for (const note of passiveNotes) acknowledged.set(note.id, fingerprint(note));
      for (const [id] of removed) acknowledged.delete(id);
      this.injectionState.set(key, { signature: this.noteSignature(notes), at: Date.now(), notes: acknowledged });
      return output;
    }
    if (notes.length === 0) {
      if (!previous?.notes?.size) return null;
      const oldNotes = [...previous.notes.entries()];
      const releasedWorking = oldNotes.filter(([, value]) => snapshotKind(value) === "working");
      const releasedActionable = oldNotes.filter(([, value]) => snapshotKind(value) !== "working");
      const lines = releasedWorking.length > 0
        ? [`- Owners +0, -${releasedWorking.length}.`]
        : [];
      lines.push(...releasedActionable.map(([id, value]) => `- Ownership released ${releasedAuthor(value)} noteId=${id}.`));
      const actionableDetails = releasedActionable.length > 0
        ? ["Details: coordination_note_get(noteId).", `Workspace: ${coordinationWorkspaceResourceUri(workspaceResourcePath(board.hostId, board.cwd, this.localHostId))}`]
        : [];
      const output = boundedCoordinationContext([`<${tag} board="${displayWorkspace(board, this.localHostId)}">`, ...lines, ...actionableDetails, `</${tag}>`].join("\n"));
      const delivered = new Map(previous.notes);
      for (const [id, value] of previous.notes) if (snapshotKind(value) === "working" || output.includes(`noteId=${id}`)) delivered.delete(id);
      this.injectionState.set(key, { signature:"", at:delivered.size ? previous.at : Date.now(), notes:delivered });
      return output;
    }
    // TTL-only updates are deliberately invisible. Keep the state per note so
    // one changed owner does not cause the full roster to be injected again.
    const changed = notes.filter(note => known.get(note.id) !== fingerprint(note));
    const removed = [...known.entries()].filter(([id]) => !notes.some(note => note.id === id));
    if (changed.length === 0 && removed.length === 0) return null;
    if (previous && Date.now() - previous.at < 60_000 && changed.length > 0 && changed.every(note => note.source === "hook" && note.kind === "working") && removed.length === 0) return null;
    const changedWorking = changed.filter(note => note.kind === "working");
    const changedActionable = changed.filter(note => note.kind !== "working");
    const removedWorking = removed.filter(([, value]) => snapshotKind(value) === "working");
    const removedActionable = removed.filter(([, value]) => snapshotKind(value) !== "working");
    const workingChanged = changedWorking.length > 0 || removedWorking.length > 0;
    const lines: string[] = [];
    if (workingChanged) lines.push(`- Owners +${changedWorking.length}, -${removedWorking.length}.`);
    lines.push(...removedActionable.map(([id, value]) => `- Ownership released ${releasedAuthor(value)} noteId=${id}.`));
    lines.push(...changedActionable.map((note) => {
      const paths = note.paths.length ? ` paths=${note.paths.slice(0, 4).join(",").slice(0, 90)}` : "";
      const author = `${note.authorHarness || "agent"}:${note.authorSessionId}`;
      return `- [${note.kind}] author=${author}${paths} noteId=${note.id} :: ${note.message.slice(0, Math.max(40, Math.min(100, Math.floor(1600 / Math.max(1,changedActionable.length)))))}`;
    }));
    const output = boundedCoordinationContext([
      `<agent-herder-coordination board="${displayWorkspace(board, this.localHostId)}">`,
      ...lines,
      ...(changedActionable.length > 0 || removedActionable.length > 0
        ? ["Details: coordination_note_get(noteId).", `Workspace: ${coordinationWorkspaceResourceUri(workspaceResourcePath(board.hostId, board.cwd, this.localHostId))}`]
        : []),
      "</agent-herder-coordination>",
    ].join("\n"));
    const renderedNotes = new Set(changed.filter(note => note.kind === "working" ? workingChanged : output.includes(`noteId=${note.id}`)).map(note=>note.id));
    const renderedRemoved = new Set(removed.filter(([id, value]) => snapshotKind(value) === "working" ? workingChanged : output.includes(`noteId=${id}`)).map(([id])=>id));
    this.saveInjectionState(key, known, changed.filter(note => renderedNotes.has(note.id)), removed.filter(([id])=>renderedRemoved.has(id)), renderedNotes, notes, fingerprint);
    return output;
  }

  private saveInjectionState(
    key: string, known: Map<string, string>, changed: CoordinationNote[], removed: Array<[string, string]>,
    rendered: Set<string>, notes: CoordinationNote[], fingerprint: (note: CoordinationNote) => string,
  ): void {
    const delivered = new Map(known);
    for (const note of changed) if (rendered.has(note.id)) delivered.set(note.id, fingerprint(note));
    for (const [id] of removed) delivered.delete(id);
    const madeProgress = rendered.size > 0 || removed.length > 0;
    this.injectionState.set(key, { signature: this.noteSignature(notes), at: madeProgress ? Date.now() : (this.injectionState.get(key)?.at ?? Date.now()), notes: delivered });
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
      const beforeDeclarations = file.workspaceDeclarations?.length ?? 0;
      file.workspaceDeclarations = (file.workspaceDeclarations ?? []).filter((entry) => entry.sessionId !== sessionId);
      for (const key of [...this.workspaceCache.keys()]) if (key === sessionId) this.workspaceCache.delete(key);
      if (removed > 0 || beforeDeclarations !== file.workspaceDeclarations.length) await this.write(file);
      const boards = [...(this.presence.get(sessionId)?.values() ?? [])];
      this.presence.delete(sessionId);
      if (removed > 0) this.events.publish({ kind: "coordination", uri: "herder://coordination", action: "changed", id: sessionId });
      this.publishPresence(sessionId, undefined, this.localHostId, "deleted");
      for (const board of boards) this.events.publish({ kind: "presence", uri: presenceWorkspaceResourceUri(workspaceResourcePath(board.hostId, board.cwd, this.localHostId)), action: "changed", id: sessionId });
      for (const key of [...this.injectionState.keys()]) {
        if (key.startsWith(`${sessionId}#`)) this.injectionState.delete(key);
      }
      return { removed };
    });
  }

  activeWorkspaceForSession(sessionId: string): string | undefined {
    const now = Date.now();
    const boards = this.presence.get(sessionId);
    if (!boards) return undefined;
    for (const [key, board] of [...boards.entries()].sort((a, b) => b[1].at - a[1].at)) {
      if (now - board.at > 5 * 60 * 1000) { boards.delete(key); continue; }
      if (board.hostId === this.localHostId) return board.cwd;
    }
    if (!boards.size) this.presence.delete(sessionId);
    return undefined;
  }

  cachedWorkspaceObservation(sessionId: string): WorkspaceObservation | undefined {
    const declaration = this.workspaceCache.get(sessionId);
    if (declaration && Date.parse(declaration.expiresAt) > Date.now()) return { hostId: declaration.hostId, cwd: declaration.cwd, source: "declared", expiresAt: declaration.expiresAt };
    if (declaration) this.workspaceCache.delete(sessionId);
    const cwd = this.activeWorkspaceForSession(sessionId);
    return cwd ? { hostId: this.localHostId, cwd, source: "coordination_activity" } : undefined;
  }

  async activeWorkspaceObservation(sessionId: string): Promise<WorkspaceObservation | undefined> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const declaration = file.workspaceDeclarations?.find((entry) => entry.sessionId === requiredText(sessionId, "sessionId", 256));
      if (declaration && Date.parse(declaration.expiresAt) > Date.now()) {
        this.workspaceCache.set(sessionId, declaration);
        return { hostId: declaration.hostId, cwd: declaration.cwd, source: "declared", expiresAt: declaration.expiresAt };
      }
      this.workspaceCache.delete(sessionId);
      const cwd = this.activeWorkspaceForSession(sessionId);
      return cwd ? { hostId: this.localHostId, cwd, source: "coordination_activity" } : undefined;
    });
  }

  async declareWorkspace(input: { sessionId: string; harness: string; hostId?: string; cwd: string; ttlSeconds?: number }): Promise<WorkspaceDeclaration> {
    return this.serial(async () => {
      const file = await this.readAndPrune();
      const sessionId = requiredText(input.sessionId, "sessionId", 256);
      const harness = requiredText(input.harness, "harness", 64);
      const hostId = requireHostId(input.hostId ?? this.localHostId);
      const cwd = normalizeWorkspaceCwd(input.cwd, hostId, this.localHostId);
      const expiresAt = new Date(Date.now() + boundedTtl(input.ttlSeconds) * 1000).toISOString();
      const declaration = { sessionId, harness, hostId, cwd, expiresAt };
      file.workspaceDeclarations = (file.workspaceDeclarations ?? []).filter((entry) => entry.sessionId !== sessionId);
      file.workspaceDeclarations.push(declaration);
      await this.write(file);
      this.workspaceCache.set(sessionId, declaration);
      this.events.publish({ kind: "coordination", uri: "herder://coordination", action: "updated", id: sessionId });
      this.events.publish({ kind: "coordination", uri: coordinationWorkspaceResourceUri(workspaceResourcePath(hostId, cwd, this.localHostId)), action: "changed", id: sessionId });
      return declaration;
    });
  }

  async clearWorkspace(sessionId: string): Promise<boolean> {
    return this.serial(async () => {
      sessionId = requiredText(sessionId, "sessionId", 256);
      const file = await this.readAndPrune();
      const before = file.workspaceDeclarations?.length ?? 0;
      file.workspaceDeclarations = (file.workspaceDeclarations ?? []).filter((entry) => entry.sessionId !== sessionId);
      const cleared = before !== file.workspaceDeclarations.length;
      this.workspaceCache.delete(sessionId);
      if (cleared) {
        await this.write(file);
        this.events.publish({ kind: "coordination", uri: "herder://coordination", action: "updated", id: sessionId });
      }
      return cleared;
    });
  }

  presenceSnapshot(): Array<{ sessionId: string; boards: Array<{ hostId: string; cwd: string; lastSeenAt: string }> }> {
    const now = Date.now();
    for (const [sessionId, boards] of this.presence) {
      for (const [board, seen] of boards) if (now - seen.at > 5 * 60 * 1000) boards.delete(board);
      if (!boards.size) this.presence.delete(sessionId);
    }
    return [...this.presence.entries()].map(([sessionId, boards]) => ({
      sessionId,
      boards: [...boards.entries()]
        .sort((a, b) => b[1].at - a[1].at)
        .map(([, board]) => ({ hostId: board.hostId, cwd: board.cwd, lastSeenAt: new Date(board.at).toISOString() })),
    }));
  }

  presenceForSession(sessionId: string): { sessionId: string; boards: Array<{ hostId: string; cwd: string; lastSeenAt: string }> } | null {
    return this.presenceSnapshot().find((entry) => entry.sessionId === sessionId) ?? null;
  }

  presenceForWorkspace(cwd: string, hostId = this.localHostId): Array<{ sessionId: string; lastSeenAt: string }> {
    const canonicalHost = requireHostId(hostId);
    const canonical = normalizeWorkspaceCwd(cwd, canonicalHost, this.localHostId);
    return this.presenceSnapshot()
      .flatMap((entry) => entry.boards.filter((board) => board.hostId === canonicalHost && sameWorkspace(board.cwd, canonical)).map((board) => ({ sessionId: entry.sessionId, lastSeenAt: board.lastSeenAt })))
      .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  }

  /** Volatile-field-free fingerprint: TTL refreshes and id churn must not
   * re-trigger an injection; only the informative content counts. */
  private noteSignature(notes: CoordinationNote[]): string {
    return notes
      .map((note) => `${note.hostId}|${note.cwd}|${note.authorSessionId}|${note.kind}|${note.message}|${note.paths.join(",")}`)
      .sort()
      .join("\n");
  }

  async inject(session: { id: string; harness: string; cwd: string; hostId?: string }, message: string): Promise<string> {
    if (!this.activeWorkspaceForSession(session.id)) await this.heartbeatSession({ sessionId: session.id, cwd: session.cwd, hostId: session.hostId });
    if (/<agent-herder-(?:coordination|repo-peers)(?:\s|>)/.test(message)) return message;
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
      const notes = (Array.isArray(parsed.notes) ? parsed.notes : []).map((note) => ({ ...note, hostId: requireHostId(note.hostId ?? this.localHostId) }));
      const declarations = (Array.isArray(parsed.workspaceDeclarations) ? parsed.workspaceDeclarations : []).flatMap((entry) => {
        try {
          const hostId = requireHostId(entry.hostId);
          const cwd = normalizeWorkspaceCwd(entry.cwd, hostId, this.localHostId);
          const sessionId = requiredText(entry.sessionId, "sessionId", 256);
          const harness = requiredText(entry.harness, "harness", 64);
          return [{ sessionId, harness, hostId, cwd, expiresAt: entry.expiresAt }];
        } catch { return []; }
      });
      return { version: 1, notes, workspaceDeclarations: declarations };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, notes: [], workspaceDeclarations: [] };
      throw error;
    }
  }

  private async readAndPrune(): Promise<NoteFile> {
    const file = await this.read();
    const now = Date.now();
    const active = file.notes.filter((note) => Date.parse(note.expiresAt) > now && !(note.source === "hook" && note.paths.length > 0 && note.paths.every(isDeviceSink)));
    const activeDeclarations = (file.workspaceDeclarations ?? []).filter((entry) => Date.parse(entry.expiresAt) > now);
    if (active.length !== file.notes.length || activeDeclarations.length !== (file.workspaceDeclarations ?? []).length) {
      file.notes = active;
      file.workspaceDeclarations = activeDeclarations;
      await this.write(file);
    }
    for (const [sessionId, cached] of this.workspaceCache) {
      if (Date.parse(cached.expiresAt) <= now || !activeDeclarations.some((entry) => entry.sessionId === sessionId)) this.workspaceCache.delete(sessionId);
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
function requireHostId(value: string): string {
  const hostId = requiredText(value, "hostId", 512);
  if (/[\s\x00-\x1f\x7f/\\]/u.test(hostId)) throw new Error("hostId contains invalid characters");
  return hostId;
}
function releasedAuthor(value: string): string {
  try {
    const note = JSON.parse(value) as { authorHarness?: string; authorSessionId?: string; kind?: string; paths?: string[]; message?: string };
    return `[${note.authorHarness || "agent"}] ${note.authorSessionId || "unknown"} ${note.kind || "note"} ${note.paths?.slice(0, 4).join(",") || "(workspace-level)"} :: ${(note.message || "").slice(0, 60)}`;
  } catch { return "previous note"; }
}
function snapshotSource(value: string): string | undefined {
  try { return (JSON.parse(value) as { source?: string }).source; }
  catch { return undefined; }
}
function snapshotKind(value: string): CoordinationNoteKind | undefined {
  try {
    const kind = (JSON.parse(value) as { kind?: unknown }).kind;
    return kind === "working" || kind === "avoid" || kind === "handoff" || kind === "info" ? kind : undefined;
  } catch { return undefined; }
}
function canonicalCwd(value: string): string {
  const text = requiredText(value, "cwd", 4096).replace(/^~(?=\/|$)/, homedir());
  if (!isAbsolute(text)) throw new Error("cwd must be absolute or home-relative");
  return resolve(text);
}
function normalizeWorkspaceCwd(value: string, hostId: string, localHostId: string): string {
  if (hostId === localHostId) return canonicalCwd(value);
  const cwd = requiredText(value, "cwd", 4096);
  if (/[\x00-\x1f\x7f]/u.test(cwd) || !posix.isAbsolute(cwd) || cwd.startsWith("~")) throw new Error("cwd must be an absolute POSIX path for a remote host");
  return posix.normalize(cwd);
}
function normalizePaths(paths: string[]): string[] {
  return [...new Set((paths ?? []).map((path) => path.trim()).filter(Boolean).slice(0, 64))];
}
function normalizePathsForCwd(paths: string[], cwd: string, remotePosix = false): string[] {
  return normalizePaths(paths).map((path) => {
    if (remotePosix) {
      const normalized = posix.isAbsolute(path) ? posix.normalize(path) : path.replace(/^\.\//, "");
      if (!posix.isAbsolute(normalized)) return normalized;
      const rel = posix.relative(cwd, normalized);
      return rel && rel !== ".." && !rel.startsWith("../") ? rel : normalized;
    }
    const expanded = path.replace(/^~(?=\/|$)/, homedir());
    if (!isAbsolute(expanded)) return expanded.replace(/^\.\//, "");
    const rel = relative(cwd, resolve(expanded));
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel : expanded;
  });
}
function sameWorkspace(a: string, b: string): boolean {
  if (posix.isAbsolute(a) && posix.isAbsolute(b)) return posix.normalize(a) === posix.normalize(b);
  return resolve(a) === resolve(b);
}
function workspaceKey(hostId: string, cwd: string): string { return JSON.stringify([hostId, cwd]); }
function workspaceResourcePath(hostId: string, cwd: string, localHostId: string): string { return hostId === localHostId ? cwd : workspaceKey(hostId, cwd); }
function displayWorkspace(board: { hostId: string; cwd: string }, localHostId: string): string { return board.hostId === localHostId ? basename(board.cwd) : `${board.hostId}:${board.cwd}`; }


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

function injectionReshowMs(): number {
  const value = Number(process.env.AGENT_HERDER_INJECTION_RESHOW_MS || 45 * 60 * 1000);
  return Number.isFinite(value) && value >= 60_000 ? value : 45 * 60 * 1000;
}
export function boundedCoordinationContext(value: string): string {
  if (value.length <= 4000) return value;
  const lines = value.split("\n");
  const closing = lines.at(-1)?.startsWith("</") ? lines.pop()! : "";
  let result = "";
  for (const line of lines) {
    if (result.length + line.length + closing.length + 160 > 4000) break;
    result += line + "\n";
  }
  return result + "Context incomplete: additional owners or conflicts may exist. Read the workspace resource before editing an unlisted path.\n" + closing;
}

function isDeviceSink(path: string): boolean {
  return /^\/dev\/(?:null|zero|full|random|urandom|stdin|stdout|stderr)$/.test(path) || /^\/(?:dev\/fd|proc\/self\/fd)\/\d+$/.test(path);
}
