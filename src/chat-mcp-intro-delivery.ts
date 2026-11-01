import type { SessionSupervisor } from "./session-supervisor.js";
import { isSecretMarker, SecretStore } from "./web/settings-store.js";
import { deferredMessages } from "./deferred-messages.js";

/**
 * MCP intro for chats the herder creates.
 *
 * When the herder creates (or first adopts) a session in a configured chat
 * harness, one short MCP connection config is delivered into that chat so the
 * remote assistant can reach the owner gateway directly: the shell nodes of
 * the machines and the nested AgentHerder live there, not in this process.
 *
 * The credential is a single shared owner-managed key. It is set once in the
 * settings form, its value is never returned by any API (the settings store
 * keeps secrets write-only), and one revocation on the gateway side disables
 * every chat at once. Per-chat keys are deliberately not minted here.
 *
 * Because the key is write-only, the environment of the running process
 * carries only its fingerprint marker; the value itself is resolved from the
 * secret store of the product at delivery time. A raw value written straight
 * into the environment of the product (deployment-owned) is used as is.
 *
 * Doctrine: the intro is a normal supervisor send with a stable inputId, so
 * restarts and repeated triggers cannot duplicate the native message; a
 * refused or failed intro never fails the session creation that caused it.
 * The send is fire-and-forget (queue) so the creation path is never blocked
 * on a remote site. One exception is durable: when the target chat is
 * generating right now, the intro is parked into the deferred inbox instead
 * of being dropped, because a chat adopted mid-turn would otherwise never see
 * its intro again (the first binding fires exactly once).
 */

const DEFAULT_HARNESSES = "zai";

const DEFAULT_TEMPLATE = [
  "[Agent Herder] Прямой доступ к агентской инфраструктуре — конфиг MCP:",
  "",
  "URL: {url}",
  "Token: {token}",
  "",
  "Подключи URL как MCP-сервер (Streamable HTTP), ключ — в заголовок Authorization: Bearer <token>.",
  "Доступны shell-ноды серверов и вложенный AgentHerder (deliver, list_agents, resume_after_status и др.).",
  "SSH не использовать. Ключ общий для всех чатов; при отзыве придёт новый в этом же чате.",
].join("\n");

/** Reads one write-only secret of the product. */
export interface IntroSecretReader {
  readSecret(key: string): Promise<string | undefined>;
}

let sharedSecretReader: IntroSecretReader | undefined;

function secretReader(): IntroSecretReader {
  sharedSecretReader ??= new SecretStore();
  return sharedSecretReader;
}

export interface ChatMcpIntroConfig {
  readonly harnesses: readonly string[];
  readonly url: string;
  readonly token: string;
  readonly template?: string;
}

/**
 * Disabled until the owner sets both the gateway URL and the shared key.
 * The key is write-only: a fingerprint marker in the environment resolves
 * through the secret store of the product; a raw value is used as is.
 */
export async function chatMcpIntroConfig(
  reader: IntroSecretReader = secretReader(),
): Promise<ChatMcpIntroConfig | null> {
  const url = process.env.AGENT_HERDER_CHAT_INTRO_URL?.trim();
  const rawToken = process.env.AGENT_HERDER_CHAT_INTRO_TOKEN?.trim();
  if (!url || !rawToken) return null;
  let token = rawToken;
  if (isSecretMarker(rawToken)) {
    token = (await reader.readSecret("AGENT_HERDER_CHAT_INTRO_TOKEN"))?.trim() ?? "";
    if (!token) return null;
  }
  const harnesses = (process.env.AGENT_HERDER_CHAT_INTRO_HARNESSES ?? DEFAULT_HARNESSES)
    .split(",").map((value) => value.trim()).filter(Boolean);
  if (!harnesses.length) return null;
  const template = process.env.AGENT_HERDER_CHAT_INTRO_TEMPLATE?.trim();
  return { harnesses, url, token, template: template || undefined };
}

/** Stable native operation identity: one intro per session, ever. */
export function chatMcpIntroInputId(harness: string, sessionId: string): string {
  return `mcp-intro-${harness}-${sessionId}`;
}

function substitute(text: string, placeholder: string, value: string): string {
  return text.split(placeholder).join(value);
}

export function chatMcpIntroMessage(config: ChatMcpIntroConfig, harness: string, sessionId: string): string {
  const template = config.template ?? DEFAULT_TEMPLATE;
  return substitute(substitute(substitute(substitute(template,
    "{url}", config.url), "{token}", config.token), "{harness}", harness), "{sessionId}", sessionId);
}

/** The target chat is generating right now and refuses new input. */
function busyTargetError(error: string | undefined): boolean {
  return /prompt is already running|already has an active writer|composer is unavailable/i.test(error ?? "");
}

/**
 * Deliver the intro for a freshly created session. Returns true when a send
 * was attempted or parked. Never throws: a failed intro must not fail session
 * creation.
 */
export async function deliverChatMcpIntroForSession(
  supervisor: Pick<SessionSupervisor, "sendMessage">,
  harness: string,
  sessionId: string,
  origin: "human" | "automation",
): Promise<boolean> {
  const config = await chatMcpIntroConfig();
  if (!config || !config.harnesses.includes(harness)) return false;
  const message = chatMcpIntroMessage(config, harness, sessionId);
  try {
    const result = await supervisor.sendMessage(harness, sessionId, {
      message,
      inputId: chatMcpIntroInputId(harness, sessionId),
      origin,
      queue: true,
    });
    if (result && result.ok === false) {
      if (busyTargetError(result.error) && result.nonRetryable !== true) {
        await parkIntro(harness, sessionId, message);
      } else {
        console.error(`[chat-mcp-intro] refused for ${harness}/${sessionId}: ${String(result.error ?? "unknown refusal")}`);
      }
    }
    return true;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (busyTargetError(text)) {
      try {
        await parkIntro(harness, sessionId, message);
        return true;
      } catch (parkError) {
        console.error(`[chat-mcp-intro] park failed for ${harness}/${sessionId}: ${parkError instanceof Error ? parkError.message : String(parkError)}`);
        return false;
      }
    }
    console.error(`[chat-mcp-intro] failed for ${harness}/${sessionId}: ${text}`);
    return false;
  }
}

/**
 * A busy chat keeps the intro in the deferred inbox: the sweeper delivers it
 * when the target is verified calm. The park is idempotent by session and
 * text, so repeated triggers still mean exactly one intro.
 */
async function parkIntro(harness: string, sessionId: string, message: string): Promise<void> {
  await deferredMessages.add(sessionId, message, harness);
}
