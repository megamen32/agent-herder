import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeAdapter } from "../src/adapters/opencode.js";
import { IntegratorSessionBindingStore } from "../src/integrator-session-binding.js";
import { IntegratorFleetRuntime } from "../src/integrator-fleet-runtime.js";
import { AutomationLaunchPolicyStore } from "../src/automation-launch-policy.js";
import { CODEX_PROJECT_MODEL_ID } from "../src/project-runtime-policy.js";

/**
 * A stand-in for the OpenCode 2 server: it creates one native session and
 * answers nothing else. The identity announcement is best effort, so an
 * unanswered request is exactly what the adapter must survive.
 */
class FakeOpenCode {
  private readonly server: Server;
  private created = 0;

  constructor() {
    this.server = createServer((req, res) => { void this.handle(req, res); });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** How many native sessions the server created. */
  get createdCount(): number {
    return this.created;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/config") { this.json(res, {}); return; }
    if (url.pathname === "/api/model") {
      this.json(res, [{ providerID: "anthropic", id: "claude-sonnet-4-5", modelID: "claude-sonnet-4-5" }]);
      return;
    }
    if (url.pathname === "/api/session" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}") as { title?: string; location?: { directory?: string } };
      this.created += 1;
      this.json(res, {
        id: `ses_created_${this.created}`,
        title: typeof body.title === "string" ? body.title : "",
        location: { directory: body.location?.directory ?? "" },
        time: { created: Date.now(), updated: Date.now() },
        outcome: "completed",
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ _tag: "NotFoundError" }));
  }

  private json(res: ServerResponse, value: unknown): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: value }));
  }
}

const roots: string[] = [];
const servers: FakeOpenCode[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "herder-opencode-receipt-"));
  roots.push(root);
  return root;
}

async function server(): Promise<string> {
  const fake = new FakeOpenCode();
  servers.push(fake);
  return fake.start();
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((fake) => fake.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("opencode integrator receipt", () => {
  it("writes the created receipt of the reserved operation through recordCreated", async () => {
    const root = await workspace();
    const url = await server();
    const store = new IntegratorSessionBindingStore({ persistencePath: join(root, "bindings.json") });
    const reserved = await store.reserve({ operationId: "task-op-opencode", hostId: "server-100", harness: "opencode" });
    expect(reserved.claimed).toBe(true);
    const adapter = new OpenCodeAdapter({
      baseUrl: url,
      protocol: "v2",
      integratorSessionBindingStore: store,
      integratorReservation: {
        operationId: "task-op-opencode",
        attempt: reserved.attempt.attempt,
        inputId: reserved.attempt.inputId,
        hostId: "server-100",
        harness: "opencode",
      },
    });

    const session = await adapter.createSession({ name: "task", cwd: root });

    expect(session.id).toBe("ses_created_1");
    const binding = await store.get("task-op-opencode");
    expect(binding?.state).toBe("accepted");
    expect(binding?.harness).toBe("opencode");
    expect(binding?.attempts.at(-1)?.state).toBe("accepted");
    expect(binding?.attempts.at(-1)?.address).toEqual({ hostId: "server-100", harness: "opencode", nativeSessionId: session.id });
    expect(binding?.attempts.at(-1)?.receipt).toEqual({
      state: "created",
      inputId: reserved.attempt.inputId,
      address: { hostId: "server-100", harness: "opencode", nativeSessionId: session.id },
      launchCwd: root,
      retryable: false,
    });
  });

  it("creates for the selected harness through the runtime: a stable native id and a durable receipt", async () => {
    const root = await workspace();
    await mkdir(join(root, "project"));
    const projectRoot = await realpath(join(root, "project"));
    const fake = new FakeOpenCode();
    servers.push(fake);
    const url = await fake.start();
    const previousUrl = process.env.OPENCODE_URL;
    process.env.OPENCODE_URL = url;
    try {
      const policyStore = new AutomationLaunchPolicyStore(join(root, "launch-policy.json"));
      await policyStore.replace({
        version: 1,
        allowedHarnesses: ["codex", "opencode"],
        preferredHarness: "codex",
        models: { codex: CODEX_PROJECT_MODEL_ID, opencode: "anthropic/claude-sonnet-4-5" },
        projectRoutes: {
          [projectRoot]: { harnesses: ["opencode"], aliases: ["project-alpha"], models: { opencode: "anthropic/claude-sonnet-4-5" } },
        },
      });
      const bindingStore = new IntegratorSessionBindingStore({ persistencePath: join(root, "h34.json") });
      const runtime = new IntegratorFleetRuntime({ policyStore, bindingStore, codexDataHome: join(root, "codex-home") });
      const inputId = "9".repeat(64);

      const receipt = await runtime.create({ project: "project-alpha", inputId, name: "task", cwd: projectRoot, harness: "opencode" });

      expect(receipt).toMatchObject({ state: "created", inputId, launchCwd: projectRoot,
        address: { hostId: hostname(), harness: "opencode", nativeSessionId: "ses_created_1" } });
      const binding = await bindingStore.get(inputId);
      expect(binding?.harness).toBe("opencode");
      expect(binding?.state).toBe("accepted");
      expect(binding?.attempts.at(-1)?.receipt?.state).toBe("created");
      expect(binding?.attempts.at(-1)?.address?.nativeSessionId).toBe("ses_created_1");
      // A repeated create must not open a second native session.
      const repeated = await runtime.create({ project: "project-alpha", inputId, name: "task", cwd: projectRoot, harness: "opencode" });
      expect(repeated).toEqual(receipt);
      expect(fake.createdCount).toBe(1);
      await runtime.dispose();
    } finally {
      if (previousUrl === undefined) delete process.env.OPENCODE_URL;
      else process.env.OPENCODE_URL = previousUrl;
    }
  });

  it("writes no receipt when the adapter serves no reserved operation", async () => {
    const root = await workspace();
    const url = await server();
    const store = new IntegratorSessionBindingStore({ persistencePath: join(root, "bindings.json") });
    const adapter = new OpenCodeAdapter({ baseUrl: url, protocol: "v2", integratorSessionBindingStore: store });

    const session = await adapter.createSession({ name: "task", cwd: root });

    expect(session.id).toBe("ses_created_1");
    expect(await store.get("task-op-opencode")).toBeNull();
  });
});
