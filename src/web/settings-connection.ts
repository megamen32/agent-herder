/**
 * The connection of the herder to the Notice Place.
 *
 * The integration is isolated: every product keeps its own part of the
 * connection in its own store, and there is no shared env file. The herder
 * keeps the address of the center, the purpose of the integration, the
 * permissions the owner granted and the fact that the connection was revoked.
 *
 * The token of the service account is a secret of the product: it lives in
 * the file of the product and never leaves the server. The record of the
 * connection names it by its fingerprint only.
 *
 * The check of the connection reads the state of the center and nothing else.
 * It starts no executor of the herder, it opens no session and it creates no
 * event in the center. It keeps three answers apart — the center answered,
 * the center took the credential, the center and the herder speak one
 * contract — and it never turns a missing answer into a success.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { NOTICEPLACE_HEALTH_PURPOSE } from "../automation/noticeplace-health-launch.js";

/** The state of the connection of the herder to the center. */
export type SettingsConnectionState = "connected" | "revoked";

/**
 * The contract of the center the herder knows.
 *
 * The center describes its own contract without a key: the marker of the
 * version is the proof that the center speaks the contract the herder
 * expects. A center of another version answers with another marker, and the
 * check says so instead of promising compatibility.
 */
export const CENTER_CONTRACT_SCHEMA = "noticeplace.instructions.v1";

/** The contract of the health endpoint of the center. */
export const CENTER_HEALTH_SCHEMA = "notify.health.v1";

/**
 * One connection of the herder to a center.
 *
 * The record names what the owner granted and when. It never carries the
 * token of the service account: the token lives in the file of the product
 * and is named here by its fingerprint only.
 */
export interface SettingsConnection {
  /** The address of the center. */
  centerUrl: string;
  /** The purpose of the integration: the center checks it. */
  purpose: string;
  /** The permissions the owner granted to the integration. */
  permissions: string[];
  /** Whether the connection is active. */
  state: SettingsConnectionState;
  /** When the owner confirmed the connection. */
  connectedAt: string;
  /** When the owner revoked the connection. */
  revokedAt: string | null;
  /** The fingerprint of the token of the service account. */
  tokenFingerprint?: string;
}

/** The answer of the check of a connection. */
export interface SettingsConnectionCheck {
  /** Whether the address of the center answered at all. */
  reachable: boolean;
  /** Whether the authorization of the integration was accepted. */
  authorized: boolean;
  /** Whether the center showed that it understands the purpose and the operation id. */
  compatible: boolean;
  /** What the probe saw, in words. Never a token. */
  detail: string;
  /** The status the center answered with, when it answered. */
  status?: number;
  /** When the probe was made. */
  checkedAt: string;
  /** The contract of the center, as the center named it. Never a secret. */
  centerSchema?: string;
  /** The readiness of the center, as the center named it. */
  centerStatus?: string;
  /** Whether the herder accepts the purpose of the connection. */
  purposeAccepted?: boolean;
  /** The project the herder acts for in the center. */
  project?: string;
}

/**
 * Whether the center still gets the permission of the herder.
 *
 * The record of the connection is the only authority: a revoked connection
 * grants nothing, and a connection that was never confirmed grants nothing
 * either. The route of the launch asks this function before it lets the
 * center start an executor.
 */
export function grantsLaunch(connection: SettingsConnection | null): boolean {
  return connection?.state === "connected";
}

/** The store of the connections of the herder. */
export class SettingsConnectionStore {
  private readonly stateDir: string;
  private readonly now: () => Date;

  constructor(options: { stateDir: string; now?: () => Date }) {
    this.stateDir = options.stateDir;
    this.now = options.now ?? (() => new Date());
  }

  /** The file of the connections of the herder. */
  get filePath(): string {
    return join(this.stateDir, "connections.json");
  }

  /** The current connection of the herder, when there is one. */
  async read(): Promise<SettingsConnection | null> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as SettingsConnection;
      }
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Write the connection of the herder. */
  async write(connection: SettingsConnection): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  /**
   * Confirm the connection of the herder to the center.
   *
   * A new confirmation replaces the old one: the owner grants the permissions
   * again, and the record says when.
   */
  async connect(input: { centerUrl: string; purpose: string; permissions: string[]; tokenFingerprint?: string }): Promise<SettingsConnection> {
    const connection: SettingsConnection = {
      centerUrl: input.centerUrl.trim().replace(/\/+$/, ""),
      purpose: input.purpose.trim(),
      permissions: input.permissions,
      state: "connected",
      connectedAt: this.now().toISOString(),
      revokedAt: null,
      ...(input.tokenFingerprint ? { tokenFingerprint: input.tokenFingerprint } : {}),
    };
    await this.write(connection);
    return connection;
  }

  /**
   * Revoke the connection of the herder.
   *
   * The revocation is kept in the record: the fact that the integration was
   * allowed and then taken away is part of the history of the product. The
   * record is the authority the route of the launch asks before it lets the
   * center start an executor.
   */
  async revoke(): Promise<SettingsConnection> {
    const current = await this.read();
    if (!current) throw new Error("there is no connection to revoke");
    const revoked: SettingsConnection = { ...current, state: "revoked", revokedAt: this.now().toISOString() };
    await this.write(revoked);
    return revoked;
  }

  /** Whether the center still gets the permission of the herder. */
  async grantsLaunch(): Promise<boolean> {
    return grantsLaunch(await this.read());
  }
}

/** The answer of one leg of the check. */
interface ProbeLeg {
  /** Whether the center answered with a success. */
  ok: boolean;
  /** The status the center answered with, when it answered. */
  status?: number;
  /** The body of the answer, when it was a JSON object. */
  body?: Record<string, unknown>;
  /** Why the center did not answer at all. */
  error?: string;
}

/**
 * One read of the center.
 *
 * The read is a GET and nothing else: no body is sent, no event is created
 * in the center and no executor of the herder starts. The key of the service
 * account goes in the header of the read and never leaves the server.
 */
async function readCenter(url: string, options: {
  authorization?: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<ProbeLeg> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.authorization) headers.authorization = `Bearer ${options.authorization}`;
  let response: Response;
  try {
    response = await options.fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  let body: Record<string, unknown> | undefined;
  try {
    const text = await response.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body };
}

/**
 * The check of a connection.
 *
 * The check asks the center three questions and keeps the answers apart:
 *
 * - the readiness of the center and its health contract (`GET /health`);
 * - the credential of the service account: the center takes it for the
 *   project of the herder (`GET /v1/mutes`, a read that changes nothing);
 * - the contract of the center (`GET /v1/instructions`, the center names its
 *   own contract without a key).
 *
 * The purpose is checked on the herder's side: the route of the launch takes
 * the analysis of an incident and nothing else, so a connection to another
 * purpose is not compatible with the health path of the herder.
 *
 * The check starts no executor of the herder, opens no session and creates no
 * event in the center.
 */
export async function probeConnection(input: {
  centerUrl: string;
  purpose: string;
  token?: string;
  project?: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SettingsConnectionCheck> {
  const now = input.now ?? (() => new Date());
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 8_000;
  const base = input.centerUrl.trim().replace(/\/+$/, "");
  const bearer = input.token?.trim() ? input.token.trim() : undefined;
  const project = (input.project ?? process.env.NOTIFY_CENTER_PROJECT ?? "").trim();
  const purpose = input.purpose.trim();

  // The purpose is the herder's own part of the contract.
  const purposeAccepted = purpose === NOTICEPLACE_HEALTH_PURPOSE;

  let reachable = false;
  let authorized = false;
  let healthSchema: string | undefined;
  let contractSchema: string | undefined;
  let centerStatus: string | undefined;
  let refusal: string | undefined;
  let status: number | undefined;

  // The first leg: the readiness of the center. The key of the health
  // endpoint of the center is a secret of its own, so a refusal here does not
  // mean that the credential of the connection is bad.
  const health = await readCenter(`${base}/health`, {
    ...(bearer ? { authorization: bearer } : {}),
    fetchImpl,
    timeoutMs,
  });
  if (health.status !== undefined) reachable = true;
  if (health.ok && health.body) {
    authorized = true;
    status = health.status;
    if (typeof health.body.schema === "string") healthSchema = health.body.schema;
    if (typeof health.body.status === "string") centerStatus = health.body.status;
  } else if (health.status === 401 || health.status === 403) {
    refusal = "центр не принял ключ на /health — это отдельный ключ чтения состояния центра";
  }

  // The second leg: the credential of the connection. The center takes it for
  // the project of the herder, and the read changes nothing in the center.
  if (!authorized) {
    if (!project) {
      refusal = refusal ?? "проект herder в центре не известен — авторизация ключа не подтверждена";
    } else {
      const scoped = await readCenter(`${base}/v1/mutes?project=${encodeURIComponent(project)}`, {
        ...(bearer ? { authorization: bearer } : {}),
        fetchImpl,
        timeoutMs,
      });
      if (scoped.status !== undefined) reachable = true;
      if (scoped.ok) {
        authorized = true;
        status = scoped.status;
        refusal = undefined;
      } else if (scoped.status === 401 || scoped.status === 403) {
        status = scoped.status;
        refusal = "центр отказал в ключе сервисной учётной записи";
      } else if (scoped.status === 400) {
        status = scoped.status;
        refusal = "центр не принял проект — авторизация ключа не подтверждена";
      } else if (scoped.status === 404 || scoped.status === 405) {
        status = scoped.status;
        refusal = "центр не знает точку проверки ключа — авторизация не подтверждена";
      } else if (scoped.status !== undefined) {
        status = scoped.status;
        refusal = `центр ответил статусом ${scoped.status}`;
      }
    }
  }

  // The third leg: the contract of the center, named by the center itself.
  const contract = await readCenter(`${base}/v1/instructions`, { fetchImpl, timeoutMs });
  if (contract.status !== undefined) reachable = true;
  if (contract.ok && contract.body && typeof contract.body.schema === "string") {
    contractSchema = contract.body.schema;
  }

  const centerSchema = contractSchema ?? healthSchema;
  const knownContract = centerSchema === CENTER_CONTRACT_SCHEMA || centerSchema === CENTER_HEALTH_SCHEMA;
  const compatible = knownContract && purposeAccepted;

  if (!reachable) {
    return {
      reachable: false,
      authorized: false,
      compatible: false,
      detail: `центр не ответил: ${health.error ?? "нет ответа"}`,
      checkedAt: now().toISOString(),
      purposeAccepted,
      ...(project ? { project } : {}),
    };
  }

  const facts: string[] = [];
  if (authorized) {
    facts.push(project ? `ключ принят для проекта ${project}` : "ключ принят центром");
  } else {
    facts.push(refusal ?? "ключ не подтверждён центром");
  }
  facts.push(centerSchema ? `контракт центра — ${centerSchema}` : "контракт центра не подтверждён");
  facts.push(purposeAccepted
    ? `цель «${purpose}» herder принимает`
    : `цель «${purpose}» herder не принимает — маршрут запуска берёт только ${NOTICEPLACE_HEALTH_PURPOSE}`);
  facts.push("проверка только читала состояние: исполнитель не запускался, событие в центре не создавалось");

  return {
    reachable: true,
    authorized,
    compatible,
    detail: `${facts.join("; ")}.`,
    ...(status !== undefined ? { status } : {}),
    checkedAt: now().toISOString(),
    purposeAccepted,
    ...(centerSchema ? { centerSchema } : {}),
    ...(centerStatus ? { centerStatus } : {}),
    ...(project ? { project } : {}),
  };
}
