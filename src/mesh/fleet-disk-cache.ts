import {createHash} from "node:crypto";
import {mkdir, readdir, readFile, rename, rm, stat, writeFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import type {FleetHost, FleetSession} from "./fleet-contract.js";
import type {SessionInventoryPage} from "./session-page.js";

/**
 * The durable display cache of one fleet cabinet scope.
 *
 * The browser cabinet must answer "which machines exist, which sessions run"
 * from the last known state the moment the page opens; the live fleet
 * discovery then refreshes that answer in the background. This file is that
 * last-known state on disk: it survives a daemon restart, holds no
 * credentials, and is never used to authorize a mutation — the create lane,
 * session control and admission receipts keep reading the live path exactly
 * as before. Records carry only display data (hosts, sessions, page rows,
 * read-only views) plus their own save time.
 */

/** One host bundle of the last published fleet snapshot. */
export interface FleetDiskSnapshotHost {
  host: FleetHost;
  sessions: FleetSession[];
  complete: boolean;
  limited: boolean;
  target: string;
  inventorySupported?: boolean;
}
export interface FleetDiskSnapshotRecord {version: 1; savedAt: number; hosts: FleetDiskSnapshotHost[]}
/** The last first inventory page of one host. */
export interface FleetDiskPageRecord {version: 1; savedAt: number; hostId: string; page: SessionInventoryPage}
/** The last read-only session view of one address. */
export interface FleetDiskSessionRecord {version: 1; savedAt: number; view: unknown}

export interface FleetDiskCacheStore {
  readSnapshot(scopeKey: string): Promise<FleetDiskSnapshotRecord | undefined>;
  writeSnapshot(scopeKey: string, record: FleetDiskSnapshotRecord): Promise<void>;
  readInventoryPage(scopeKey: string, hostId: string): Promise<FleetDiskPageRecord | undefined>;
  writeInventoryPage(scopeKey: string, record: FleetDiskPageRecord): Promise<void>;
  readSessionView(scopeKey: string, address: {hostId: string; harness: string; nativeSessionId: string}): Promise<FleetDiskSessionRecord | undefined>;
  writeSessionView(scopeKey: string, address: {hostId: string; harness: string; nativeSessionId: string}, record: FleetDiskSessionRecord): Promise<void>;
}

const safeSegment = (value: string) => /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : createHash("sha256").update(value).digest("hex");
const sessionFileName = (address: {hostId: string; harness: string; nativeSessionId: string}) =>
  createHash("sha256").update(JSON.stringify([address.hostId, address.harness, address.nativeSessionId])).digest("hex") + ".json";

/** File-backed store: one directory per scope, atomic writes, bounded records,
 * age/count pruning. Every failure degrades to "no cache" and never throws. */
export class FleetFileDiskCache implements FleetDiskCacheStore {
  private writes = 0;
  constructor(
    private readonly root: string,
    private readonly options: {maxRecordBytes?: number; maxAgeMs?: number; maxSessionFiles?: number; now?: () => number} = {},
  ) {}
  private get maxRecordBytes() {return this.options.maxRecordBytes ?? 2 * 1024 * 1024;}
  private get maxAgeMs() {return this.options.maxAgeMs ?? 24 * 60 * 60 * 1000;}
  private get maxSessionFiles() {return this.options.maxSessionFiles ?? 256;}
  private now() {return (this.options.now ?? Date.now)();}

  async readSnapshot(scopeKey: string): Promise<FleetDiskSnapshotRecord | undefined> {
    const parsed = await this.readJson<FleetDiskSnapshotRecord>(join(this.root, safeSegment(scopeKey), "snapshot.json"));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.hosts) || !Number.isFinite(parsed.savedAt)) return undefined;
    return parsed;
  }
  async writeSnapshot(scopeKey: string, record: FleetDiskSnapshotRecord): Promise<void> {
    await this.writeJson(join(this.root, safeSegment(scopeKey), "snapshot.json"), record);
  }
  async readInventoryPage(scopeKey: string, hostId: string): Promise<FleetDiskPageRecord | undefined> {
    const parsed = await this.readJson<FleetDiskPageRecord>(join(this.root, safeSegment(scopeKey), "inventory", `${safeSegment(hostId)}.json`));
    if (!parsed || parsed.version !== 1 || typeof parsed.hostId !== "string" || !Number.isFinite(parsed.savedAt) || !parsed.page || typeof parsed.page !== "object") return undefined;
    return parsed;
  }
  async writeInventoryPage(scopeKey: string, record: FleetDiskPageRecord): Promise<void> {
    await this.writeJson(join(this.root, safeSegment(scopeKey), "inventory", `${safeSegment(record.hostId)}.json`), record);
  }
  async readSessionView(scopeKey: string, address: {hostId: string; harness: string; nativeSessionId: string}): Promise<FleetDiskSessionRecord | undefined> {
    const parsed = await this.readJson<FleetDiskSessionRecord>(join(this.root, safeSegment(scopeKey), "sessions", sessionFileName(address)));
    if (!parsed || parsed.version !== 1 || !Number.isFinite(parsed.savedAt) || !("view" in parsed)) return undefined;
    return parsed;
  }
  async writeSessionView(scopeKey: string, address: {hostId: string; harness: string; nativeSessionId: string}, record: FleetDiskSessionRecord): Promise<void> {
    await this.writeJson(join(this.root, safeSegment(scopeKey), "sessions", sessionFileName(address)), record);
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      const text = await readFile(path, "utf8");
      if (text.length > this.maxRecordBytes * 2) return undefined;
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }
  private async writeJson(path: string, value: unknown): Promise<void> {
    try {
      const text = JSON.stringify(value);
      if (typeof text !== "string" || Buffer.byteLength(text) > this.maxRecordBytes) return;
      await mkdir(dirname(path), {recursive: true});
      const temporary = `${path}.${createHash("sha256").update(text).digest("hex").slice(0, 16)}.tmp`;
      await writeFile(temporary, text, {mode: 0o600});
      await rename(temporary, path);
      this.writes++;
      if (this.writes % 32 === 0) await this.prune();
    } catch {
      /* a failed cache write must never fail the read that produced it */
    }
  }
  /** Bounded cleanup: drop records older than maxAgeMs and the oldest session
   * views beyond the count cap. Only ever touches this cache's own root. */
  private async prune(): Promise<void> {
    try {
      const cutoff = this.now() - this.maxAgeMs;
      const scopes = (await readdir(this.root, {withFileTypes: true})).filter(entry => entry.isDirectory()).map(entry => join(this.root, entry.name));
      for (const scope of scopes) {
        await this.pruneDir(join(scope, "inventory"), cutoff, Number.POSITIVE_INFINITY).catch(() => undefined);
        await this.pruneDir(join(scope, "sessions"), cutoff, this.maxSessionFiles).catch(() => undefined);
      }
    } catch {
      /* pruning is best effort */
    }
  }
  private async pruneDir(directory: string, cutoff: number, keepNewest: number): Promise<void> {
    let entries: Array<{name: string; mtimeMs: number}>;
    try {
      entries = [];
      for (const entry of await readdir(directory, {withFileTypes: true})) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const info = await stat(join(directory, entry.name));
        entries.push({name: entry.name, mtimeMs: info.mtimeMs});
      }
    } catch {
      return;
    }
    const expired = entries.filter(entry => entry.mtimeMs < cutoff).map(entry => join(directory, entry.name));
    const survivors = entries.filter(entry => entry.mtimeMs >= cutoff).sort((a, b) => b.mtimeMs - a.mtimeMs);
    const overflow = survivors.length > keepNewest ? survivors.slice(keepNewest).map(entry => join(directory, entry.name)) : [];
    for (const path of [...expired, ...overflow]) await rm(path, {force: true}).catch(() => undefined);
  }
}
