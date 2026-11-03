import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "../types/index.js";
import {
  EXTERNAL_ADAPTERS_ENV,
  applyExternalAdapterOverrides,
  applyExternalAdapterOverridesToLiveAdapters,
  parseExternalAdapterEntries,
  splitExternalAdapter,
  withExternalAdapterFallback,
  type ExternalAdapterEntry,
} from "./external-registry.js";

/** A minimal AHAP stub in one node -e command: initialize + listSessions. */
const AHAP_STUB = [
  "const rl=require('node:readline').createInterface({input:process.stdin});",
  "const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');",
  "rl.on('line',l=>{const m=JSON.parse(l);const r={jsonrpc:'2.0',id:m.id};",
  "if(m.method==='initialize')r.result={harness:'opencode',name:'stub',capabilities:{methods:['init','listSessions'],controlCapabilities:{cancelTurn:false}}};",
  "else if(m.method==='init')r.result={};",
  "else if(m.method==='listSessions')r.result=[{id:'s1',harness:'opencode',status:'idle',title:'Stub session',cwd:'/tmp',lastActivity:'2026-01-01T00:00:00.000Z',hostId:''}];",
  "else if(m.method==='shutdown'){out({jsonrpc:'2.0',id:m.id,result:{}});process.exit(0);}",
  "else r.error={code:-32601,message:'method not implemented'};",
  "out(r);});",
].join("");

/** Answers initialize, then exits ~150 ms later: the "subprocess died" case. */
const AHAP_DYING_STUB = [
  "const rl=require('node:readline').createInterface({input:process.stdin});",
  "const out=o=>process.stdout.write(JSON.stringify(o)+'\\n');",
  "rl.on('line',l=>{const m=JSON.parse(l);const r={jsonrpc:'2.0',id:m.id};",
  "if(m.method==='initialize'){r.result={harness:'opencode',name:'dying stub',capabilities:{methods:['init','listSessions'],controlCapabilities:{cancelTurn:false}}};out(r);setTimeout(()=>process.exit(0),150);}",
  "else if(m.method==='init')r.result={};",
  "else if(m.method==='listSessions')r.result=[{id:'external-session',harness:'opencode',status:'idle',title:'E',cwd:'/tmp',lastActivity:'2026-01-01T00:00:00.000Z',hostId:''}];",
  "else if(m.method==='shutdown'){out({jsonrpc:'2.0',id:m.id,result:{}});process.exit(0);}",
  "else r.error={code:-32601,message:'method not implemented'};",
  "out(r);});",
].join("");

const stubEntry = (overrides: Partial<ExternalAdapterEntry> = {}): ExternalAdapterEntry => ({
  harness: "opencode",
  name: "stub adapter",
  command: process.execPath,
  args: ["-e", AHAP_STUB],
  ...overrides,
});

/** A builtin adapter stand-in: full control surface, its own listSessions. */
const builtinStub = (extra: Record<string, unknown> = {}): HarnessAdapter => ({
  type: "opencode",
  name: "builtin adapter",
  controlCapabilities: { cancelTurn: true, resume: true },
  async init() { /* already initialized */ },
  isReady: () => true,
  async listSessions() {
    return [{ id: "builtin-session", harness: "opencode", status: "idle", title: "Builtin session", cwd: "/tmp", lastActivity: "2026-01-01T00:00:00.000Z", hostId: "host-1" }];
  },
  async sendMessage(id: string) { return { ok: true, sessionId: id } as never; },
  async stop() { /* nothing to clean */ },
  ...extra,
} as unknown as HarnessAdapter);

describe("external adapter registry", () => {
  it("parses valid entries and rejects invalid configuration loudly", () => {
    expect(parseExternalAdapterEntries(undefined)).toEqual([]);
    expect(parseExternalAdapterEntries("  ")).toEqual([]);
    expect(parseExternalAdapterEntries('[{"harness":"codex","command":"/usr/local/bin/adapter"}]')).toHaveLength(1);
    expect(() => parseExternalAdapterEntries("not json")).toThrow();
    expect(() => parseExternalAdapterEntries("[]")).toThrow();
    expect(() => parseExternalAdapterEntries('[{"harness":"nope","command":"/bin/x"}]')).toThrow(/unsupported/);
    expect(() => parseExternalAdapterEntries('[{"harness":"codex","command":"relative/path"}]')).toThrow(/command_invalid/);
    expect(() => parseExternalAdapterEntries('[{"harness":"codex","command":"/bin/x"},{"harness":"codex","command":"/bin/y"}]')).toThrow(/duplicate/);
    expect(() => parseExternalAdapterEntries('[{"harness":"codex","command":"/bin/x","env":{"A":1}}]')).toThrow(/env_invalid/);
  });

  it("falls back to the builtin adapter when the external process cannot start", async () => {
    let builtinCalls = 0;
    const builtin = async () => {
      builtinCalls += 1;
      return { marker: "builtin" } as unknown as HarnessAdapter;
    };
    const factory = withExternalAdapterFallback(stubEntry({ command: "/nonexistent/adapter-binary" }), builtin);
    const adapter = (await factory()) as unknown as { marker: string };
    expect(adapter.marker).toBe("builtin");
    expect(builtinCalls).toBe(1);
  });

  it("takes over the harness reads when the external process answers initialize", async () => {
    const builtin = async () => builtinStub();
    const factory = withExternalAdapterFallback(stubEntry({ requestTimeoutMs: 5000 }), builtin);
    const adapter = (await factory()) as unknown as {
      type: string;
      name: string;
      listSessions(): Promise<Array<{ id: string; title: string; hostId: string }>>;
      stop(): Promise<void>;
    };
    expect(adapter.type).toBe("opencode");
    expect(adapter.name).toBe("stub adapter");
    const sessions = await adapter.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe("s1");
    expect(sessions[0]!.title).toBe("Stub session");
    expect(sessions[0]!.hostId).toBeTruthy();
    await adapter.stop();
  });

  it("splits reads to the external process and control to the builtin adapter", async () => {
    const sent: string[] = [];
    const builtin = async () => builtinStub({
      async sendMessage(id: string) { sent.push(`builtin:${id}`); return { ok: true } as never; },
    });
    const factory = withExternalAdapterFallback(stubEntry({ requestTimeoutMs: 5000 }), builtin);
    const adapter = (await factory()) as unknown as {
      type: string;
      name: string;
      controlCapabilities: { cancelTurn: boolean; resume: boolean };
      listSessions(): Promise<Array<{ id: string }>>;
      sendMessage(id: string): Promise<{ ok: boolean }>;
      stop(): Promise<void>;
    };
    // identity: the external process names the adapter that serves reads
    expect(adapter.type).toBe("opencode");
    expect(adapter.name).toBe("stub adapter");
    // control truth stays with the builtin adapter
    expect(adapter.controlCapabilities.cancelTurn).toBe(true);
    expect(adapter.controlCapabilities.resume).toBe(true);
    // reads are served by the external process
    const sessions = await adapter.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["s1"]);
    // control is served by the builtin adapter
    await adapter.sendMessage("s1");
    expect(sent).toEqual(["builtin:s1"]);
    await adapter.stop();
  });

  it("serves a read from the builtin adapter when the external process dies", async () => {
    const factory = withExternalAdapterFallback(
      stubEntry({ args: ["-e", AHAP_DYING_STUB], requestTimeoutMs: 5000 }),
      async () => builtinStub(),
    );
    const adapter = (await factory()) as unknown as { listSessions(): Promise<Array<{ id: string }>> };
    // the stub exits ~150 ms after answering initialize
    await new Promise((resolve) => setTimeout(resolve, 400));
    const sessions = await adapter.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["builtin-session"]);
  });

  it("wraps the live adapter map from the environment after the init barrier", async () => {
    const adapters = new Map<string, HarnessAdapter>([["opencode", builtinStub()]]);
    await applyExternalAdapterOverridesToLiveAdapters(
      adapters,
      JSON.stringify([{ harness: "opencode", name: "stub adapter", command: process.execPath, args: ["-e", AHAP_STUB], requestTimeoutMs: 5000 }]),
    );
    const hybrid = adapters.get("opencode") as unknown as {
      name: string;
      controlCapabilities: { cancelTurn: boolean };
      listSessions(): Promise<Array<{ id: string }>>;
      sendMessage(id: string): Promise<{ ok: boolean }>;
      stop(): Promise<void>;
    };
    expect(hybrid).toBeDefined();
    expect(hybrid.name).toBe("stub adapter");
    expect(hybrid.controlCapabilities.cancelTurn).toBe(true);
    const sessions = await hybrid.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(["s1"]);
    await hybrid.sendMessage("s1");
    await hybrid.stop();
  });

  it("leaves the live adapter map untouched for harnesses without an entry", async () => {
    const builtin = builtinStub();
    const adapters = new Map<string, HarnessAdapter>([["opencode", builtin]]);
    await applyExternalAdapterOverridesToLiveAdapters(adapters, JSON.stringify([{ harness: "codex", command: "/bin/true" }]));
    expect(adapters.get("opencode")).toBe(builtin);
    expect(adapters.has("codex")).toBe(false);
  });

  it("keeps every builtin-only surface reachable through the split", () => {
    const calls: string[] = [];
    const builtin = builtinStub({
      async findNamedSessions() { calls.push("findNamedSessions"); return []; },
      async invalidateHistory() { calls.push("invalidateHistory"); },
      getNativeWorkspaceDirectory: (id: string) => { calls.push("getNativeWorkspaceDirectory:" + id); return null; },
    });
    const external = {
      type: "opencode",
      name: "go reader",
      declaredMethods: new Set(["init", "listSessions", "getSession", "getSessionMessages", "subscribeEvents"]),
      isReady: () => true,
      init: async () => undefined,
      stop: async () => undefined,
      subscribeEvents: () => () => undefined,
      listSessions: async () => [],
      getSession: async () => null,
      getSessionMessages: async () => [],
    } as unknown as import("./external-process.js").ExternalProcessAdapter;
    const hybrid = splitExternalAdapter(external, builtin) as unknown as {
      findNamedSessions(): Promise<unknown[]>;
      invalidateHistory(): Promise<void>;
      getNativeWorkspaceDirectory(id: string): unknown;
    };
    expect(typeof hybrid.findNamedSessions).toBe("function");
    void hybrid.findNamedSessions();
    void hybrid.invalidateHistory();
    void hybrid.getNativeWorkspaceDirectory("s1");
    expect(calls).toEqual(["findNamedSessions", "invalidateHistory", "getNativeWorkspaceDirectory:s1"]);
  });

  it("serves an exact getSession the external reader cannot resolve from the builtin adapter", async () => {
    const row = { id: "ses_live", harness: "opencode" } as unknown as import("../types/index.js").AgentSession;
    const builtin = builtinStub({ async getSession(id: string) { return id === "ses_live" ? row : null; } });
    const external = {
      type: "opencode", name: "go reader",
      declaredMethods: new Set(["init", "getSession"]),
      isReady: () => true, init: async () => undefined, stop: async () => undefined,
      getSession: async () => null,
    } as unknown as import("./external-process.js").ExternalProcessAdapter;
    const hybrid = splitExternalAdapter(external, builtin);
    expect(await hybrid.getSession("ses_live")).toBe(row);
    expect(await hybrid.getSession("ses_missing")).toBeNull();
  });

  it("overrides factory entries from the environment before the registry captures them", async () => {
    const factories = new Map<string, () => Promise<HarnessAdapter>>([
      ["opencode", async () => ({ marker: "builtin" } as unknown as HarnessAdapter)],
      ["codex", async () => ({ marker: "builtin-codex" } as unknown as HarnessAdapter)],
    ]);
    applyExternalAdapterOverrides(
      factories,
      JSON.stringify([{ harness: "opencode", command: process.execPath, args: ["-e", AHAP_STUB], requestTimeoutMs: 5000 }]),
    );
    const adapter = (await factories.get("opencode")!()) as unknown as { type: string; stop(): Promise<void> };
    expect(adapter.type).toBe("opencode");
    expect(await factories.get("codex")!()).toEqual({ marker: "builtin-codex" });
    await adapter.stop();
  });

  it("keeps factories untouched when the env names no known harness", () => {
    const factories = new Map<string, () => Promise<HarnessAdapter>>([["codex", async () => ({}) as unknown as HarnessAdapter]]);
    applyExternalAdapterOverrides(factories, JSON.stringify([{ harness: "zai", command: "/bin/true" }]));
    expect(factories.get("zai")).toBeUndefined();
    expect(factories.get("codex")).toBeDefined();
    expect(EXTERNAL_ADAPTERS_ENV).toBe("AGENT_HERDER_EXTERNAL_ADAPTERS");
  });
});
