import { readFile, writeFile } from "node:fs/promises";
import { newOrResumeNamedSession } from "../../dist/named-session.js";

const [storePath, cwd, message] = process.argv.slice(2);

async function readSessions() {
  try {
    return JSON.parse(await readFile(storePath, "utf8"));
  } catch {
    return [];
  }
}

const adapter = {
  type: "opencode",
  name: "Process fixture OpenCode",
  async init() {},
  async listSessions() { return readSessions(); },
  async getSession(id) { return (await readSessions()).find((session) => session.id === id) || null; },
  async createSession(options) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const sessions = await readSessions();
    const created = {
      id: `session-${sessions.length + 1}`,
      harness: "opencode",
      status: "idle",
      title: options.name,
      cwd: options.cwd,
      lastActivity: new Date().toISOString(),
      needsPermission: false,
    };
    sessions.push(created);
    await writeFile(storePath, JSON.stringify(sessions));
    return created;
  },
  async sendMessage() { return { ok: true }; },
  async stopSession() { return { ok: true }; },
  async respondPermission() { return { ok: true }; },
  async setPermissions() { return { ok: true }; },
};

const result = await newOrResumeNamedSession(new Map([["opencode", adapter]]), {
  harness: "opencode",
  name: "repair_100",
  cwd,
  message,
  mode: "queue",
});
process.stdout.write(JSON.stringify(result));
