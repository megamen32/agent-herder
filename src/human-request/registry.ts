import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { herderEvents, type HerderEventBus } from "../herder-events.js";
import { humanRequestResourceUri } from "../herder-resource-uris.js";

export type HumanRequestKind = "user" | "secret";
export type HumanRequestStatus = "pending" | "resuming" | "resumed" | "resume_failed";

export interface HumanRequestTarget {
  readonly agent?: string;
  readonly harness?: string;
  sessionId: string;
  readonly cwd?: string;
  readonly marker?: string;
  /** Immutable harness-owned locator; required for Hermes exact-session wake. */
  readonly locator?: Readonly<Record<string, unknown>>;
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

export interface ResumeAttemptResult {
  /** Provider-owned opaque result or failure receipt; never a payload. */
  receipt?: string;
}

export interface ResumeClaimInput {
  attemptId?: string;
  resultRef?: string;
}

export interface ResumeCompletionInput {
  attemptId: string;
  receipt?: string;
}

export interface HumanRequestRecord {
  requestId: string;
  kind: HumanRequestKind;
  target: HumanRequestTarget;
  contextRef?: string;
  status: HumanRequestStatus;
  continuation: "resume";
  resolutionRef?: string;
  resultRef?: string;
  attemptId?: string;
  receipt?: string;
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
  const agent = target.agent || target.harness;
  if (typeof agent !== "string" || agent.trim().length === 0 || agent.length > 128) {
    throw new Error("target.agent must be a non-empty identifier");
  }
  if (typeof target.sessionId !== "string" || target.sessionId.trim().length === 0 || target.sessionId.length > 512) {
    throw new Error("target.sessionId must be a non-empty identifier");
  }
  if (target.cwd !== undefined && (typeof target.cwd !== "string" || target.cwd.trim().length === 0 || target.cwd.length > 4096)) {
    throw new Error("target.cwd must be a non-empty path");
  }
  if (target.marker !== undefined) opaqueRef(target.marker, "target.marker");
  if (target.locator !== undefined && (!target.locator || typeof target.locator !== "object" || Array.isArray(target.locator))) {
    throw new Error("target.locator must be an object");
  }
  const locator = target.locator ? Object.freeze({ ...target.locator }) : undefined;
  return Object.freeze({ agent, ...(target.harness ? { harness: target.harness } : {}), sessionId: target.sessionId, ...(target.cwd ? { cwd: target.cwd } : {}), ...(target.marker ? { marker: target.marker } : {}), ...(locator ? { locator } : {}) });
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
  if (record.status !== "pending" && record.status !== "resuming" && record.status !== "resumed" && record.status !== "resume_failed") throw new Error("invalid request status");
  targetOf(record.target);
  opaqueRef(record.contextRef, "contextRef");
  opaqueRef(record.resolutionRef, "resolutionRef");
  opaqueRef(record.resultRef, "resultRef");
  opaqueRef(record.attemptId, "attemptId");
  opaqueRef(record.receipt, "receipt");
  if (record.notify) {
    notifyOf(record.notify, record.requestId);
    if (record.notify.dedupKey !== `human-request:${record.requestId}`) throw new Error("invalid Notify dedupKey");
    if (record.notify.incidentId !== undefined) opaqueRef(record.notify.incidentId, "notify.incidentId");
  }
  if (record.status === "resumed" || record.status === "resume_failed") {
    if (!record.resolvedAt) throw new Error("terminal request is missing resolvedAt");
    if (!record.attemptId) throw new Error("terminal request is missing attemptId");
  }
  return record;
}

/** Durable correlation registry. It stores routing metadata and opaque refs only. */
export class HumanRequestRegistry {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly events: HerderEventBus = herderEvents) {}

  private publishRequest(requestId: string, action: "created" | "updated"): void {
    this.events.publish({ kind: "human-request", uri: "herder://human-requests", action, id: requestId });
    this.events.publish({ kind: "human-request", uri: humanRequestResourceUri(requestId), action, id: requestId });
  }

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
      this.publishRequest(record.requestId, "created");
      return record;
    });
  }

  async list(status?: HumanRequestStatus): Promise<HumanRequestRecord[]> {
    const records = (await this.read()).requests;
    return records.filter((record) => !status || record.status === status).map(cloneRecord);
  }

  async get(requestId: string): Promise<HumanRequestRecord | null> {
    if (typeof requestId !== "string" || requestId.trim().length === 0) throw new Error("requestId is required");
    const record = (await this.read()).requests.find((item) => item.requestId === requestId);
    return record ? cloneRecord(record) : null;
  }

  async resolve(requestId: string, resolution: HumanRequestResolution): Promise<HumanRequestRecord> {
    rejectPayloadFields(resolution);
    if (resolution.continuation !== "resume") throw new Error("continuation must be resume");
    const resolutionRef = opaqueRef(resolution.resolutionRef, "resolutionRef");
    return this.serial(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (record.status !== "pending") return cloneRecord(record);
      if (resolutionRef) record.resolutionRef = resolutionRef;
      record.status = "resuming";
      record.attemptId = randomUUID();
      if (resolutionRef) record.resultRef = resolutionRef;
      await this.write(file);
      this.publishRequest(record.requestId, "updated");
      return cloneRecord(record);
    });
  }

  /** Atomically claim the one automatic resume attempt for a request. */
  async claimResume(requestId: string, input: string | ResumeClaimInput = {}): Promise<HumanRequestRecord> {
    const claim = typeof input === "string" ? { attemptId: input } : input;
    const checkedAttemptId = opaqueRef(claim.attemptId, "attemptId") || randomUUID();
    const resultRef = opaqueRef(claim.resultRef, "resultRef");
    return this.serial(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (record.status !== "pending") return cloneRecord(record);
      record.status = "resuming";
      record.attemptId = checkedAttemptId;
      if (resultRef) record.resultRef = resultRef;
      await this.write(file);
      this.publishRequest(record.requestId, "updated");
      return cloneRecord(record);
    });
  }

  /** Complete the claimed resume. Replays return the existing terminal record. */
  async markResumed(requestId: string, attemptId: string, result?: ResumeAttemptResult): Promise<HumanRequestRecord> {
    return this.finishResume(requestId, attemptId, "resumed", result);
  }

  /** Record a failed resume. Replays return the existing terminal record. */
  async markResumeFailed(requestId: string, attemptId: string, result?: ResumeAttemptResult): Promise<HumanRequestRecord> {
    return this.finishResume(requestId, attemptId, "resume_failed", result);
  }

  async completeResume(requestId: string, input: ResumeCompletionInput): Promise<HumanRequestRecord> {
    return this.finishResume(requestId, input.attemptId, "resumed", input);
  }

  async failResume(requestId: string, input: ResumeCompletionInput): Promise<HumanRequestRecord> {
    return this.finishResume(requestId, input.attemptId, "resume_failed", input);
  }

  private async finishResume(requestId: string, attemptId: string, status: "resumed" | "resume_failed", result?: ResumeAttemptResult): Promise<HumanRequestRecord> {
    rejectPayloadFields(result);
    const checkedAttemptId = opaqueRef(attemptId, "attemptId");
    const receipt = opaqueRef(result?.receipt, "receipt");
    return this.serial(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error(`Human request '${requestId}' not found`);
      if (record.status === "resumed" || record.status === "resume_failed") return cloneRecord(record);
      if (record.status !== "resuming" || record.attemptId !== checkedAttemptId) {
        throw new Error(`Human request '${requestId}' is not owned by attemptId '${attemptId}'`);
      }
      record.status = status;
      if (receipt) record.receipt = receipt;
      record.resolvedAt = new Date().toISOString();
      await this.write(file);
      this.publishRequest(record.requestId, "updated");
      return cloneRecord(record);
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
      this.publishRequest(record.requestId, "updated");
      return cloneRecord(record);
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

function cloneRecord(record: HumanRequestRecord): HumanRequestRecord {
  return {
    ...record,
    target: targetOf(record.target),
    ...(record.notify ? { notify: { ...record.notify } } : {}),
  };
}

function filePathName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1) || "registry";
}
