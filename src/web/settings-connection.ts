/**
 * The connection of the herder to the Notice Place.
 *
 * The integration is isolated: every product keeps its own part of the
 * connection in its own store, and there is no shared env file. The herder
 * keeps the address of the center, the purpose of the integration, the
 * permissions the owner granted and the fact that the connection was
 * revoked.
 *
 * The token of the service account is a secret of the product: it lives in
 * the file of the product and never leaves the server. The record of the
 * connection names it by its fingerprint only.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The state of the connection of the herder to the center. */
export type SettingsConnectionState = "connected" | "revoked";

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
   * allowed and then taken away is part of the history of the product.
   */
  async revoke(): Promise<SettingsConnection> {
    const current = await this.read();
    if (!current) throw new Error("there is no connection to revoke");
    const revoked: SettingsConnection = { ...current, state: "revoked", revokedAt: this.now().toISOString() };
    await this.write(revoked);
    return revoked;
  }
}

/**
 * The check of a connection.
 *
 * The check asks the center whether it answers and whether it accepts the
 * authorization of the service account. It is a read of the readiness of the
 * center: it starts no executor of the herder and it creates no event in the
 * center.
 *
 * The compatibility of the release of the center with the purpose and the
 * operation id is not proven by a probe: it is proved by the pairing release
 * of the center, and the check says so instead of promising it.
 */
export async function probeConnection(input: {
  centerUrl: string;
  purpose: string;
  token?: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<SettingsConnectionCheck> {
  const now = input.now ?? (() => new Date());
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.centerUrl.trim().replace(/\/+$/, "");
  const url = `${base}/health`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (input.token && input.token.trim()) headers.authorization = `Bearer ${input.token.trim()}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(input.timeoutMs ?? 8_000),
    });
  } catch (error) {
    return {
      reachable: false,
      authorized: false,
      compatible: false,
      detail: `центр не ответил: ${(error as Error).message}`,
      checkedAt: now().toISOString(),
    };
  }
  const status = response.status;
  if (status === 401 || status === 403) {
    return {
      reachable: true,
      authorized: false,
      compatible: false,
      detail: "центр отказал в авторизации сервисной учётной записи herder",
      status,
      checkedAt: now().toISOString(),
    };
  }
  if (status === 404 || status === 405) {
    return {
      reachable: true,
      authorized: true,
      compatible: false,
      detail: "центр ответил, но не знает эту точку проверки — совместимость подтверждает только сопряжение с релизом центра",
      status,
      checkedAt: now().toISOString(),
    };
  }
  if (status >= 200 && status < 300) {
    return {
      reachable: true,
      authorized: true,
      compatible: false,
      detail: "центр ответил и принял авторизацию; совместимость по purpose и operation_id подтверждает только сопряжение с релизом центра",
      status,
      checkedAt: now().toISOString(),
    };
  }
  return {
    reachable: true,
    authorized: true,
    compatible: false,
    detail: `центр ответил статусом ${status}`,
    status,
    checkedAt: now().toISOString(),
  };
}
