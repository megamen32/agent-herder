// Isolated QA deployment of the installed Herder artifact. No source patches.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [root, release] = process.argv.slice(2);
const config = JSON.parse(await readFile(join(root, "bootstrap.json"), "utf8"));
await mkdir(join(root, "herder-state"), { recursive: true });
for (const [key, file] of Object.entries({
  AGENT_HERDER_AUTOPILOT_STATE_DIR: "herder-state",
  AGENT_HERDER_HUMAN_STOP_STORE: "human-stops.json",
  AGENT_HERDER_DEFERRED_MESSAGES: "deferred.json",
  AGENT_HERDER_COORDINATION_NOTES: "coordination.json",
})) process.env[key] = join(root, file);
process.env.GPTADMIN_HEALTH_CALLBACK_FILE = join(root, "callback.json");
process.env.NOTICEPLACE_HEALTH_LAUNCH_TOKEN = config.launchToken;
const load = (name) => import(pathToFileURL(join(release, "dist", name)).href);
const { OpenCodeAdapter } = await load("adapters/opencode.js");
const { createWebServer } = await load("web/server.js");
const { AutomationLaunchPolicyStore } = await load("automation-launch-policy.js");
const { ProjectLaunchAttemptLog, dispatchProjectLaunch, namedSessionRunner } = await load("automation/project-launch-dispatch.js");
const { AutopilotSessionStore } = await load("autopilot/session-store.js");
const { AutopilotPolicyStore } = await load("autopilot/policy-store.js");
const adapter = new OpenCodeAdapter({ baseUrl: process.env.OPENCODE_URL, password: process.env.OPENCODE_SERVER_PASSWORD });
await adapter.init();
const adapters = new Map([["opencode", adapter]]);
const policyStore = new AutomationLaunchPolicyStore(join(root, "qa-policy.json"));
const attempts = new ProjectLaunchAttemptLog(join(root, config.attemptLog || "qa-attempts.json"));
const nativeRun = namedSessionRunner(adapters, "notice-direct-isolated-qa");
const inner = createWebServer({
  adapters, converter: { async convert() { throw new Error("conversion is outside this isolated canary"); } },
  automationLaunchPolicyStore: policyStore,
  autopilotSessionStore: new AutopilotSessionStore(join(root, "herder-state", "sessions.json")),
  autopilotPolicyStore: new AutopilotPolicyStore(join(root, "herder-state", "policy.json")),
  projectLaunchDispatch: async (request) => {
    const loaded = await policyStore.load();
    if (loaded.kind !== "valid") throw new Error("isolated launch policy is unavailable");
    return dispatchProjectLaunch({ ...request, policy: loaded.policy }, attempts, nativeRun);
  },
  sessionObservationManagedExternally: true,
});
// The owner lever remains the real live fleet lever. Only this read is proxied.
const outer = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/api/settings/automation/disarm") {
    try {
      const response = await fetch("http://127.0.0.1:18787/api/settings/automation/disarm", { signal: AbortSignal.timeout(10000) });
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(await response.text());
    } catch { res.writeHead(503); res.end('{"ok":false}'); }
    return;
  }
  inner.emit("request", req, res);
});
await new Promise((resolve) => outer.listen(0, "127.0.0.1", resolve));
await writeFile(join(root, "qa-herder-ready.json"), JSON.stringify({ port: outer.address().port, pid: process.pid, release }), { mode: 0o600 });
const close = () => outer.close(() => process.exit(0));
process.on("SIGTERM", close);
process.on("SIGINT", close);
