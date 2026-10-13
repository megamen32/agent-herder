import {filterAndArrangeSessions, matchesSessionQuery, type SessionListSession, type SessionListEntry, type SessionListSettings} from './session-list.js';
import {projectObservation, type ProjectObservation} from '../mesh/protocol.js';

type StorageAccess = Pick<Storage, 'getItem' | 'setItem'>;
export const pinStorageKey = (scope: string) => `agent-herder.session-pins:${scope}`;

/** Native identity only; working directories, titles and local selection aliases can change. */
export function sessionPinKey(session: SessionListSession): string | undefined {
  const nativeId = !session.remote && typeof session.meta?.nativeSessionId === 'string' ? session.meta.nativeSessionId : session.id;
  const parts = [session.hostId, session.harness, nativeId];
  return parts.every(value => typeof value === 'string' && value.length > 0) ? JSON.stringify(parts) : undefined;
}

export function sessionPinStorage(getStorage: () => StorageAccess): StorageAccess | null {
  try {return getStorage();} catch {return null;}
}

export function readSessionPinState(storage: StorageAccess | null, scope: string): {keys:string[]; failed:boolean} {
  if (!scope) return {keys:[], failed:false};
  if (!storage) return {keys:[], failed:true};
  let raw: string | null;
  try {raw = storage.getItem(pinStorageKey(scope));} catch {return {keys:[], failed:true};}
  try {
    const rows: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(rows)) return {keys:[], failed:false};
    const keys = [...new Set(rows.filter((row): row is string => {
      if (typeof row !== 'string') return false;
      try {const parts: unknown = JSON.parse(row); return Array.isArray(parts) && parts.length === 3 && parts.every(part => typeof part === 'string' && part.length > 0) && JSON.stringify(parts) === row;} catch {return false;}
    }))];
    return {keys, failed:false};
  } catch {return {keys:[], failed:false};}
}

export function readSessionPins(storage: StorageAccess, scope: string): string[] {
  return readSessionPinState(storage, scope).keys;
}

/** Persist before showing success. A failed write never changes the visible preference. */
export function toggleSessionPin(storage: StorageAccess | null, scope: string, key: string): string[] | null {
  if (!scope || !storage) return null;
  const read = readSessionPinState(storage, scope);
  if (read.failed) return null;
  const current = read.keys;
  const next = current.includes(key) ? current.filter(value => value !== key) : [key, ...current];
  try {storage.setItem(pinStorageKey(scope), JSON.stringify(next)); return next;} catch {return null;}
}

export function sidebarEntries(sessions: SessionListSession[], settings: SessionListSettings, collapsed: ReadonlySet<string>, choices: ReadonlySet<string>, query: string, pins: readonly string[], activity?: ReadonlyMap<string,string>): SessionListEntry[] {
  const visible = filterAndArrangeSessions(sessions, settings, collapsed, choices, activity).filter(({session}) => matchesSessionQuery(session, query));
  if (!pins.length) return visible;
  // Expand metadata only, not native sessions: a pinned child survives a folded parent.
  const available = filterAndArrangeSessions(sessions, settings, new Set(), choices, activity).filter(({session}) => matchesSessionQuery(session, query));
  const byPin = new Map(available.flatMap(entry => {const key = sessionPinKey(entry.session); return key ? [[key, entry] as const] : [];}));
  const selected = pins.flatMap(key => {const entry = byPin.get(key); return entry ? [{...entry, depth: 0}] : [];});
  const pinned = new Set(pins);
  return [...selected, ...visible.filter(entry => !pinned.has(sessionPinKey(entry.session) ?? ''))];
}

export type SidebarSession = SessionListSession & {project?: ProjectObservation};
const harnessLabels: Record<string, string> = {codex:'Codex', zcode:'ZCode', opencode:'OpenCode', hermes:'Hermes', claude:'Claude', fastagent:'FastAgent', chatgpt:'ChatGPT', zed:'Zed'};
const hostLabels: Record<string, string> = {'roomhacker-server-100':'100', 'server-100':'100', 'roomhacker-server-44':'44', 'server-44':'44', 'roomhacker-server-88':'88', 'server-88':'88', 'mac-m1':'M1', 'mac-mini':'Mini'};
const statuses: Record<string, string> = {running:'Выполняет задачу', idle:'Ожидает задачи', needs_input:'Ждёт ответа', stopped:'Остановлена', error:'Ошибка сессии'};

export function sidebarContext(session: SidebarSession, statusOverride?: string) {
  const project = session.project ?? projectObservation(session);
  const currentCwd = project.currentCwd && project.source !== 'unverified' ? project.currentCwd : undefined;
  const date = new Date(session.lastActivity);
  const harness = harnessLabels[session.harness] ?? session.harness;
  const host = session.hostId ? hostLabels[session.hostId] ?? session.hostLabel ?? session.hostId : 'Машина не подтверждена';
  return {
    subtitle: `${harness} · ${host}`, harness,
    host: session.hostId ? `${session.hostLabel || session.hostId}${session.hostLabel && session.hostLabel !== session.hostId ? ` · ${session.hostId}` : ''}` : 'Машина не подтверждена',
    currentCwd, launchCwd: project.launchCwd || undefined,
    model: session.model || 'Не указана', status: statusOverride ?? statuses[session.status] ?? 'Статус не подтверждён',
    updated: Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU') : 'Не подтверждено',
  };
}
