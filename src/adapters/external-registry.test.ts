import { describe, expect, it } from "vitest";
import type { HarnessAdapter } from "../types/index.js";
import {
  EXTERNAL_ADAPTERS_ENV,
  applyExternalAdapterOverrides,
  parseExternalAdapterEntries,
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

const stubEntry = (overrides: Partial<ExternalAdapterEntry> = {}): ExternalAdapterEntry => ({
  harness: "opencode",
  name: "stub adapter",
  command: process.execPath,
  args: ["-e", AHAP_STUB],
  ...overrides,
});

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

  it("takes over the harness when the external process answers initialize", async () => {
    const builtin = async () => ({ marker: "builtin" } as unknown as HarnessAdapter);
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
    expect(sessions[0]!.hostId).toBeTruthy();
    await adapter.stop();
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
