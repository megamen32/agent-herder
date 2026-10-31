import type { SessionSupervisor } from "./session-supervisor.js";

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
 * Doctrine: the intro is a normal supervisor send with a stable inputId, so
 * restarts and repeated creation triggers cannot duplicate the native
 * message; a refused or failed intro never fails the session creation that
 * caused it. The send is fire-and-forget (queue) so the creation path is
 * never blocked on a remote site.
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

export interface ChatMcpIntroConfig {
  readonly harnesses: readonly string[];
  readonly url: string;
  readonly token: string;
  readonly template?: string;
}

/** Disabled until the owner sets both the gateway URL and the shared key. */
export function chatMcpIntroConfig(): ChatMcpIntroConfig | null {
  const url = process.env.AGENT_HERDER_CHAT_INTRO_URL?.trim();
  const token = process.env.AGENT_HERDER_CHAT_INTRO_TOKEN?.trim();
  if (!url || !token) return null;
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

/**
 * Deliver the intro for a freshly created session. Returns true when a send
 * was attempted. Never throws: a failed intro must not fail session creation.
 */
export async function deliverChatMcpIntroForSession(
  supervisor: Pick<SessionSupervisor, "sendMessage">,
  harness: string,
  sessionId: string,
  origin: "human" | "automation",
): Promise<boolean> {
  const config = chatMcpIntroConfig();
  if (!config || !config.harnesses.includes(harness)) return false;
  try {
    const result = await supervisor.sendMessage(harness, sessionId, {
      message: chatMcpIntroMessage(config, harness, sessionId),
      inputId: chatMcpIntroInputId(harness, sessionId),
      origin,
      queue: true,
    });
    if (result && result.ok === false) {
      console.error(`[chat-mcp-intro] refused for ${harness}/${sessionId}: ${String(result.error ?? "unknown refusal")}`);
    }
    return true;
  } catch (error) {
    console.error(`[chat-mcp-intro] failed for ${harness}/${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
