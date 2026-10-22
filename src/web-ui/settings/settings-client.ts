/**
 * The client of the settings of the herder.
 *
 * The client never keeps the value of a secret: the owner types it once, the
 * client sends it once, and the value is dropped. The answer of the server
 * names a secret by the fact that it is set and by its fingerprint, and the
 * client keeps that.
 */

export type SettingsScopeKind = "mesh" | "project" | "node" | "user";
export type SettingsApplyMode = "сразу" | "к новым задачам" | "после перезапуска";
export type SettingsApplyState = "Записано" | "Применяется" | "Применено" | "Применено частично" | "Ошибка";
export type SettingsEntity = "herder.env" | "node-config";

export type SettingsRecord = {
  id: string;
  humanName: string;
  action: string;
  scope: { kind: SettingsScopeKind; path?: string };
  source: "default" | "inherited" | "override";
  origin: "default" | "file" | "explicit";
  code_revision: string;
  desired: { value: unknown; desired_revision: number; fingerprint?: string };
  confirmed: {
    applied_revision: number;
    state: SettingsApplyState;
    appliedAt: string | null;
    applyMode: SettingsApplyMode;
    requiresRestart: boolean;
  };
  changedBy: string | null;
  changedAt: string | null;
  rollbackRef: string | null;
};

export type SettingsAuditValue = {
  present: boolean;
  value?: string;
  configured?: boolean;
  fingerprint?: string;
};

export type SettingsAuditRecord = {
  id: string;
  at: string;
  actor: string;
  action: "set" | "delete" | "rollback";
  entity: SettingsEntity;
  key: string;
  kind: "value" | "secret";
  before: SettingsAuditValue;
  after: SettingsAuditValue;
  changed: boolean;
  historyId?: string;
};

export type SettingsDifference = {
  id: string;
  key: string;
  entity: SettingsEntity;
  baseVersion: number;
  currentVersion: number;
  changedBy: string | null;
  changedAt: string | null;
};

export type SettingsProfile = {
  id: string;
  humanName: string;
  action: string;
  scope: { kind: SettingsScopeKind; path?: string };
  harness: string;
  model?: string;
  fallbackModels?: string[];
  allowedTools?: string[];
  limits?: Record<string, unknown>;
};

export type SettingsSecretLifecycle = {
  key: string;
  purpose?: string;
  expiresAt?: string;
  consumers: string[];
  configured: boolean;
  fingerprint?: string;
};

export type SettingsView = {
  ok: true;
  generatedAt: string;
  actor: string;
  product: string;
  etag: string;
  records: SettingsRecord[];
  profiles: SettingsProfile[];
  secrets: SettingsSecretLifecycle[];
  environment: {
    entity: "herder.env";
    path: string;
    present: boolean;
    mode?: string;
    source?: string;
    applies?: string;
    values: Record<string, { kind: "value" | "secret"; present: boolean; value?: string; configured?: boolean; fingerprint?: string; description?: string }>;
  };
  fleetNode: {
    entity: "node-config";
    path: string;
    present: boolean;
    hostId: string;
    managedKeys: string[];
    config: Record<string, unknown> | null;
    note?: string;
  };
  launchPolicy: {
    endpoint: string;
    managedBy?: string;
    write?: string;
    state: string;
    etag?: string;
    policy?: unknown;
    error?: string;
  };
  audit: SettingsAuditRecord[];
};

export type SettingsSaveResult =
  | { ok: true; view: SettingsView; applied: SettingsAuditRecord[] }
  | {
    ok: false;
    code: "precondition_required" | "version_conflict" | "rejected";
    error: string;
    difference?: SettingsDifference[];
    current?: { etag: string; records: SettingsRecord[] };
  };

/** The changes the owner makes. */
export type SettingsChanges = {
  environment?: Record<string, string | null>;
  fleetNode?: Record<string, unknown>;
  secrets?: Record<string, { operation?: "check" | "revoke"; purpose?: string; expiresAt?: string; fingerprint?: string }>;
  profiles?: Array<Record<string, unknown>>;
  /** The versions of the records the owner edited: the precondition of the change. */
  baseVersion?: Record<string, number>;
};

/** The answer of the server, parsed. */
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const failure = (body ?? {}) as Record<string, unknown>;
    const error = new Error(typeof failure.error === "string" ? failure.error : `the server answered ${response.status}`);
    (error as Error & { status?: number; body?: unknown }).status = response.status;
    (error as Error & { status?: number; body?: unknown }).body = body;
    throw error;
  }
  return body as T;
}

/** The settings of the herder, as they are now. */
export async function loadSettings(): Promise<SettingsView> {
  return await requestJson<SettingsView>("/api/settings");
}

/** The journal of the changes. */
export async function loadSettingsAudit(limit = 100): Promise<SettingsAuditRecord[]> {
  const body = await requestJson<{ records: SettingsAuditRecord[] }>(`/api/settings/audit?limit=${limit}`);
  return body.records;
}

/**
 * A change of the owner.
 *
 * The version the owner read travels in the If-Match header: the server
 * refuses a change made on a base that moved on, and the answer says what
 * moved.
 */
export async function saveSettings(changes: SettingsChanges, etag: string): Promise<SettingsSaveResult> {
  try {
    const body = await requestJson<{ applied: SettingsAuditRecord[] } & SettingsView>("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": etag },
      body: JSON.stringify(changes),
    });
    return { ok: true, view: body, applied: body.applied ?? [] };
  } catch (error) {
    const failure = error as Error & { status?: number; body?: unknown };
    const body = (failure.body ?? {}) as Record<string, unknown>;
    const code = body.code === "version_conflict" || body.code === "precondition_required"
      ? body.code
      : "rejected";
    return {
      ok: false,
      code,
      error: failure.message,
      ...(Array.isArray(body.difference) ? { difference: body.difference as SettingsDifference[] } : {}),
      ...(body.current ? { current: body.current as { etag: string; records: SettingsRecord[] } } : {}),
    };
  }
}

/** The rollback of one change. */
export async function rollbackSetting(entity: SettingsEntity, key: string, etag: string): Promise<SettingsSaveResult> {
  try {
    const body = await requestJson<{ applied: SettingsAuditRecord[] } & SettingsView>("/api/settings/rollback", {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": etag },
      body: JSON.stringify({ entity, key }),
    });
    return { ok: true, view: body, applied: body.applied ?? [] };
  } catch (error) {
    const failure = error as Error & { status?: number; body?: unknown };
    const body = (failure.body ?? {}) as Record<string, unknown>;
    const code = body.code === "version_conflict" || body.code === "precondition_required" ? body.code : "rejected";
    return {
      ok: false,
      code,
      error: failure.message,
      ...(Array.isArray(body.difference) ? { difference: body.difference as SettingsDifference[] } : {}),
      ...(body.current ? { current: body.current as { etag: string; records: SettingsRecord[] } } : {}),
    };
  }
}

/** The value of a record as the form shows it. */
export function recordValue(record: SettingsRecord): string {
  const value = record.desired.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** The records of one entity of the settings. */
export function recordsOf(view: SettingsView, entity: "herder.env" | "node-config" | "profile"): SettingsRecord[] {
  return view.records.filter((record) => record.id.startsWith(`${entity}/`) || record.id.startsWith("profile/"));
}

/** The base versions the owner edited: the versions of the read. */
export function baseVersions(view: SettingsView, ids: string[]): Record<string, number> {
  const versions: Record<string, number> = {};
  for (const id of ids) {
    const record = view.records.find((candidate) => candidate.id === id);
    if (record) versions[id] = record.desired.desired_revision;
  }
  return versions;
}
