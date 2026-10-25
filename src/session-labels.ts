import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, posix, win32 } from "node:path";
import { homedir } from "node:os";
import lockfile from "proper-lockfile";
import type { AgentSession } from "./types/index.js";

/**
 * The three descriptive fields of one session title.
 *
 * The owner approved the split: a constant project, the current business goal
 * and the current stage of the plan. They are descriptive metadata for the
 * reader, so they never change the lifecycle of a session and never reach the
 * native execution goal of a harness.
 */
export interface SessionLabel {
  /** The constant project the session belongs to. */
  project?: string;
  /** The current business goal of the session. */
  goal?: string;
  /** The current stage of the plan the session executes. */
  stage?: string;
}

/** One durable label record of one session of one harness. */
export interface SessionLabelRecord extends SessionLabel {
  harness: string;
  sessionId: string;
  updatedAt: string;
}

type LabelFile = { version: 1; labels: SessionLabelRecord[] };

/**
 * The bounds of the descriptive fields.
 *
 * They are generous on purpose: a business goal and a plan stage are written
 * by a human and must not be cut into an unreadable stub by an arbitrary
 * small limit. A value that does not fit is refused, never silently shortened.
 */
export const SESSION_LABEL_LIMITS = { project: 512, goal: 2048, stage: 2048 } as const;

/** How many durable label records are kept before the oldest ones are dropped. */
const SESSION_LABEL_LIMIT = 5000;

/** The separator of the composed title. */
export const SESSION_TITLE_SEPARATOR = " | ";

export function defaultSessionLabelPath(): string {
  return process.env.AGENT_HERDER_SESSION_LABELS?.trim()
    || join(homedir(), ".local", "state", "agent-herder", "session-labels.json");
}

function labelKey(harness: string, sessionId: string): string {
  return `${harness}:${sessionId}`;
}

/**
 * The composed title of one session.
 *
 * The sidebar form is «цель | проект». The project is reduced to the
 * repository name (including for worktrees), and stage is intentionally
 * omitted because it changes frequently and is not a task identity. Goals
 * are preserved in full: no semantic or character truncation is applied.
 */
export function composeSessionTitle(label: SessionLabel): string {
  const goal = typeof label.goal === "string" ? label.goal.trim() : "";
  const project = canonicalProjectName(label.project);
  return [goal, project]
    .filter((part) => part.length > 0)
    .join(SESSION_TITLE_SEPARATOR);
}

/** Keep sidebar labels useful across Linux, macOS, Windows, and git worktrees. */
function canonicalProjectName(value: string | undefined): string {
  const project = typeof value === "string" ? value.trim() : "";
  if (!project) return "";

  const pathApi = project.includes("\\") || win32.isAbsolute(project) ? win32 : posix;
  if (!pathApi.isAbsolute(project) && !/[\\/]/.test(project)) return project;

  const normalized = pathApi.normalize(project);
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const worktreesIndex = parts.lastIndexOf(".worktrees");
  if (worktreesIndex > 0 && worktreesIndex < parts.length - 1) {
    return parts[worktreesIndex - 1] ?? pathApi.basename(normalized);
  }
  return pathApi.basename(normalized);
}

/** The label of one session, or an empty label when nothing was stored yet. */
export function readSessionLabel(harness: string, sessionId: string): Promise<SessionLabel> {
  return sessionLabelStore().read(labelKey(harness, sessionId));
}

/**
 * The label of one session with the given fields applied.
 *
 * A field that is absent keeps its stored value, so a single-field update
 * never erases the other two.
 */
export function mergeSessionLabel(
  harness: string,
  sessionId: string,
  patch: SessionLabel,
): Promise<SessionLabel> {
  return sessionLabelStore().merge(labelKey(harness, sessionId), patch);
}

/** Store the label of one session and return the stored one. */
export function writeSessionLabel(
  harness: string,
  sessionId: string,
  patch: SessionLabel,
): Promise<SessionLabel> {
  return sessionLabelStore().write(labelKey(harness, sessionId), patch);
}

/**
 * The stored label of one session inside the session metadata.
 *
 * The metadata of a session is what every reader already sees, so the three
 * fields travel with it instead of with a separate catalogue.
 */
export function withSessionLabelMeta(session: AgentSession): AgentSession {
  const label = sessionLabels.get(sessionKeyOf(session));
  if (!label) return session;
  const meta = { ...(session.meta ?? {}) } as Record<string, unknown>;
  for (const field of ["project", "goal", "stage"] as const) {
    const value = label[field];
    if (typeof value === "string" && value.length > 0) meta[field] = value;
  }
  return { ...session, meta };
}

function sessionKeyOf(session: AgentSession): string {
  return labelKey(session.harness, session.id);
}

/** The in-process view of the stored labels, read once per process. */
const sessionLabels = new Map<string, SessionLabel>();

/**
 * The durable store of the session labels.
 *
 * One JSON file next to the other Herder state files. It is written by the
 * same operation that renames a session: no daemon, no cron and no model
 * call ever touches it.
 */
class SessionLabelStore {
  private operation: Promise<unknown> = Promise.resolve();
  private readonly lockTarget: string;

  constructor(private readonly path: string) {
    this.lockTarget = `${path}.lock`;
  }

  async read(key: string): Promise<SessionLabel> {
    const cached = sessionLabels.get(key);
    if (cached) return { ...cached };
    const file = await this.serial(() => this.readFile());
    const record = file.labels.find((item) => labelKey(item.harness, item.sessionId) === key);
    if (!record) return {};
    const label = labelOf(record);
    sessionLabels.set(key, label);
    return { ...label };
  }

  async merge(key: string, patch: SessionLabel): Promise<SessionLabel> {
    const current = await this.read(key);
    return applyPatch(current, patch);
  }

  async write(key: string, patch: SessionLabel): Promise<SessionLabel> {
    return this.serial(() => this.withFileLock(async () => {
      const file = await this.readFile();
      const index = file.labels.findIndex((item) => labelKey(item.harness, item.sessionId) === key);
      const current = index < 0 ? {} : labelOf(file.labels[index]);
      const next = applyPatch(current, patch);
      const [harness, sessionId] = splitKey(key);
      const record: SessionLabelRecord = {
        harness,
        sessionId,
        ...next,
        updatedAt: new Date().toISOString(),
      };
      if (index < 0) file.labels.push(record);
      else file.labels[index] = record;
      if (file.labels.length > SESSION_LABEL_LIMIT) {
        file.labels.splice(0, file.labels.length - SESSION_LABEL_LIMIT);
      }
      await this.writeFile(file);
      sessionLabels.set(key, next);
      return { ...next };
    }));
  }

  private async readFile(): Promise<LabelFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { version: 1, labels: [] };
      const file = parsed as Partial<LabelFile>;
      if (file.version !== 1 || !Array.isArray(file.labels)) return { version: 1, labels: [] };
      return {
        version: 1,
        labels: file.labels.filter((item): item is SessionLabelRecord => !!item
          && typeof item.harness === "string"
          && typeof item.sessionId === "string"
          && typeof item.updatedAt === "string"),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, labels: [] };
      throw error;
    }
  }

  private async writeFile(file: LabelFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Bounded interprocess lock: the label file is written by every worker. */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const handle = await open(this.lockTarget, "a", 0o600);
    await handle.close();
    const release = await lockfile.lock(this.lockTarget, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 20, minTimeout: 20, maxTimeout: 100, factor: 1 },
    });
    try {
      return await operation();
    } finally {
      await release();
    }
  }
}

function splitKey(key: string): [string, string] {
  const index = key.indexOf(":");
  return [key.slice(0, index), key.slice(index + 1)];
}

function labelOf(record: SessionLabelRecord): SessionLabel {
  const label: SessionLabel = {};
  for (const field of ["project", "goal", "stage"] as const) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) label[field] = value;
  }
  return label;
}

/** Apply one patch to one label: an absent field keeps its value. */
function applyPatch(current: SessionLabel, patch: SessionLabel): SessionLabel {
  const next: SessionLabel = { ...current };
  for (const field of ["project", "goal", "stage"] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    const text = value.trim();
    if (!text) {
      delete next[field];
      continue;
    }
    if (text.length > SESSION_LABEL_LIMITS[field]) {
      throw new Error(`The ${field} of a session title is longer than ${SESSION_LABEL_LIMITS[field]} characters`);
    }
    next[field] = text;
  }
  return next;
}

let store: SessionLabelStore | undefined;
let storePath: string | undefined;

function sessionLabelStore(): SessionLabelStore {
  const path = defaultSessionLabelPath();
  if (!store || storePath !== path) {
    store = new SessionLabelStore(path);
    storePath = path;
  }
  return store;
}

/** Drop the in-process view of the labels; the durable file keeps them. */
export function resetSessionLabelCache(): void {
  sessionLabels.clear();
}
