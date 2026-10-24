import { afterEach, describe, expect, it, vi } from "vitest";

const TELEGRAM_ROOT = "/home/roomhacker/PycharmProjects/TelegramAuto";

/**
 * The switch of the prohibitions, as the panel leaves it.
 *
 * The switch is the one thing the owner may change about the prohibitions:
 * the guard reads it from the same service the panel writes, and while the
 * prohibitions are on the guard forbids what the rule of the owner forbids.
 */
type SwitchState = "enabled" | "disabled";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * The network of the guard: only the switch of the owner answers.
 *
 * The model of the request is deliberately absent from the native catalog, so
 * the route of that model cannot be confirmed. That is exactly the case the
 * switch of the owner decides: a route that is merely not confirmed follows
 * the switch, while a closed provider and a broken proof do not.
 */
function installNetwork(state: SwitchState) {
  vi.stubEnv("OMNIROUTE_API_KEY", "");
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/hooks/prohibitions") {
      return response({ ok: true, known: true, prohibitionsEnabled: state !== "disabled" });
    }
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/**
 * The guard, loaded fresh.
 *
 * The guard remembers the state of the switch for two seconds, so every case
 * starts with an empty memory of the guard.
 */
async function loadGuard() {
  vi.resetModules();
  const module = await import("../integrations/opencode/agent-herder-autopilot.js");
  return (module as any).default as { setup: (ctx: unknown) => Promise<() => Promise<void>> };
}

/** A root session of a restricted project, and the hook of the model request. */
function makeContext() {
  let modelHook: ((event: any) => Promise<void> | void) | undefined;
  const ctx = {
    event: { subscribe: () => (async function* () {})() },
    permission: { hook: vi.fn(async () => ({ dispose: vi.fn() })) },
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({
        data: { id: sessionID, directory: TELEGRAM_ROOT, model: { providerID: "opencode", id: "gpt-6.1-sol" } },
      })),
      hook: vi.fn(async (_name, callback) => { modelHook = callback; return { dispose: vi.fn() }; }),
    },
    agent: { get: vi.fn(async () => ({ data: undefined })) },
    // The model is not in the native catalog: its route cannot be confirmed.
    model: { list: vi.fn(async () => ({ data: [] })) },
  };
  return {
    ctx,
    get modelHook() { return modelHook!; },
  };
}

/** A model whose route cannot be confirmed: the case the switch of the owner decides. */
const FORBIDDEN_MODEL = { providerID: "opencode", id: "gpt-6.1-sol" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("The switch of the prohibitions of the owner", () => {
  it("refuses a forbidden model request while the prohibitions are on", async () => {
    installNetwork("enabled");
    const context = makeContext();
    const guard = await loadGuard();
    const cleanup = await guard.setup(context.ctx);
    await expect(context.modelHook({ sessionID: "root", model: FORBIDDEN_MODEL }))
      .rejects.toThrow("the complete native provider route is forbidden");
    await cleanup();
  });

  it("lets a forbidden model request pass when the owner switches the prohibitions off", async () => {
    const fetchMock = installNetwork("disabled");
    const context = makeContext();
    const guard = await loadGuard();
    const cleanup = await guard.setup(context.ctx);
    // The guard must ask the panel about the switch: without that question the
    // switch of the owner has no effect at all, and the request stays refused.
    await expect(context.modelHook({ sessionID: "root", model: FORBIDDEN_MODEL })).resolves.toBeUndefined();
    const asked = fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname);
    expect(asked).toContain("/api/hooks/prohibitions");
    await cleanup();
  });
});
