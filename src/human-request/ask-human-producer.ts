import { readFile } from "node:fs/promises";
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
