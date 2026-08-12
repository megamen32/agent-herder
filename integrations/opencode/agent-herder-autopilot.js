const root = process.env.AGENT_HERDER_ROOT || new URL("../../", import.meta.url).pathname.replace(/\/$/, "")

function actionOf(value) {
  const action = String(value || "").trim().split(/\s+/)[0].toLowerCase()
  return ["on", "status", "off"].includes(action) ? action : "on"
}

async function invoke($, payload) {
  const result = await $`env PLUGIN_ROOT=${root} bash ${root}/scripts/autopilot-command-launcher.sh ${JSON.stringify(payload)}`.quiet()
  return JSON.parse(result.text())
}

export default async function AgentHerderAutopilot({ directory, $ }) {
  const enabled = new Set()
  const controlTurns = new Set()
  return {
    config: async (config) => {
      config.command ||= {}
      config.command.autopilot = {
        description: "Включить Agent Herder autopilot для текущей сессии [on|status|off]",
        template: "Agent Herder autopilot control.",
      }
    },
    "command.execute.before": async ({ command, sessionID, arguments: args }, output) => {
      if (command !== "autopilot") return
      const action = actionOf(args)
      controlTurns.add(sessionID)
      const result = await invoke($, { command: action, harness: "opencode", sessionId: sessionID, cwd: directory })
      if (action === "on") enabled.add(sessionID)
      if (action === "off") enabled.delete(sessionID)
      output.parts.splice(0, output.parts.length, {
        type: "text",
        text: `Autopilot ${result.enabled ? "включён" : "выключен"} для текущей OpenCode-сессии (${sessionID}).`,
        synthetic: true,
      })
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const sessionID = event.properties?.sessionID
      if (!sessionID) return
      if (controlTurns.delete(sessionID)) return
      if (!enabled.has(sessionID)) {
        const status = await invoke($, { command: "status", harness: "opencode", sessionId: sessionID, cwd: directory })
        if (!status.enabled) return
        enabled.add(sessionID)
      }
      await invoke($, {
        command: "stop",
        harness: "opencode",
        sessionId: sessionID,
        turnId: event.id || `idle-${Date.now()}`,
        cwd: directory,
      })
    },
  }
}
