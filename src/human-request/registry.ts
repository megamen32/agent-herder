import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type HumanRequestKind = "user" | "secret";
export type HumanRequestStatus = "pending" | "resolved";

export interface HumanRequestTarget {
  harness: string;
  sessionId: string;
}

export interface CreateHumanRequestInput {
  kind: HumanRequestKind;
  target: HumanRequestTarget;
  /** Provider-owned opaque correlation handle; never a prompt or secret. */
  contextRef?: string;
  /** Explicit Notify event tuple. Agent Herder does not choose any of these values. */
  notify?: NotifyRoutingTupleInput;
}

export interface NotifyRoutingTupleInput {
  project: string;
  recipient: string;
  kind: string;
  severity: string;
  title: string;
}

export interface NotifyRoutingTuple extends NotifyRoutingTupleInput {
  dedupKey: string;
  incidentId?: string;
}

export interface HumanRequestResolution {
  /** The existing harness transport should continue the bound session. */
  continuation: "resume";
  /** Provider-owned opaque handle, such as an SSS answer reference. */
  resolutionRef?: string;
}

export interface HumanRequestRecord {
  requestId: string;
  kind: HumanRequestKind;
  target: HumanRequestTarget;
  contextRef?: string;
  status: HumanRequestStatus;
  continuation: "resume";
  resolutionRef?: string;
  createdAt: string;
  resolvedAt?: string;
  notify?: NotifyRoutingTuple;
}

interface RegistryFile {
  version: 1;
  requests: HumanRequestRecord[];
}

const FORBIDDEN_FIELDS = new Set([
  "answer", "body", "content", "payload", "plaintext", "response", "result", "secret", "value",
]);

function rejectPayloadFields(value: unknown, path = "input"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPayloadFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) {
      throw new Error(`${path}.${key} is not accepted; store an opaque reference instead`);
    }
    rejectPayloadFields(child, `${path}.${key}`);
  }
}

function opaqueRef(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 512) {
    throw new Error(`${field} must be a non-empty opaque reference (max 512 characters)`);
  }
  return value;
}

function targetOf(target: HumanRequestTarget): HumanRequestTarget {
  if (!target || typeof target !== "object") throw new Error("target is required");
  if (typeof target.harness !== "string" || target.harness.trim().length === 0 || target.harness.length > 128) {
    throw new Error("target.harness must be a non-empty identifier");
  }
  if (typeof target.sessionId !== "string" || target.sessionId.trim().length === 0 || target.sessionId.length > 512) {
    throw new Error("target.sessionId must be a non-empty identifier");
  }
  return { harness: target.harness, sessionId: target.sessionId };
}

function notifyOf(input: NotifyRoutingTupleInput | undefined, requestId: string): NotifyRoutingTuple | undefined {
  if (input === undefined) return undefined;
  rejectPayloadFields(input);
  for (const field of ["project", "recipient", "kind", "severity", "title"] as const) {
    if (typeof input[field] !== "string" || input[field].trim().length === 0 || input[field].length > 512) {
      throw new Error(`notify.${field} must be supplied by the caller`);
    }
  }
  return { ...input, dedupKey: `human-request:${requestId}` };
}

function validateRecord(record: HumanRequestRecord): HumanRequestRecord {
  rejectPayloadFields(record);
  if (!record || typeof record.requestId !== "string" || record.requestId.length < 1) throw new Error("invalid request record");
  if (record.kind !== "user" && record.kind !== "secret") throw new Error("invalid request kind");
  if (record.status !== "pending" && record.status !== "resolved") throw new Error("invalid request status");
  targetOf(record.target);
  opaqueRef(record.contextRef, "contextRef");
  opaqueRef(record.resolutionRef, "resolutionRef");
  if (record.notify) {
    notifyOf(record.notify, record.requestId);
    if (record.notify.dedupKey !== `human-request:${record.requestId}`) throw new Error("invalid Notify dedupKey");
    if (record.notify.incidentId !== undefined) opaqueRef(record.notify.incidentId, "notify.incidentId");
  }
  if (record.status === "resolved" && !record.resolvedAt) throw new Error("resolved request is missing resolvedAt");
  return record;
}

/** Durable correlation registry. It stores routing metadata and opaque refs only. */
export class HumanRequestRegistry {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async create(input: CreateHumanRequestInput): Promise<HumanRequestRecord> {
    rejectPayloadFields(input);
    if (input.kind !== "user" && input.kind !== "secret") throw new Error("kind must be user or secret");
    const target = targetOf(input.target);
    const contextRef = opaqueRef(input.contextRef, "contextRef");
    return this.serial(async () => {
      const file = await this.read();
      const record: HumanRequestRecord = {
        requestId: randomUUID(),
        kind: input.kind,
        target,
        ...(contextRef ? { contextRef } : {}),
        status: "pending",
        continuation: "resume",
        createdAt: new Date().toISOString(),
        ...(input.notify ? { notify: notifyOf(input.notify, "pending") } : {}),
      };
      if (record.notify) record.notify.dedupKey = `human-request:${record.requestId}`;
      file.requests.push(record);
      await this.write(file);
      return record;
    });
  }

  async get(requestId: string): Promise<HumanRequestRecord | null> {
    if (typeof requestId !== "string" || requestId.trim().length === 0) throw new Error("requestId is required");
    const record = (await this.read()).requests.find((item) => item.requestId === requestId);
    return record ? { ...record, target: { ...record.target } } : null;
  }

  async resolve(requestId: string, resolution: HumanRequestResolution): Promise<HumanRequestRecord> {
    rejectPayloadFields(resolution);
    if (resolution.continuation !== "resume") throw new Error("continuation must be resume");
    const resolutionRef = opaqueRef(resolution.resolutionRef, "resolutionRef");
    return this.serial(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (record.status !== "pending") throw new Error(`Human request '${requestId}' is already resolved`);
      record.status = "resolved";
      record.resolvedAt = new Date().toISOString();
      if (resolutionRef) record.resolutionRef = resolutionRef;
      await this.write(file);
      return { ...record, target: { ...record.target } };
    });
  }

  /** Persist the incident id returned by Notify after its event is accepted. */
  async bindNotifyIncident(requestId: string, incidentId: string): Promise<HumanRequestRecord> {
    const checkedIncidentId = opaqueRef(incidentId, "incidentId");
    return this.serial(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (!record.notify) throw new Error(`Human request '${requestId}' has no explicit Notify tuple`);
      record.notify.incidentId = checkedIncidentId;
      await this.write(file);
      return { ...record, target: { ...record.target }, notify: { ...record.notify } };
    });
  }

  private async read(): Promise<RegistryFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as RegistryFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.requests)) throw new Error("invalid registry version");
      parsed.requests.forEach(validateRecord);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, requests: [] };
      throw error;
    }
  }

  private async write(file: RegistryFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = join(dirname(this.filePath), `.${filePathName(this.filePath)}.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function filePathName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1) || "registry";
}
