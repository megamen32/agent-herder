import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SETTINGS_STATE_DIR } from "../web/settings-store.js";

const MAX_RECORDS = 128;
const TOKEN_PREFIX = "herder_mcp_";

export type McpClientTokenRecord = {
  id: string;
  name: string;
  createdAt: string;
  revokedAt?: string;
};

type StoredTokenRecord = McpClientTokenRecord & {
  tokenHash: string;
  inputIdHash: string;
};

type StoredState = {
  schemaVersion: 1;
  tokens: StoredTokenRecord[];
};

export class McpClientTokenStore {
  private state?: StoredState;
  private operation: Promise<unknown> = Promise.resolve();

  constructor(readonly path = join(SETTINGS_STATE_DIR, "mcp-client-tokens.json")) {}

  async list(): Promise<McpClientTokenRecord[]> {
    return this.serial(async () => (await this.load()).tokens.map(publicRecord));
  }

  async issue(name: string, inputId: string): Promise<{ token: string; record: McpClientTokenRecord }> {
    return this.serial(async () => {
      const state = await this.load();
      const inputIdHash = hash(inputId);
      const prior = state.tokens.find((record) => record.inputIdHash === inputIdHash);
      if (prior) {
        const error = new Error("issue_already_attempted");
        Object.assign(error, { code: "issue_already_attempted", record: publicRecord(prior) });
        throw error;
      }
      if (state.tokens.length >= MAX_RECORDS) {
        const error = new Error("token_registry_full");
        Object.assign(error, { code: "token_registry_full" });
        throw error;
      }
      const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
      const record: StoredTokenRecord = {
        id: randomUUID(),
        name,
        createdAt: new Date().toISOString(),
        tokenHash: hash(token),
        inputIdHash,
      };
      const next = { schemaVersion: 1 as const, tokens: [...state.tokens, record] };
      await this.persist(next);
      return { token, record: publicRecord(record) };
    });
  }

  async revoke(id: string): Promise<McpClientTokenRecord | undefined> {
    return this.serial(async () => {
      const state = await this.load();
      const current = state.tokens.find((record) => record.id === id);
      if (!current) return undefined;
      if (current.revokedAt) return publicRecord(current);
      const record = { ...current, revokedAt: new Date().toISOString() };
      const next = { schemaVersion: 1 as const, tokens: state.tokens.map((row) => row.id === id ? record : row) };
      await this.persist(next);
      return publicRecord(record);
    });
  }

  async verifyToken(token: string): Promise<McpClientTokenRecord | undefined> {
    if (!token.startsWith(TOKEN_PREFIX) || !/^[A-Za-z0-9_-]{43}$/.test(token.slice(TOKEN_PREFIX.length))) return undefined;
    return this.serial(async () => {
      const digest = Buffer.from(hash(token), "hex");
      const state = await this.load();
      for (const record of state.tokens) {
        if (record.revokedAt) continue;
        const expected = Buffer.from(record.tokenHash, "hex");
        if (expected.length === digest.length && timingSafeEqual(expected, digest)) return publicRecord(record);
      }
      return undefined;
    });
  }

  private async load(): Promise<StoredState> {
    if (this.state) return this.state;
    let raw: string;
    try {
      const metadata = await stat(this.path);
      if ((metadata.mode & 0o077) !== 0) throw new Error("token_registry_permissions_invalid");
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = { schemaVersion: 1, tokens: [] };
        return this.state;
      }
      throw error;
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error("token_registry_invalid"); }
    const root = parsed as Partial<StoredState> | null;
    if (!root || root.schemaVersion !== 1 || !Array.isArray(root.tokens) || root.tokens.length > MAX_RECORDS) throw new Error("token_registry_invalid");
    const tokens: StoredTokenRecord[] = [];
    for (const value of root.tokens) {
      const row = value as Partial<StoredTokenRecord> | null;
      if (!row || typeof row.id !== "string" || typeof row.name !== "string" || typeof row.createdAt !== "string"
        || typeof row.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(row.tokenHash)
        || typeof row.inputIdHash !== "string" || !/^[a-f0-9]{64}$/.test(row.inputIdHash)
        || (row.revokedAt !== undefined && typeof row.revokedAt !== "string")) throw new Error("token_registry_invalid");
      tokens.push({ id: row.id, name: row.name, createdAt: row.createdAt, tokenHash: row.tokenHash, inputIdHash: row.inputIdHash,
        ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}) });
    }
    this.state = { schemaVersion: 1, tokens };
    return this.state;
  }

  private async persist(state: StoredState): Promise<void> {
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

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const current = this.operation.then(work, work);
    this.operation = current.then(() => undefined, () => undefined);
    return current;
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function publicRecord(record: StoredTokenRecord): McpClientTokenRecord {
  return { id: record.id, name: record.name, createdAt: record.createdAt, ...(record.revokedAt ? { revokedAt: record.revokedAt } : {}) };
}

let defaultStore: McpClientTokenStore | undefined;
export function getDefaultMcpClientTokenStore(): McpClientTokenStore {
  return defaultStore ??= new McpClientTokenStore();
}
