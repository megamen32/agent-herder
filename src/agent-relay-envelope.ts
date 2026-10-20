export type AgentRelayTransport = "new_or_resume" | "deliver";

/** Mark the transport without changing the caller's message body. */
export function agentRelayEnvelope(message: string, transport: AgentRelayTransport = "new_or_resume"): string {
  return `🤖 Сообщение от ИИ через Agent Herder\n<agent-herder-origin version="1" kind="agent-relay" transport="${transport}" />\n\n${message}`;
}
