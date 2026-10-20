const AGENT_RELAY_PROLOG =
  '🤖 Сообщение от ИИ через Agent Herder\n<agent-herder-origin version="1" kind="agent-relay" transport="new_or_resume" />\n\n';

/** Mark the transport without changing the caller's message body. */
export function agentRelayEnvelope(message: string): string {
  return `${AGENT_RELAY_PROLOG}${message}`;
}
