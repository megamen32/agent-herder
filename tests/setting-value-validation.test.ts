import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSettingsApi } from "../src/web/settings-api.js";
import { SettingsStore } from "../src/web/settings-store.js";
import * as catalog from "../src/web/settings-catalog.js";

/**
 * The value of a setting is checked before it is written.
 *
 * The service parses some values of the environment file at the start and
 * refuses to start when a value does not fit. The catalog declares the
 * contract of these keys, the store refuses the value that does not fit
 * before the write, the refusal is a record of the journal of the changes,
 * and the API answers the refusal as a human error.
 */

/** The key whose value the service parses and refuses at the start. */
const JUDGE_EFFORT = "AGENT_HERDER_UNFINISHED_JUDGE_REASONING_EFFORT";

/** The key whose empty value the service refuses at the start. */
const RESUME_HOLD = "AGENT_HERDER_RESUME_AFTER_STARTUP_HOLD";

/** The key whose value the service reads as a port. */
const WORKER_PORT = "AGENT_HERDER_BROWSER_WORKER_PORT";

/** The value of a secret: it must never leave the process. */
const SECRET_VALUE = "center-secret-value-must-never-appear";

let workDir = "";
let envPath = "";
let store: SettingsStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "herder-setting-value-"));
  envPath = join(workDir, "herder.env");
  await writeFile(envPath, [
    "# the environment of the herder product",
    "NOTIFY_CENTER_EVENT_URL=https://center.example/v1/events",
    "NOTIFY_CENTER_PROJECT=agent-herder",
    "NOTIFY_CENTER_TOKEN=center-token-value",
    `${JUDGE_EFFORT}=low`,
    "",
  ].join("\n"), { mode: 0o600 });
  store = new SettingsStore({
    envPath,
    nodeConfigPath: join(workDir, "node-config.json"),
    stateDir: join(workDir, "state"),
  });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** The fingerprint of the file of the product: the proof that it did not move. */
function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The records of the journal of the changes, as they are on the disk. */
async function auditRecords(): Promise<Record<string, any>[]> {
  const raw = await readFile(store.auditPath, "utf8");
  return raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/** One request to the API without a server behind it. */
async function callApi(
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>,
  options: { method: string; url: string; body?: unknown; origin?: string; host?: string; ifMatch?: string },
): Promise<{ handled: boolean; status: number; body: any }> {
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
  const request = {
    method: options.method,
    url: options.url,
    headers: {
      host: options.host ?? "127.0.0.1:18789",
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.ifMatch ? { "if-match": options.ifMatch } : {}),
    },
    socket: { remoteAddress: "127.0.0.1" },
    [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk; },
  } as unknown as IncomingMessage;
  let status = 0;
  let payload = "";
  const response = {
    writeHead(code: number) { status = code; return response; },
    end(body?: unknown) { payload = typeof body === "string" ? body : ""; return response; },
    setHeader() { return response; },
  } as unknown as ServerResponse;
  const handled = await handler(request, response);
  return { handled, status, body: payload ? JSON.parse(payload) : null };
}

describe("the value of a setting is checked against the contract of its key before it is written", () => {
  it("writes the value that fits the contract of the key", async () => {
    await store.applyEnvironment({ [JUDGE_EFFORT]: "max" });
    expect(await readFile(envPath, "utf8")).toContain(`${JUDGE_EFFORT}=max`);
  });

  it("writes the value the service reads as the same value", async () => {
    // The service trims the value and reads it in lower case, so the value
    // "MAX" is the value "max" for the service.
    await store.applyEnvironment({ [JUDGE_EFFORT]: "MAX" });
    expect(await readFile(envPath, "utf8")).toContain(`${JUDGE_EFFORT}=MAX`);
  });

  it("refuses the value that does not fit the contract of the key", async () => {
    const failure = await store.applyEnvironment({ [JUDGE_EFFORT]: "medium" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { code?: string }).code).toBe("SETTINGS_VALUE_NOT_ALLOWED");
    const message = (failure as Error).message;
    // The message names the key, the allowed values and the received value.
    expect(message).toContain(JUDGE_EFFORT);
    expect(message).toContain("low, high, max");
    expect(message).toContain("medium");
    // The message carries no stack and no internal id of the store.
    expect(message).not.toMatch(/\.ts:\d+/);
    expect(message.split("\n")).toHaveLength(1);
  });

  it("leaves the file of the product exactly as it was after a refused write", async () => {
    const before = await readFile(envPath);
    await store.applyEnvironment({ [JUDGE_EFFORT]: "medium" }).catch(() => undefined);
    expect(sha256(await readFile(envPath))).toBe(sha256(before));
  });

  it("writes a key without a contract as it was written before", async () => {
    await store.applyEnvironment({ NOTIFY_CENTER_PROJECT: "other-project" });
    expect(await readFile(envPath, "utf8")).toContain("NOTIFY_CENTER_PROJECT=other-project");
    // A key the herder does not know by name is written too, with the value
    // as it is: the file of the product quotes the value that needs quotes.
    await store.applyEnvironment({ SOME_UNKNOWN_KEY: "any value" });
    expect(await readFile(envPath, "utf8")).toContain('SOME_UNKNOWN_KEY="any value"');
  });

  it("refuses the value that the service refuses for every key with a contract", async () => {
    // The service reads this value exactly and throws on anything else.
    await expect(store.applyEnvironment({ [RESUME_HOLD]: "on" })).rejects.toThrow(/AGENT_HERDER_RESUME_AFTER_STARTUP_HOLD/);
    // The empty value of this key breaks the service as well.
    await expect(store.applyEnvironment({ [RESUME_HOLD]: "" })).rejects.toThrow(/AGENT_HERDER_RESUME_AFTER_STARTUP_HOLD/);
    // The service reads this value as a port of the node.
    await expect(store.applyEnvironment({ [WORKER_PORT]: "70000" })).rejects.toThrow(/AGENT_HERDER_BROWSER_WORKER_PORT/);
    await expect(store.applyEnvironment({ [WORKER_PORT]: "9012" })).resolves.toBeTruthy();
  });

  it("never puts the value of a secret in the message of a refusal", async () => {
    // The contract of the key is checked with the secret flag: the value of a
    // secret is named by its key and by nothing else.
    const refusal = catalog.envValueRefusal(JUDGE_EFFORT, "medium", { secret: true });
    expect(refusal).toBeTruthy();
    expect(refusal).not.toContain("medium");
    expect(refusal).toContain(JUDGE_EFFORT);
    // The store refuses a secret before it is written and its message names
    // the key, not the value.
    const failure = await store.applyEnvironment({ NOTIFY_CENTER_TOKEN: `${SECRET_VALUE}\nnext` })
      .catch((error: unknown) => error);
    expect((failure as Error).message).not.toContain(SECRET_VALUE);
    expect((failure as Error).message).toContain("NOTIFY_CENTER_TOKEN");
  });
});

describe("the refusal of a value is a record of the journal of the changes", () => {
  it("records the refusal with its reason and without a change", async () => {
    const before = await readFile(envPath);
    await store.applyEnvironment({ [JUDGE_EFFORT]: "medium" }).catch(() => undefined);
    const records = await auditRecords();
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record.action).toBe("refused");
    expect(record.changed).toBe(false);
    expect(record.entity).toBe("herder.env");
    expect(record.key).toBe(JUDGE_EFFORT);
    // The value did not move: before and after are the same state.
    expect(record.before).toEqual({ present: true, value: "low" });
    expect(record.after).toEqual(record.before);
    // The reason names the key and the allowed values, in Russian.
    expect(record.reason).toContain(JUDGE_EFFORT);
    expect(record.reason).toContain("low, high, max");
    // A refusal never goes into the undo stack.
    expect(record.historyId).toBeUndefined();
    await expect(readFile(store.historyPath, "utf8")).rejects.toThrow();
    // The file of the product is byte-identical.
    expect(sha256(await readFile(envPath))).toBe(sha256(before));
  });

  it("keeps the value of a secret out of the record of a refusal", async () => {
    await store.applyEnvironment({ NOTIFY_CENTER_TOKEN: `${SECRET_VALUE}\nnext` }).catch(() => undefined);
    const raw = await readFile(store.auditPath, "utf8");
    // The value of the secret is nowhere in the record.
    expect(raw).not.toContain(SECRET_VALUE);
    const [record] = (await auditRecords());
    expect(record.action).toBe("refused");
    expect(record.key).toBe("NOTIFY_CENTER_TOKEN");
    expect(record.kind).toBe("secret");
    // The record of a secret names the key and says whether it is set: no
    // value and no shadow of the value.
    expect(record.before).toEqual({ present: true, configured: true });
    expect(record.after).toEqual(record.before);
    expect(record.before.value).toBeUndefined();
    expect(record.before.fingerprint).toBeUndefined();
    expect(record.reason).toContain("NOTIFY_CENTER_TOKEN");
    expect(record.reason).not.toContain(SECRET_VALUE);
  });

  it("records one refusal for one refused change", async () => {
    await store.applyEnvironment({ [JUDGE_EFFORT]: "medium" }).catch(() => undefined);
    await store.applyEnvironment({ [JUDGE_EFFORT]: "wrong" }).catch(() => undefined);
    const records = await auditRecords();
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.action === "refused")).toBe(true);
  });
});

describe("the API answers the refusal of a value as a human error", () => {
  it("answers 400 and names the key, the allowed values and the received value", async () => {
    const handler = createSettingsApi({ store });
    const before = await readFile(envPath);
    const refused = await callApi(handler, {
      method: "PUT",
      url: "/api/settings",
      origin: "http://127.0.0.1:18789",
      ifMatch: await store.documentEtag(),
      body: { environment: { [JUDGE_EFFORT]: "medium" } },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.ok).toBe(false);
    expect(refused.body.applied).toBe(false);
    expect(refused.body.error).toContain(JUDGE_EFFORT);
    expect(refused.body.error).toContain("low, high, max");
    expect(refused.body.error).toContain("medium");
    expect(refused.body.error).not.toMatch(/\.ts:\d+/);
    // The refused value never reached the file of the product.
    expect(sha256(await readFile(envPath))).toBe(sha256(before));
    // The value of the setting stayed as it was.
    const view = await callApi(handler, { method: "GET", url: "/api/settings" });
    expect(view.status).toBe(200);
    expect(view.body.environment.values[JUDGE_EFFORT].value).toBe("low");
    // The refusal is in the journal of the changes.
    const records = await auditRecords();
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe("refused");
    expect(records[0].changed).toBe(false);
    expect(records[0].reason).toContain("low, high, max");
  });

  it("answers 200 for the value that fits the contract", async () => {
    const handler = createSettingsApi({ store });
    const accepted = await callApi(handler, {
      method: "PUT",
      url: "/api/settings",
      origin: "http://127.0.0.1:18789",
      ifMatch: await store.documentEtag(),
      body: { environment: { [JUDGE_EFFORT]: "high" } },
    });
    expect(accepted.status).toBe(200);
    expect(await readFile(envPath, "utf8")).toContain(`${JUDGE_EFFORT}=high`);
    // A written change is a change and not a refusal.
    const records = await auditRecords();
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe("set");
    expect(records[0].changed).toBe(true);
  });
});
