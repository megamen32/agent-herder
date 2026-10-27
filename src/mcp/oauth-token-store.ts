import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SETTINGS_STATE_DIR } from "../web/settings-store.js";

export const MCP_OAUTH_OWNER_SCOPE = "agent-herder:owner";
export const MCP_OAUTH_OFFLINE_SCOPE = "offline_access";
export const MCP_OAUTH_SCOPES = [MCP_OAUTH_OWNER_SCOPE, MCP_OAUTH_OFFLINE_SCOPE] as const;
const ACCESS_TTL_MS = 15 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_CODE_TTL_MS = 2 * 60 * 1000;
const TRANSACTION_TTL_MS = 10 * 60 * 1000;
const MAX_CLIENTS = 128;
const MAX_CODES = 1024;
const MAX_GRANTS = 512;
const MAX_ACCESS_TOKENS = 4096;
const MAX_REFRESH_TOKENS = 8192;

export type OAuthClient = { clientId: string; clientName: string; redirectUri: string; createdAt: string };
export type OAuthPrincipal = { clientId: string; subject: string; issuer: string; audience: string; scopes: string[]; expiresAt: number };
export type OAuthTokenSet = { accessToken: string; refreshToken: string; expiresIn: number; scope: string };

type Transaction = {
  transactionHash: string; clientId: string; redirectUri: string; codeChallenge: string;
  resource: string; scopes: string[]; stateHash: string; expiresAt: number; consumedAt?: number;
};
type AuthorizationCode = {
  codeHash: string; clientId: string; redirectUri: string; codeChallenge: string;
  resource: string; scopes: string[]; subject: string; expiresAt: number; consumedAt?: number;
};
type Grant = {
  id: string; clientId: string; subject: string; issuer: string; audience: string;
  scopes: string[]; createdAt: number; revokedAt?: number;
};
type AccessToken = { tokenHash: string; grantId: string; expiresAt: number; revokedAt?: number };
type RefreshToken = { tokenHash: string; grantId: string; expiresAt: number; usedAt?: number; revokedAt?: number };
type State = {
  schemaVersion: 1; clients: OAuthClient[]; transactions: Transaction[]; codes: AuthorizationCode[];
  grants: Grant[]; accessTokens: AccessToken[]; refreshTokens: RefreshToken[];
};

const emptyState = (): State => ({ schemaVersion: 1, clients: [], transactions: [], codes: [], grants: [], accessTokens: [], refreshTokens: [] });

/** Hash-only durable records for the public OAuth authorization-code flow. */
export class McpOAuthTokenStore {
  private state?: State;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(readonly path = join(SETTINGS_STATE_DIR, "mcp-oauth-tokens.json"), private readonly now = () => Date.now()) {}

  async registerClient(clientName: string, redirectUri: string): Promise<OAuthClient> {
    return this.serial(async () => {
      const state = await this.load();
      if (state.clients.length >= MAX_CLIENTS) throw new Error("oauth_client_registry_full");
      const client: OAuthClient = {
        clientId: `ahc_${randomBytes(32).toString("base64url")}`,
        clientName,
        redirectUri,
        createdAt: new Date(this.now()).toISOString(),
      };
      await this.persist({ ...state, clients: [...state.clients, client] });
      return client;
    });
  }

  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    return this.serial(async () => (await this.load()).clients.find((client) => safeEqualText(client.clientId, clientId)));
  }

  async createAuthorizationTransaction(input: {
    clientId: string; redirectUri: string; codeChallenge: string; resource: string; scopes: string[]; state: string;
  }): Promise<string> {
    return this.serial(async () => {
      const state = this.prune(await this.load());
      const client = state.clients.find((entry) => safeEqualText(entry.clientId, input.clientId));
      if (!client || client.redirectUri !== input.redirectUri) throw new Error("invalid_client");
      if (state.transactions.length >= MAX_CODES) throw new Error("oauth_transaction_registry_full");
      const handle = randomBytes(32).toString("base64url");
      const transaction: Transaction = {
        transactionHash: hash(handle), clientId: client.clientId, redirectUri: client.redirectUri,
        codeChallenge: input.codeChallenge, resource: input.resource, scopes: [...input.scopes],
        stateHash: hash(input.state), expiresAt: this.now() + TRANSACTION_TTL_MS,
      };
      await this.persist({ ...state, transactions: [...state.transactions, transaction] });
      return handle;
    });
  }

  async approveAuthorizationTransaction(input: { transaction: string; clientId: string; redirectUri: string; state: string; subject: string }): Promise<string> {
    return this.serial(async () => {
      const state = this.prune(await this.load());
      const digest = hash(input.transaction);
      const transaction = state.transactions.find((entry) => safeEqualText(entry.transactionHash, digest));
      const client = state.clients.find((entry) => safeEqualText(entry.clientId, input.clientId));
      if (!transaction || transaction.consumedAt || transaction.expiresAt <= this.now()
        || !client || transaction.clientId !== client.clientId || transaction.redirectUri !== client.redirectUri
        || transaction.redirectUri !== input.redirectUri || !safeEqualText(transaction.stateHash, hash(input.state))) {
        throw new Error("invalid_authorization_transaction");
      }
      if (state.codes.length >= MAX_CODES) throw new Error("oauth_code_registry_full");
      const code = randomBytes(32).toString("base64url");
      const approvedAt = this.now();
      const nextTransaction = { ...transaction, consumedAt: approvedAt };
      const authorizationCode: AuthorizationCode = {
        codeHash: hash(code), clientId: client.clientId, redirectUri: client.redirectUri,
        codeChallenge: transaction.codeChallenge, resource: transaction.resource, scopes: [...transaction.scopes],
        subject: input.subject, expiresAt: approvedAt + AUTH_CODE_TTL_MS,
      };
      await this.persist({
        ...state,
        transactions: state.transactions.map((entry) => entry.transactionHash === transaction.transactionHash ? nextTransaction : entry),
        codes: [...state.codes, authorizationCode],
      });
      return code;
    });
  }

  async exchangeAuthorizationCode(input: { clientId: string; code: string; redirectUri: string; codeVerifier: string; resource: string; issuer: string; scope?: string }): Promise<OAuthTokenSet> {
    return this.serial(async () => {
      const state = this.prune(await this.load());
      const digest = hash(input.code);
      const code = state.codes.find((entry) => safeEqualText(entry.codeHash, digest));
      const client = state.clients.find((entry) => safeEqualText(entry.clientId, input.clientId));
      if (!code || code.consumedAt || code.expiresAt <= this.now() || !client
        || code.clientId !== client.clientId || code.redirectUri !== client.redirectUri || input.redirectUri !== code.redirectUri
        || input.resource !== code.resource || !verifyPkce(input.codeVerifier, code.codeChallenge)
        || (input.scope !== undefined && !sameScopes(input.scope, code.scopes))
        || !code.scopes.includes(MCP_OAUTH_OWNER_SCOPE)) throw new Error("invalid_grant");
      if (state.grants.length >= MAX_GRANTS) throw new Error("oauth_grant_registry_full");
      const grant: Grant = {
        id: randomUUID(), clientId: client.clientId, subject: code.subject, issuer: input.issuer,
        audience: code.resource, scopes: [...code.scopes], createdAt: this.now(),
      };
      const tokens = mintTokens(grant, this.now());
      const next: State = {
        ...state,
        codes: state.codes.map((entry) => entry.codeHash === code.codeHash ? { ...entry, consumedAt: this.now() } : entry),
        grants: [...state.grants, grant], accessTokens: [...state.accessTokens, tokens.accessRecord],
        refreshTokens: [...state.refreshTokens, tokens.refreshRecord],
      };
      await this.persist(this.prune(next));
      return tokens.response;
    });
  }

  async refresh(input: { clientId: string; refreshToken: string; resource: string; issuer: string; scope?: string }): Promise<OAuthTokenSet> {
    return this.serial(async () => {
      const state = this.prune(await this.load());
      const digest = hash(input.refreshToken);
      const token = state.refreshTokens.find((entry) => safeEqualText(entry.tokenHash, digest));
      const grant = token && state.grants.find((entry) => entry.id === token.grantId);
      const client = state.clients.find((entry) => safeEqualText(entry.clientId, input.clientId));
      if (!token || !grant || !client || grant.clientId !== client.clientId || grant.revokedAt
        || grant.issuer !== input.issuer || grant.audience !== input.resource || !grant.scopes.includes(MCP_OAUTH_OFFLINE_SCOPE)) {
        throw new Error("invalid_grant");
      }
      if (input.scope !== undefined && !sameScopes(input.scope, grant.scopes)) throw new Error("invalid_grant");
      if (token.usedAt) {
        const revokedAt = this.now();
        await this.persist({
          ...state,
          grants: state.grants.map((entry) => entry.id === grant.id ? { ...entry, revokedAt } : entry),
          accessTokens: state.accessTokens.map((entry) => entry.grantId === grant.id ? { ...entry, revokedAt } : entry),
          refreshTokens: state.refreshTokens.map((entry) => entry.grantId === grant.id ? { ...entry, revokedAt } : entry),
        });
        throw new Error("invalid_grant");
      }
      if (token.revokedAt || token.expiresAt <= this.now()) throw new Error("invalid_grant");
      if (state.accessTokens.length >= MAX_ACCESS_TOKENS || state.refreshTokens.length >= MAX_REFRESH_TOKENS) throw new Error("oauth_token_registry_full");
      const tokens = mintTokens(grant, this.now());
      await this.persist(this.prune({
        ...state,
        refreshTokens: state.refreshTokens.map((entry) => entry.tokenHash === token.tokenHash ? { ...entry, usedAt: this.now() } : entry).concat(tokens.refreshRecord),
        accessTokens: [...state.accessTokens, tokens.accessRecord],
      }));
      return tokens.response;
    });
  }

  async revoke(input: { clientId: string; token: string }): Promise<void> {
    await this.serial(async () => {
      const state = this.prune(await this.load());
      const client = state.clients.find((entry) => safeEqualText(entry.clientId, input.clientId));
      if (!client) return;
      const digest = hash(input.token);
      const access = state.accessTokens.find((entry) => safeEqualText(entry.tokenHash, digest));
      const refresh = state.refreshTokens.find((entry) => safeEqualText(entry.tokenHash, digest));
      const grantId = access?.grantId ?? refresh?.grantId;
      if (!grantId) return;
      const grant = state.grants.find((entry) => entry.id === grantId);
      if (!grant || grant.clientId !== client.clientId) return;
      const revokedAt = this.now();
      if (refresh) {
        await this.persist({
          ...state,
          grants: state.grants.map((entry) => entry.id === grantId ? { ...entry, revokedAt } : entry),
          accessTokens: state.accessTokens.map((entry) => entry.grantId === grantId ? { ...entry, revokedAt } : entry),
          refreshTokens: state.refreshTokens.map((entry) => entry.grantId === grantId ? { ...entry, revokedAt } : entry),
        });
      } else if (access) {
        await this.persist({ ...state, accessTokens: state.accessTokens.map((entry) => entry.tokenHash === access.tokenHash ? { ...entry, revokedAt } : entry) });
      }
    });
  }

  async verifyAccessToken(token: string, expected: { issuer: string; audience: string; requiredScope?: string }): Promise<OAuthPrincipal | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    return this.serial(async () => {
      const digest = hash(token);
      const state = await this.load();
      let access: AccessToken | undefined;
      for (const candidate of state.accessTokens) {
        if (safeEqualText(candidate.tokenHash, digest)) access = candidate;
      }
      if (!access || access.revokedAt || access.expiresAt <= this.now()) return undefined;
      const grant = state.grants.find((entry) => entry.id === access!.grantId);
      if (!grant || grant.revokedAt || grant.issuer !== expected.issuer || grant.audience !== expected.audience
        || (expected.requiredScope && !grant.scopes.includes(expected.requiredScope))) return undefined;
      return { clientId: grant.clientId, subject: grant.subject, issuer: grant.issuer, audience: grant.audience, scopes: [...grant.scopes], expiresAt: access.expiresAt };
    });
  }

  private async load(): Promise<State> {
    if (this.state) return this.state;
    let raw: string;
    try {
      const metadata = await stat(this.path);
      if ((metadata.mode & 0o077) !== 0) throw new Error("oauth_token_store_permissions_invalid");
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.state = emptyState();
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error("oauth_token_store_invalid"); }
    if (!isState(parsed)) throw new Error("oauth_token_store_invalid");
    return this.state = parsed;
  }

  private async persist(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    let committed = false;
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      committed = true;
      this.state = state;
    } finally {
      await handle.close().catch(() => undefined);
      if (!committed) await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private prune(state: State): State {
    const now = this.now();
    const transactions = state.transactions.filter((entry) => entry.expiresAt > now && !entry.consumedAt);
    const codes = state.codes.filter((entry) => entry.expiresAt > now && !entry.consumedAt);
    const accessTokens = state.accessTokens.filter((entry) => entry.expiresAt > now && !entry.revokedAt);
    const refreshTokens = state.refreshTokens.filter((entry) => entry.expiresAt > now && !entry.revokedAt);
    const retainedGrantIds = new Set([...accessTokens, ...refreshTokens].map((entry) => entry.grantId));
    const grants = state.grants.filter((entry) => !entry.revokedAt && retainedGrantIds.has(entry.id));
    return { ...state, transactions, codes, accessTokens, refreshTokens, grants };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const current = this.operation.then(work, work);
    this.operation = current.then(() => undefined, () => undefined);
    return current;
  }
}

function mintTokens(grant: Grant, now: number): { response: OAuthTokenSet; accessRecord: AccessToken; refreshRecord: RefreshToken } {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  const expiresAt = now + ACCESS_TTL_MS;
  return {
    response: { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), scope: grant.scopes.join(" ") },
    accessRecord: { tokenHash: hash(accessToken), grantId: grant.id, expiresAt },
    refreshRecord: { tokenHash: hash(refreshToken), grantId: grant.id, expiresAt: now + REFRESH_TTL_MS },
  };
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function verifyPkce(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return false;
  return safeEqualText(pkceS256(verifier), challenge);
}

function sameScopes(value: string, expected: string[]): boolean {
  const scopes = value.split(/\s+/).filter(Boolean);
  return scopes.length === expected.length && new Set(scopes).size === scopes.length
    && scopes.every((scope) => expected.includes(scope));
}

function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function safeEqualText(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function isState(value: unknown): value is State {
  if (!isRecord(value)) return false;
  const state = value as Partial<State>;
  return state.schemaVersion === 1
    && boundedArray(state.clients, MAX_CLIENTS, (row) => isRecord(row) && isClientId(row.clientId)
      && isText(row.clientName, 80) && isText(row.redirectUri, 512) && isText(row.createdAt, 40))
    && boundedArray(state.transactions, MAX_CODES, (row) => isRecord(row) && isHash(row.transactionHash)
      && isClientId(row.clientId) && isText(row.redirectUri, 512) && isPkceChallenge(row.codeChallenge)
      && isText(row.resource, 512) && isScopes(row.scopes) && isHash(row.stateHash) && isTime(row.expiresAt) && isOptionalTime(row.consumedAt))
    && boundedArray(state.codes, MAX_CODES, (row) => isRecord(row) && isHash(row.codeHash)
      && isClientId(row.clientId) && isText(row.redirectUri, 512) && isPkceChallenge(row.codeChallenge)
      && isText(row.resource, 512) && isScopes(row.scopes) && isText(row.subject, 128) && isTime(row.expiresAt) && isOptionalTime(row.consumedAt))
    && boundedArray(state.grants, MAX_GRANTS, (row) => isRecord(row) && isText(row.id, 64)
      && isClientId(row.clientId) && isText(row.subject, 128) && isText(row.issuer, 512) && isText(row.audience, 512)
      && isScopes(row.scopes) && isTime(row.createdAt) && isOptionalTime(row.revokedAt))
    && boundedArray(state.accessTokens, MAX_ACCESS_TOKENS, (row) => isRecord(row) && isHash(row.tokenHash)
      && isText(row.grantId, 64) && isTime(row.expiresAt) && isOptionalTime(row.revokedAt))
    && boundedArray(state.refreshTokens, MAX_REFRESH_TOKENS, (row) => isRecord(row) && isHash(row.tokenHash)
      && isText(row.grantId, 64) && isTime(row.expiresAt) && isOptionalTime(row.usedAt) && isOptionalTime(row.revokedAt));
}

function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function isText(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function isHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function isClientId(value: unknown): value is string { return typeof value === "string" && /^ahc_[A-Za-z0-9_-]{43}$/.test(value); }
function isPkceChallenge(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
function isTime(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isOptionalTime(value: unknown): value is number | undefined { return value === undefined || isTime(value); }
function isScopes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && new Set(value).size === value.length
    && value.every((scope) => typeof scope === "string" && MCP_OAUTH_SCOPES.includes(scope as typeof MCP_OAUTH_SCOPES[number]));
}
function boundedArray(value: unknown, max: number, validate: (entry: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length <= max && value.every(validate);
}

let defaultStore: McpOAuthTokenStore | undefined;
export function getDefaultMcpOAuthTokenStore(): McpOAuthTokenStore {
  return defaultStore ??= new McpOAuthTokenStore();
}
