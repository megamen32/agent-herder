import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgentHerderMcpServer } from "../src/index.js";
import { HumanRequestRegistry } from "../src/human-request/registry.js";

const cleanup: Array<() => Promise<void>> = [];
beforeAll(() => mkdir(join(process.cwd(), ".tmp"), { recursive: true }));
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const indexPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const deadline = "2027-01-01T00:00:00Z";
const waitId = "wait_" + "a".repeat(32);

/**
 * The durable HumanRequest join is only real when the running service wires the
 * registry into its own MCP server factory.
 *
 * `resume_after` binds a question deadline to a native wake through
 * `HumanRequestRegistry`. The tool already requires the registry, but the
 * process-owned factory that builds the production MCP server never passed it,
 * so every live `resume_after` join died with "Resume-after HumanRequest
 * binding requires the durable registry" — a defect invisible to the isolated
 * MCP tests, which construct the server with the registry by hand.
 */
describe("production resume_after HumanRequest join wiring", () => {
  it("shares one option set that carries the durable registry to both MCP transports", async () => {
    const source = await readFile(indexPath, "utf8");

    // One shared option set is the only way both transports stay equally
    // capable: a per-transport option list is what let the join disappear
    // from the live service while the isolated tests still passed.
    const shared = source.match(/const sharedMcpServerOptions = \{([\s\S]*?)\n  \};/);
    expect(shared, "the production MCP server must build from one shared option set").not.toBeNull();
    expect(shared![1]).toMatch(/\bhumanRequests\b/);

    // Both transports must spread that shared set instead of repeating their
    // own option list.
    const factories = [...source.matchAll(/createAgentHerderMcpServer\(cdpChatDriver, \{([\s\S]*?)\}\);/g)]
      .map((match) => match[1]);

    expect(factories.length).toBeGreaterThanOrEqual(2);
    for (const factory of factories) {
      expect(factory, "each MCP transport must spread the shared option set")
        .toMatch(/\.\.\.sharedMcpServerOptions/);
    }
  });

  it("keeps the HTTP answer path wired to the same durable join", async () => {
    const source = await readFile(indexPath, "utf8");

    // The answer side must invalidate the bound wake through the very same
    // service that owns the wait, otherwise a canonical answer and a timeout
    // wake can both fire.
    expect(source).toMatch(/humanRequestJoin:\s*\(requestId:\s*string,\s*reason:\s*string\)\s*=>\s*resumeAfterRuntime\.service\.invalidateByHumanRequest\(/);
  });
});

/**
 * Behavioral proof of the same seam.
 *
 * The source assertions above pin the wiring; this one proves the wiring is
 * what makes the live call succeed. A pending question bound to the owner and
 * the registry that the production factory supplies: the join must bind, and
 * the durable record must then own the wait id, so a timeout and an answer can
 * be arbitrated against exactly one of them.
 */
describe("resume_after HumanRequest join with the registry the production factory supplies", () => {
  async function fixture() {
    const directory = await mkdtemp(join(process.cwd(), ".tmp/resume-after-prod-join-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));

    const humanRequests = new HumanRequestRegistry(join(directory, "human-requests.json"));
    const request = await humanRequests.create({ kind: "user", target: { harness: "codex", sessionId: "owner" } });

    const server = createAgentHerderMcpServer(undefined, {
      humanRequests,
      resumeAfter: {
        register: async (input: Record<string, unknown>) => ({
          id: waitId,
          owner: input.owner,
          dependencies: [],
          message: input.message,
          createdAt: new Date().toISOString(),
          state: "waiting",
          trigger: input.trigger,
          humanRequestId: input.humanRequestId,
          expiresAt: input.expiresAt,
        }),
        get: async () => null,
        cancel: async () => null,
      } as never,
    });

    const client = new Client({ name: "prod-join-canary", version: "1" }, { versionNegotiation: { mode: "auto" } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(async () => { await client.close(); await server.close(); });

    return { client, humanRequests, request };
  }

  it("binds the wake to the pending question instead of refusing for a missing registry", async () => {
    const { client, humanRequests, request } = await fixture();

    const call = await client.callTool({
      name: "resume_after",
      arguments: {
        owner: { harness: "codex", sessionId: "owner" },
        requestId: "prod-join-binding",
        message: "continue after the canonical answer",
        humanRequestId: request.requestId,
        expiresAt: deadline,
        trigger: { kind: "at", at: deadline },
      },
    });

    expect(call.isError).not.toBe(true);

    // The durable registry now owns the wait: the question points at the wake,
    // so a timeout or an answer can be arbitrated against exactly one of them.
    const durable = await humanRequests.get(request.requestId);
    expect(durable?.resumeWaitId).toBe(waitId);
  });

  it("still refuses a foreign question target before binding", async () => {
    const { client, humanRequests } = await fixture();
    const foreign = await humanRequests.create({ kind: "user", target: { harness: "codex", sessionId: "stranger" } });

    const call = await client.callTool({
      name: "resume_after",
      arguments: {
        owner: { harness: "codex", sessionId: "owner" },
        requestId: "prod-join-foreign",
        message: "continue after the canonical answer",
        humanRequestId: foreign.requestId,
        expiresAt: deadline,
        trigger: { kind: "at", at: deadline },
      },
    });

    expect(call.isError).toBe(true);
    const durable = await humanRequests.get(foreign.requestId);
    expect(durable?.resumeWaitId).toBeUndefined();
  });
});
