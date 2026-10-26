import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/**
 * The producer configuration for ordinary human questions.
 *
 * It is the existing protected AskHuman producer config, not a new grant: the
 * same endpoint, project, token and allowed actors the phone-facing stdio
 * already uses. Herder's own automatic `/v1/events` intake keeps its own
 * `agent-herder` project, so an ordinary notification is never routed through
 * the question producer.
 */
export interface AskHumanProducer {
  /** The dedicated human-request intake of that producer. */
  endpoint: string;
  /** Provider-owned bearer token. Never logged, never copied anywhere else. */
  token: string;
  /** Project scope of the question. */
  project: string;
  recipient: string;
  /** Actors allowed to answer, as configured for that producer. */
  allowedActors?: string[];
  /** Where the configuration came from, for diagnostics without any value. */
  source: "ask_human_config" | "ask_human_env" | "herder_config";
}

export interface NoticeProducerTarget {
  hostId: string;
  harness: string;
  sessionId: string;
}

interface NoticeProducerBinding {
  target: NoticeProducerTarget;
  askHumanEnvFile: string;
}

/** The protected file that holds the AskHuman producer credentials. */
export function askHumanEnvPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.ASK_HUMAN_ENV_FILE?.trim();
  if (configured) return isAbsolute(configured) ? configured : join(home, configured);
  return join(home, ".config", "ask-human", "env");
}

/** Parse a KEY=VALUE environment file. Values never leave this module. */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (line.length === 0 || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) values[key] = value;
  }
  return values;
}

/**
 * Resolve the question producer.
 *
 * The protected AskHuman config wins, because the human answers these questions
 * through that producer's scope. Herder's own notification config is only a
 * fallback for a deployment that has no AskHuman config at all.
 */
export async function loadAskHumanProducer(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<AskHumanProducer | undefined> {
  // The protected AskHuman config wins over the process environment: it is the
  // scope the human answers in, and Herder's own notification environment must
  // never redirect an ordinary question into the automatic events intake.
  let fileValues: Record<string, string> = {};
  try {
    fileValues = parseEnvFile(await readFile(askHumanEnvPath(env, home), "utf8"));
  } catch {
    fileValues = {};
  }
  const fromFile = askHumanProducerFrom(fileValues, "ask_human_config");
  if (fromFile) return fromFile;
  const inline = askHumanProducerFrom(env, "ask_human_env");
  if (inline) return inline;
  return askHumanProducerFrom(env, "herder_config");
}

/**
 * Select a permission-question producer by the exact native target. An absent
 * binding keeps the existing producer; a matching but unsafe binding fails
 * closed instead of falling back to that producer.
 */
export async function loadAskHumanProducerForTarget(
  target: NoticeProducerTarget,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<AskHumanProducer | undefined> {
  const bindingsPath = env.AGENT_HERDER_NOTICE_PRODUCER_BINDINGS_FILE?.trim();
  if (!bindingsPath) return loadAskHumanProducer(env, home);
  if (!isAbsolute(bindingsPath)) throw new Error("Notice producer bindings path must be absolute");

  const bindings = await readPrivateJson(bindingsPath, "Notice producer bindings");
  const selected = parseNoticeProducerBindings(bindings).filter((binding) => sameNoticeProducerTarget(binding.target, target));
  if (selected.length === 0) return loadAskHumanProducer(env, home);
  if (selected.length !== 1) throw new Error("Notice producer bindings contain a conflicted native target");

  const binding = selected[0]!;
  const values = parseEnvFile(await readPrivateText(binding.askHumanEnvFile, "bound AskHuman producer file"));
  const producer = askHumanProducerFrom(values, "ask_human_config");
  if (!producer || !producer.allowedActors?.length || producer.allowedActors.some((actor) => actor === "*")) {
    throw new Error("bound AskHuman producer is incomplete or has a wildcard actor policy");
  }
  return producer;
}

async function readPrivateText(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error(`${label} path must be absolute`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || typeof process.geteuid !== "function" || info.uid !== process.geteuid() || (info.mode & 0o777) !== 0o600) {
      throw new Error(`${label} must be a regular 0600 file owned by the Agent Herder user`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function readPrivateJson(path: string, label: string): Promise<unknown> {
  const text = await readPrivateText(path, label);
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error(`${label} is malformed`); }
}

function parseNoticeProducerBindings(value: unknown): NoticeProducerBinding[] {
  if (!isRecord(value) || !hasExactKeys(value, ["version", "bindings"]) || value.version !== 1 || !Array.isArray(value.bindings)) {
    throw new Error("Notice producer bindings are malformed");
  }
  const result: NoticeProducerBinding[] = [];
  const seen = new Set<string>();
  for (const raw of value.bindings) {
    if (!isRecord(raw) || !hasExactKeys(raw, ["target", "askHumanEnvFile"]) || typeof raw.askHumanEnvFile !== "string" || !isAbsolute(raw.askHumanEnvFile)) {
      throw new Error("Notice producer binding entry is malformed");
    }
    const target = raw.target;
    if (!isRecord(target) || !hasExactKeys(target, ["hostId", "harness", "sessionId"])) {
      throw new Error("Notice producer binding target is malformed");
    }
    const hostId = boundedIdentity(target.hostId);
    const harness = boundedIdentity(target.harness);
    const sessionId = boundedIdentity(target.sessionId);
    if (!hostId || !harness || !sessionId) throw new Error("Notice producer binding target is malformed");
    const key = JSON.stringify([hostId, harness, sessionId]);
    if (seen.has(key)) throw new Error("Notice producer bindings contain a conflicted native target");
    seen.add(key);
    result.push({ target: { hostId, harness, sessionId }, askHumanEnvFile: raw.askHumanEnvFile });
  }
  return result;
}

function boundedIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() : undefined;
}

function sameNoticeProducerTarget(left: NoticeProducerTarget, right: NoticeProducerTarget): boolean {
  return left.hostId === right.hostId && left.harness === right.harness && left.sessionId === right.sessionId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function askHumanProducerFrom(
  values: NodeJS.ProcessEnv | Record<string, string>,
  source: AskHumanProducer["source"],
): AskHumanProducer | undefined {
  const token = values.NOTIFY_CENTER_TOKEN?.trim();
  const project = values.NOTIFY_CENTER_PROJECT?.trim() || values.ASK_HUMAN_PROJECT?.trim();
  const endpoint = values.ASK_HUMAN_URL?.trim()
    ?? values.NOTIFY_CENTER_HUMAN_REQUEST_URL?.trim()
    ?? values.NOTIFY_CENTER_EVENT_URL?.trim().replace(/\/v1\/events\/?$/, "/v1/human-requests");
  if (!token || !project || !endpoint) return undefined;
  const isAskHuman = Boolean(values.ASK_HUMAN_URL || values.ASK_HUMAN_ALLOWED_ACTORS || values.ASK_HUMAN_PROJECT);
  if (source !== "herder_config" && !isAskHuman) return undefined;
  const actors = (values.ASK_HUMAN_ALLOWED_ACTORS ?? "").split(",").map((actor) => actor.trim()).filter(Boolean);
  return {
    endpoint,
    token,
    project,
    recipient: values.NOTIFY_CENTER_RECIPIENT?.trim() || "me",
    ...(actors.length > 0 ? { allowedActors: actors } : {}),
    source: isAskHuman ? source : "herder_config",
  };
}

/** A diagnostics-safe description: no token, no actor identifiers. */
export function describeAskHumanProducer(producer: AskHumanProducer): string {
  return `project=${producer.project} endpoint=${safeEndpoint(producer.endpoint)} actors=${producer.allowedActors?.length ?? 0} source=${producer.source}`;
}

function safeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "configured";
  }
}
