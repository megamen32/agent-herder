type NativeRecord = Record<string, unknown>;

export interface TrustedAdmissionHooks {
  generation(): number;
  ready(): boolean;
  locallyBusy(threadId: string): boolean;
  externalGuard?(threadId: string): Promise<boolean>;
  request(method: string, params: NativeRecord, beforeWrite?: () => void): Promise<unknown>;
}

function record(value: unknown, label: string): NativeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`trusted transport invalid ${label}`);
  return value as NativeRecord;
}

/** Acknowledged configuration belongs to one native connection generation.
 * A cold runtime must be checked again after native GC. A loaded runtime with
 * unknown configuration is never modified to make a read/attach succeed.
 */
export class CodexTrustedAdmission {
  private readonly applied = new Map<string, { generation: number; modelProvider: string }>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly revisions = new Map<string, number>();
  private resetRevision = 0;

  forget(threadId?: string): void {
    if (threadId === undefined) {
      this.applied.clear();
      this.resetRevision++;
    } else if (this.applied.has(threadId) || this.tails.has(threadId)) {
      this.applied.delete(threadId);
      this.revisions.set(threadId, (this.revisions.get(threadId) ?? 0) + 1);
    }
  }

  async resume(threadId: string, config: Readonly<NativeRecord>, params: NativeRecord,
    hooks: TrustedAdmissionHooks, allowCold = true): Promise<unknown> {
    // The lock covers observation, the actual resume RPC and its receipt.
    // Sharing just a preflight promise would admit two concurrent writers.
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.tails.set(threadId, tail);
    await previous;
    try {
      const generation = hooks.generation();
      const resetRevision = this.resetRevision;
      const revision = this.revisions.get(threadId) ?? 0;
      const current = () => {
        if (hooks.generation() !== generation || !hooks.ready() || resetRevision !== this.resetRevision
            || revision !== (this.revisions.get(threadId) ?? 0)) {
          throw new Error("trusted transport native generation changed");
        }
      };
      current();
      const loaded = await this.isLoaded(threadId, hooks, current);
      const read = record(await hooks.request("thread/read", { threadId, includeTurns: false }), "thread read");
      current();
      const thread = record(read.thread, "thread");
      if (thread.id !== threadId || typeof thread.modelProvider !== "string" || !thread.modelProvider) {
        throw new Error("trusted transport native identity or saved provider is unavailable");
      }
      if (params.threadId !== threadId || (params.modelProvider !== undefined && params.modelProvider !== thread.modelProvider)) {
        throw new Error("trusted transport saved provider or thread mismatch");
      }
      if (Object.hasOwn(params, "config")) throw new Error("trusted transport caller cannot supply configuration");
      let applying = false;
      const status = typeof thread.status === "string" ? thread.status : record(thread.status, "thread status").type;
      if (loaded) {
        const applied = this.applied.get(threadId);
        if (applied?.generation !== generation || applied.modelProvider !== thread.modelProvider) {
          this.applied.delete(threadId);
          throw new Error("trusted transport loaded thread has no acknowledged configuration in this generation");
        }
        if (!["idle", "active", "systemError", "running", "inProgress", "completed", "failed", "interrupted"].includes(String(status))) {
          throw new Error("trusted transport loaded native status changed or is unknown");
        }
      } else {
        this.applied.delete(threadId);
        if (!allowCold) throw new Error("trusted transport attach cannot load a cold thread");
        const flags = typeof thread.status === "object" && thread.status !== null
          ? record(thread.status, "thread status").activeFlags : undefined;
        if (status !== "notLoaded" || (flags !== undefined && (!Array.isArray(flags) || flags.length !== 0))
            || thread.activeTurnId || hooks.locallyBusy(threadId)) {
          throw new Error("trusted transport requires a writer-free cold native thread");
        }
        const turns = record(await hooks.request("thread/turns/list", {
          threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
        }), "latest turn");
        current();
        if (!Array.isArray(turns.data) || turns.data.length > 1) throw new Error("trusted transport latest turn is unavailable");
        if (!turns.data.length && turns.nextCursor !== undefined && turns.nextCursor !== null) {
          throw new Error("trusted transport latest turn page is incomplete");
        }
        if (turns.data.length) {
          const last = record(turns.data[0], "latest turn");
          if (typeof last.id !== "string" || !last.id || !["completed", "failed", "interrupted"].includes(String(last.status))) {
            throw new Error("trusted transport native turn is active or unknown");
          }
        }
        const queue = record(await hooks.request("thread/queue/list", { threadId, limit: 1 }), "queue");
        current();
        if (!Array.isArray(queue.data) || queue.data.length || (queue.nextCursor !== undefined && queue.nextCursor !== null)) {
          throw new Error("trusted transport native queue is pending or unknown");
        }
        if (hooks.externalGuard && !await hooks.externalGuard(threadId)) {
          throw new Error("trusted transport external admission guard refused");
        }
        current();
        if (hooks.locallyBusy(threadId)) throw new Error("trusted transport writer changed during preflight");
        applying = true;
      }
      const beforeWrite = () => {
        current();
        if (applying && hooks.locallyBusy(threadId)) throw new Error("trusted transport writer changed before resume");
      };
      beforeWrite();
      const result = await hooks.request("thread/resume", {
        ...params, modelProvider: thread.modelProvider, ...(applying ? { config } : {}),
      }, beforeWrite);
      current();
      const resumed = record(record(result, "resume receipt").thread, "resumed thread");
      if (resumed.id !== threadId || resumed.modelProvider !== thread.modelProvider) {
        throw new Error("trusted transport resume receipt identity mismatch");
      }
      if (applying) this.applied.set(threadId, { generation, modelProvider: thread.modelProvider });
      return result;
    } catch (error) {
      // Cold application removed the old evidence before the RPC, so a lost
      // first receipt can never become an acknowledgement. A hot operation
      // sent no config; its read/quota error does not revoke a prior receipt.
      // Connection changes and native close notifications invalidate it.
      throw error;
    } finally {
      release();
      if (this.tails.get(threadId) === tail) this.tails.delete(threadId);
    }
  }

  private async isLoaded(threadId: string, hooks: TrustedAdmissionHooks, current: () => void): Promise<boolean> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let pages = 0; pages < 100; pages++) {
      const page = record(await hooks.request("thread/loaded/list", { limit: 100, ...(cursor ? { cursor } : {}) }), "loaded page");
      current();
      if (!Array.isArray(page.data) || page.data.some(id => typeof id !== "string" || !id)) {
        throw new Error("trusted transport loaded thread identities are unavailable");
      }
      if (page.nextCursor !== undefined && page.nextCursor !== null && (typeof page.nextCursor !== "string" || !page.nextCursor)) {
        throw new Error("trusted transport loaded pagination is invalid");
      }
      if (page.data.includes(threadId)) return true;
      if (page.nextCursor === undefined || page.nextCursor === null) return false;
      cursor = page.nextCursor as string;
      if (seen.has(cursor)) throw new Error("trusted transport loaded pagination repeated");
      seen.add(cursor);
    }
    throw new Error("trusted transport loaded pagination budget exceeded");
  }
}
