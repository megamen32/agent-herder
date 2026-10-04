import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SessionAutostartStore,
  UnfinishedSessionLauncher,
  UnfinishedSessionStore,
} from "../src/autopilot/unfinished-session-launcher.js";
import { HumanRequestRegistry } from "../src/human-request/index.js";
import { LineageStore } from "../src/lineage-store.js";
import { SessionSupervisor } from "../src/session-supervisor.js";
import type { AgentSession, HarnessAdapter } from "../src/types/index.js";
import { createWebServer } from "../src/web/server.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("human-request completion resume", () => {
  it("resumes the exact ZCode session through Herder and arms autocontinue tracking", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-herder-human-resume-zcode-"));
    const session: AgentSession = {
      id: "zcode-human-gate",
      harness: "zcode",
      status: "needs_input",
      title: "Wait for approved GID login",
      cwd: "/workspace/video",
      lastActivity: new Date().toISOString(),
      needsPermission: false,
    };
    const sent: Array<{ id: string; message: string }> = [];
    const defaultWorkspace = "/workspace/default";
    let selectedWorkspace = defaultWorkspace;
    const adapter: HarnessAdapter = {
      type: "zcode",
      name: "ZCode human-gate fixture",
      async init() {},
      async listSessions(options) {
        selectedWorkspace = options?.cwd ?? defaultWorkspace;
        return selectedWorkspace === session.cwd ? [session] : [];
      },
      async getSession(id) { return id === session.id ? session : null; },
      async resumeSession() { return { ok: true }; },
      async sendMessage(id, input) {
        if (selectedWorkspace !== session.cwd) return { ok: false, error: `wrong workspace: ${selectedWorkspace}` };
        sent.push({ id, message: input.message });
        return { ok: true };
      },
      async stopSession() { return { ok: true }; },
      async respondPermission() { return { ok: true }; },
      async setPermissions() { return { ok: true }; },
    };
    const adapters = new Map<string, HarnessAdapter>([["zcode", adapter]]);
    const unfinishedStore = new UnfinishedSessionStore(join(root, "unfinished.json"));
    const launcher = new UnfinishedSessionLauncher({
      adapters,
      store: unfinishedStore,
      settingsStore: new SessionAutostartStore(join(root, "autocontinue.json"), {}),
    });
    const converter = { async convert() { throw new Error("unused"); } };
    const supervisor = new SessionSupervisor(adapters, converter, new LineageStore(join(root, "lineage.json")), {
      unfinishedSessions: launcher,
    });
    const humanRequests = new HumanRequestRegistry(join(root, "human-requests.json"));
    const request = await humanRequests.create({
      kind: "user",
      target: { agent: "zcode", sessionId: session.id, cwd: session.cwd },
    });
    const server = createWebServer({
      adapters,
      converter,
      humanRequests,
      supervisor,
      sessionObservationManagedExternally: true,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/internal/human-requests/ask-user-completion`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event: "ask.user.completed",
        event_version: 1,
        status: "completed",
        request_id: request.requestId,
        result_ref: randomUUID(),
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ request_id: request.requestId, status: "resumed", continuation: "resume" });
    expect(sent).toHaveLength(1);
    expect(selectedWorkspace).toBe(session.cwd);
    expect(sent[0]?.id).toBe(session.id);
    expect(sent[0]?.message).toContain("Human Request resolved:");
    await expect(unfinishedStore.list()).resolves.toMatchObject([{ harness: "zcode", sessionId: session.id, state: "active" }]);
  });
});
