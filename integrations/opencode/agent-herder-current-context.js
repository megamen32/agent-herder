// Self-contained native directory projection. A distinct physical release path
// avoids importing a cached canonical factory. No autopilot/config/event hooks.
export default async function AgentHerderCurrentContext({ directory }) {
  const endpoint = process.env.AGENT_HERDER_URL || 'http://127.0.0.1:18787'
  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      const user = output.messages?.findLast(message => message.info?.role === 'user')
      const sessionId = user?.info?.sessionID, identity = user?.info?.id
      const textPart = user?.parts?.findLast(part => part.type === 'text' && typeof part.text === 'string')
      if (!sessionId || !identity || !textPart) return
      try {
        const query = new URLSearchParams({ harness: 'opencode', sessionId, cwd: directory, activeTurnId: identity, consumeActive: '1' })
        const signal = AbortSignal.timeout(1200)
        const response = await fetch(`${endpoint}/api/coordination/context?${query}`, { signal })
        if (!response.ok) return
        const data = await response.json()
        if (signal.aborted || data?.humanStopHeld || !data?.activeInboxIds?.length || !data.activeInboxContext) return
        // The output must still refer to the same native root when the read ends.
        const current = output.messages?.findLast(message => message.info?.role === 'user')
        if (current !== user || current.info.sessionID !== sessionId || current.info.id !== identity || !current.parts?.includes(textPart)) return
        textPart.text += '\n\n' + data.activeInboxContext
        // Lost/late ACK is receipt-only. Never fetch or offer again as a retry.
        await fetch(`${endpoint}/api/coordination/inbox-ack`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, ids: data.activeInboxIds }), signal: AbortSignal.timeout(1200),
        })
      } catch {} // Optional context failure cannot start a turn or alter native output.
    },
  }
}
