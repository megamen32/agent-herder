const root = process.env.AGENT_HERDER_ROOT || new URL("../../", import.meta.url).pathname.replace(/\/$/, "")

const coordinationEndpoint = process.env.AGENT_HERDER_URL || "http://127.0.0.1:18787"

async function coordinationFetch(path, options = {}) {
  const response = await fetch(`${coordinationEndpoint}${path}`, { ...options, signal: AbortSignal.timeout(1200) })
  if (!response.ok) return null
  return response.json()
}

function coordinationPaths(value, out = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*([^\n]+)/g)) out.add(match[1].trim())
    return out
  }
  if (Array.isArray(value)) { for (const item of value) coordinationPaths(item, out); return out }
  if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (/^(path|file|file_path|filepath|filename)$/i.test(key) && typeof item === "string") out.add(item)
    else if (/^(paths|files)$/i.test(key) && Array.isArray(item)) for (const path of item) if (typeof path === "string") out.add(path)
    coordinationPaths(item, out)
  }
  return out
}

function coordinationIsWriteActivity(tool, args) {
  const name = String(tool || "").toLowerCase()
  if (/(?:write|edit|patch|apply_patch|create_file|delete_file|move_file|rename_file)/.test(name)) return true
  if (!/(?:bash|shell|terminal|exec|command)/.test(name)) return false
  const command = typeof args === "string" ? args : String(args?.command || args?.cmd || args?.script || "")
  return [
    /(?:^|[;&|\s])sed\s+-[^\n;]*\bi[^\n;]*/,
    /(?:^|[;&|\s])perl\s+-[^\n;]*\bi[^\n;]*/,
    /(?:^|[;&|\s])(?:tee|cp|mv|rm|touch|mkdir|truncate|install)(?:\s|$)/,
    /(?:^|[;&|\s])git\s+(?:checkout|restore|apply|mv|rm)(?:\s|$)/,
    /(?:^|[^<])>{1,2}\s*[^&]/,
  ].some((pattern) => pattern.test(command))
}

async function recordCoordinationActivity(sessionID, directory, tool, args) {
  if (!sessionID) return null
  const paths = coordinationIsWriteActivity(tool, args) ? [...coordinationPaths(args)].map((path) => path.replace(/^\.\//, "")).filter((path) => path && !path.startsWith("../")).slice(0, 32) : []
  if (!paths.length) return null
  return coordinationFetch("/api/coordination/activity", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "opencode", sessionId: sessionID, cwd: directory, paths }),
  })
}

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
    "experimental.chat.system.transform": async ({ sessionID }, output) => {
      if (!sessionID || !Array.isArray(output.system)) return
      try {
        const q = new URLSearchParams({ harness: "opencode", sessionId: sessionID, cwd: directory, touch: "1" })
        const data = await coordinationFetch(`/api/coordination/context?${q}`)
        if (data?.context) output.system.push(data.context)
      } catch {}
    },
    "tool.execute.before": async ({ sessionID, tool }, output) => {
      try { await recordCoordinationActivity(sessionID, directory, tool, output.args) } catch {}
    },
    "tool.execute.after": async ({ sessionID, tool, args }) => {
      try { await recordCoordinationActivity(sessionID, directory, tool, args) } catch {}
    },
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
