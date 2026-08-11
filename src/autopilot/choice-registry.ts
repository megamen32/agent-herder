import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type AutopilotChoice = {
  choiceId: string;
  label: string;
  nextGoal: string;
};

export type AutopilotChoiceDecision = {
  kind: "choice";
  choices: AutopilotChoice[];
};

export type PendingChoice = {
  requestId: string;
  sessionId: string;
  turnId: string;
  cwd: string;
  choices: AutopilotChoice[];
  status: "pending" | "claimed" | "resumed";
  choiceId?: string;
  nextGoal?: string;
  createdAt: string;
  claimedAt?: string;
};

type ChoiceFile = { version: 1; requests: PendingChoice[] };

const MAX = 4;
const MIN = 2;
const MAX_TEXT = 512;
const CHOICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export class ChoiceRegistry {
  private operation: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async create(input: Omit<PendingChoice, "requestId" | "status" | "createdAt">): Promise<PendingChoice> {
    validateInput(input);
    return this.serial(async () => {
      const file = await this.read();
      const record: PendingChoice = {
        ...input,
        choices: input.choices.map((choice) => ({ ...choice })),
        requestId: randomUUID(),
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      file.requests.push(record);
      await this.write(file);
      return clone(record);
    });
  }

  async get(requestId: string): Promise<PendingChoice | null> {
    const record = (await this.read()).requests.find((item) => item.requestId === requestId);
    return record ? clone(record) : null;
  }

  async claim(requestId: string, choiceId: string): Promise<PendingChoice> {
    if (!isText(choiceId)) throw new Error("choiceId is required");
    return (await this.claimForResume(requestId, choiceId)).record;
  }

  async claimForResume(requestId: string, choiceId: string): Promise<{ record: PendingChoice; claimed: boolean }> {
    if (!isText(choiceId)) throw new Error("choiceId is required");
    return this.serial(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record) throw new Error("choice request not found");
      if (record.status !== "pending") return { record: clone(record), claimed: false };
      const choice = record.choices.find((item) => item.choiceId === choiceId);
      if (!choice) throw new Error("choice does not belong to request");
      record.status = "claimed";
      record.choiceId = choice.choiceId;
      record.nextGoal = choice.nextGoal;
      record.claimedAt = new Date().toISOString();
      await this.write(file);
      return { record: clone(record), claimed: true };
    });
  }

  async markResumed(requestId: string, choiceId: string): Promise<PendingChoice> {
    return this.serial(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record || record.choiceId !== choiceId) throw new Error("choice request does not match the claimed selection");
      record.status = "resumed";
      await this.write(file);
      return clone(record);
    });
  }

  async releaseFailed(requestId: string, choiceId: string): Promise<PendingChoice> {
    return this.serial(async () => {
      const file = await this.read();
      const record = file.requests.find((item) => item.requestId === requestId);
      if (!record || record.choiceId !== choiceId) throw new Error("choice request does not match the claimed selection");
      record.status = "pending";
      delete record.choiceId;
      delete record.nextGoal;
      delete record.claimedAt;
      await this.write(file);
      return clone(record);
    });
  }

  private async read(): Promise<ChoiceFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as ChoiceFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.requests)) throw new Error("invalid choice registry");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, requests: [] };
      throw error;
    }
  }

  private async write(file: ChoiceFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = join(dirname(this.path), `.${this.path.slice(this.path.lastIndexOf("/") + 1)}.${randomUUID()}.tmp`);
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, this.path);
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }
}

function validateInput(input: Omit<PendingChoice, "requestId" | "status" | "createdAt">): void {
  if (!isText(input.sessionId) || !isText(input.turnId) || !isText(input.cwd)) throw new Error("sessionId, turnId, and cwd are required");
  if (input.choices.length < MIN || input.choices.length > MAX) throw new Error("2 to 4 choices are required");
  const ids = new Set<string>();
  for (const choice of input.choices) {
    if (!isText(choice.choiceId) || !CHOICE_ID_PATTERN.test(choice.choiceId)) throw new Error("choiceId must match callback identifier format");
    if (!isText(choice.label) || !isText(choice.nextGoal)) throw new Error("choice fields are required");
    if (ids.has(choice.choiceId)) throw new Error("choice ids must be unique");
    ids.add(choice.choiceId);
  }
}

function isText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT; }
function clone(record: PendingChoice): PendingChoice { return { ...record, choices: record.choices.map((choice) => ({ ...choice })) }; }
