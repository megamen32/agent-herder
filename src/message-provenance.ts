import type { AgentSession, HarnessAdapter } from "./types/index.js";

export type SenderDeclaration = { fromSessionId?: string; fromHarness?: string };
const SENDER_LOOKUP_TIMEOUT_MS = 2_000;

/**
 * Adds reply context from the declared sender's current native session.
 * Caller metadata is useful attribution evidence, not authentication of the caller.
 */
export async function buildMessageProvenanceHeader(
  adapters: Map<string, HarnessAdapter>,
  declaration: SenderDeclaration,
  target: AgentSession,
): Promise<string> {
  const senderId = declaration.fromSessionId?.trim();
  if (!senderId) return "🤖 Сообщение от AI-сессии\nОтправитель неизвестен: сессия не указана.";

  const candidates = declaration.fromHarness
    ? [adapters.get(declaration.fromHarness)].filter((adapter): adapter is HarnessAdapter => Boolean(adapter))
    : [...adapters.values()];
  let deadlineExpired = false;
  const lookup = (async () => {
    const matches: AgentSession[] = [];
    for (const adapter of candidates) {
      if (deadlineExpired) return { failed: true, matches };
      try {
        const session = await adapter.getSession(senderId);
        if (deadlineExpired) return { failed: true, matches };
        if (session && session.id === senderId && session.harness === adapter.type
          && (!declaration.fromHarness || session.harness === declaration.fromHarness)) matches.push(session);
      } catch {
        return { failed: true, matches };
      }
    }
    return { failed: false, matches };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    lookup,
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        deadlineExpired = true;
        resolve(undefined);
      }, SENDER_LOOKUP_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (!result || result.failed || result.matches.length !== 1) {
    return "🤖 Сообщение от AI-сессии\nОтправитель неизвестен: сессия не проверена.";
  }

  const sender = result.matches[0]!;
  const chatUrl = `https://agent.bezrabotnyi.com/#/session/${encodeURIComponent(`${sender.harness}:${sender.id}`)}`;
  const targetLabel = readableHarness(target.harness);
  const replyArgs = {
    sessionId: sender.id,
    harness: sender.harness,
    mode: "queue",
    fromSessionId: target.id,
    fromHarness: target.harness,
  };
  return [
    "🤖 Сообщение от AI-сессии",
    `От: AI-сессия ${readableHarness(sender.harness)} · ${sender.id}`,
    `Чат: ${chatUrl}`,
    `Чтобы ответить от ${targetLabel}, добавь поле message с текстом ответа и вызови send_message:`,
    JSON.stringify(replyArgs),
  ].join("\n");
}

function readableHarness(harness: string): string {
  const labels: Record<string, string> = { codex: "Codex", zcode: "ZCode", opencode: "OpenCode" };
  return labels[harness] ?? harness.replace(/[-_]+/g, " ").replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}
