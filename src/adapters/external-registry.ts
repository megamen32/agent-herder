import { isAbsolute } from "node:path";
import type { HarnessAdapter, HarnessEvent, HarnessType } from "../types/index.js";
import { ExternalProcessAdapter } from "./external-process.js";

/**
 * Env-configured external adapter processes (AHAP — see
 * docs/external-adapter-protocol.md). One JSON entry names a harness and an
 * executable; when the process starts and answers `initialize` it takes over
 * the harness's READ surface (exactly the methods it declared), while the
 * builtin TypeScript adapter keeps control, delivery and every optional
 * surface the subprocess does not implement. When the external process cannot
 * start — or dies later — the builtin adapter serves everything, so a broken
 * binary never takes a driver down with it.
 *
 * AGENT_HERDER_EXTERNAL_ADAPTERS='[{"harness":"codex","command":"/abs/path/adapter"}]'
 */
export const EXTERNAL_ADAPTERS_ENV = "AGENT_HERDER_EXTERNAL_ADAPTERS";

/** Every harness an external process may take over (browser-chat is an alias). */
const SUPPORTED_HARNESSES = new Set<string>([
  "codex", "claude", "opencode", "hermes", "zcode", "qoder", "fast-agent", "chatgpt", "zai", "minimax-code",
]);

export interface ExternalAdapterEntry {
  harness: string;
  name: string;
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
  shutdownGraceMs?: number;
}

/** Parse the external adapter configuration; invalid entries fail loudly. */
export function parseExternalAdapterEntries(raw: string | undefined): ExternalAdapterEntry[] {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return [];
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 12) {
    throw new Error("external_adapters_invalid: expected a JSON array of 1..12 entries");
  }
  const seen = new Set<string>();
  return parsed.map((entry: unknown): ExternalAdapterEntry => {
    if (typeof entry !== "object" || entry === null) throw new Error("external_adapter_entry_invalid");
    const value = entry as Record<string, unknown>;
    const harness = typeof value.harness === "string" ? value.harness : "";
    if (!SUPPORTED_HARNESSES.has(harness)) throw new Error(`external_adapter_harness_unsupported:${harness || "empty"}`);
    if (seen.has(harness)) throw new Error(`external_adapter_duplicate:${harness}`);
    seen.add(harness);
    const command = typeof value.command === "string" ? value.command.trim() : "";
    if (!command || !isAbsolute(command)) throw new Error(`external_adapter_command_invalid:${harness}`);
    const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : `${harness} external adapter`;
    const env: Record<string, string> = {};
    if (value.env !== undefined) {
      if (typeof value.env !== "object" || value.env === null || Array.isArray(value.env)) {
        throw new Error(`external_adapter_env_invalid:${harness}`);
      }
      for (const [key, item] of Object.entries(value.env as Record<string, unknown>)) {
        if (typeof item !== "string") throw new Error(`external_adapter_env_invalid:${harness}`);
        env[key] = item;
      }
    }
    return {
      harness, name, command, env,
      ...(Array.isArray(value.args) && value.args.every((argument): argument is string => typeof argument === "string") ? { args: value.args } : {}),
      ...(typeof value.cwd === "string" && value.cwd.trim() ? { cwd: value.cwd } : {}),
      ...(typeof value.requestTimeoutMs === "number" && Number.isFinite(value.requestTimeoutMs) ? { requestTimeoutMs: value.requestTimeoutMs } : {}),
      ...(typeof value.shutdownGraceMs === "number" && Number.isFinite(value.shutdownGraceMs) ? { shutdownGraceMs: value.shutdownGraceMs } : {}),
    };
  });
}

type AdapterFactory = () => Promise<HarnessAdapter> | HarnessAdapter;

function toExternalProcessAdapter(entry: ExternalAdapterEntry): ExternalProcessAdapter {
  return new ExternalProcessAdapter({
    harness: entry.harness as HarnessType,
    name: entry.name,
    command: entry.command,
    ...(entry.args ? { args: entry.args } : {}),
    ...(entry.cwd ? { cwd: entry.cwd } : {}),
    ...(entry.env && Object.keys(entry.env).length ? { env: entry.env } : {}),
    ...(entry.requestTimeoutMs ? { requestTimeoutMs: entry.requestTimeoutMs } : {}),
    ...(entry.shutdownGraceMs ? { shutdownGraceMs: entry.shutdownGraceMs } : {}),
  });
}

/**
 * Split adapter: the external process serves exactly the methods it declared
 * in `initialize`; the builtin adapter keeps everything else — control,
 * delivery and every optional surface the subprocess does not implement.
 * `type`/`name` come from the external process (the registry and logs show
 * which binary serves the reads); `controlCapabilities` and every other
 * property stay the builtin's, because that is the adapter still driving the
 * harness. Events from both sides fan out to one listener, and when the
 * subprocess dies mid-flight the very next call is served by the builtin
 * adapter: a crashed binary degrades read latency instead of taking the
 * harness down.
 */
export function splitExternalAdapter(external: ExternalProcessAdapter, builtin: HarnessAdapter): HarnessAdapter {
  const advertised = external.declaredMethods;
  const harness = external.type;
  return new Proxy(builtin, {
    get(target: HarnessAdapter, prop: string | symbol): unknown {
      if (typeof prop !== "string") return Reflect.get(target, prop, target);
      if (prop === "type") return external.type;
      if (prop === "name") return external.name;
      if (prop === "isReady") {
        // A live external reader keeps the harness readable even while the builtin
        // native transport is down: the split adapter is ready when either side can
        // serve the next call. The mesh discovery gate relies on this to keep listing
        // sessions through the Go reader instead of starving the whole host.
        return (): boolean => (target.isReady?.() ?? true) || (advertised.has("listSessions") && external.isReady());
      }
      if (prop === "init") {
        return async (): Promise<void> => {
          // Both sides initialize: the external is idempotent (a no-op after
          // the first handshake), the builtin follows its own lazy semantics.
          await Promise.all([
            external.init().catch(() => undefined),
            target.init?.() ?? Promise.resolve(),
          ]);
        };
      }
      if (prop === "stop") {
        return async (): Promise<void> => {
          const builtinStop = (target as { stop?: () => Promise<void> | void }).stop;
          await Promise.allSettled([external.stop(), Promise.resolve(builtinStop?.())]);
        };
      }
      if (prop === "subscribeEvents") {
        return (handler: (event: HarnessEvent) => void): (() => void) => {
          const unsubscribers: Array<() => void> = [];
          if (advertised.has("subscribeEvents")) {
            unsubscribers.push(external.subscribeEvents(handler));
          }
          const builtinSubscribe = target.subscribeEvents;
          if (typeof builtinSubscribe === "function") unsubscribers.push(builtinSubscribe.call(target, handler));
          return () => {
            for (const unsubscribe of unsubscribers) {
              try { unsubscribe(); } catch { /* best effort */ }
            }
          };
        };
      }
      const externalValue = (external as unknown as Record<string, unknown>)[prop];
      if (typeof externalValue === "function" && advertised.has(prop)) {
        const method = prop;
        const externalMethod = externalValue as (...args: unknown[]) => unknown;
        return async (...args: unknown[]): Promise<unknown> => {
          try {
            return await externalMethod.apply(external, args);
          } catch (error) {
            const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
            console.error(`[agent-herder] external adapter call failed for ${harness}.${method} (${reason}); builtin adapter serving this call`);
            const fallback = Reflect.get(target, method, target);
            if (typeof fallback === "function") return (fallback as (...fallbackArgs: unknown[]) => unknown).apply(target, args);
            throw error;
          }
        };
      }
      const builtinValue = Reflect.get(target, prop, target);
      return typeof builtinValue === "function"
        ? (builtinValue as (...callArgs: unknown[]) => unknown).bind(target)
        : builtinValue;
    },
  }) as unknown as HarnessAdapter;
}

/**
 * Start the external adapter for one entry. Resolves with the external
 * adapter when the subprocess answers initialize; resolves with undefined
 * (and logs one line) when it cannot start.
 */
async function startExternalAdapter(entry: ExternalAdapterEntry): Promise<ExternalProcessAdapter | undefined> {
  const external = toExternalProcessAdapter(entry);
  try {
    await external.init();
    console.error(`[agent-herder] external adapter active for ${entry.harness}: ${entry.command}`);
    return external;
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    console.error(`[agent-herder] external adapter unavailable for ${entry.harness} (${reason}); builtin adapter retained`);
    void external.stop().catch(() => undefined);
    return undefined;
  }
}

/**
 * Wrap one harness factory: the external process serves the methods it
 * declares; the builtin adapter keeps the rest. When the external process
 * cannot start, the builtin adapter serves everything.
 */
export function withExternalAdapterFallback(entry: ExternalAdapterEntry, builtin: AdapterFactory): AdapterFactory {
  return async () => {
    const external = await startExternalAdapter(entry);
    if (!external) return await builtin();
    try {
      return splitExternalAdapter(external, await builtin());
    } catch {
      // The builtin could not be constructed; the external read surface is
      // still strictly better than a dead harness.
      return external;
    }
  };
}

/**
 * Apply the env-configured external adapters over the builtin factories.
 * Call before the adapter registry captures the factory references, so the
 * registry serves the wrapped factory.
 */
export function applyExternalAdapterOverrides(
  factories: Map<string, AdapterFactory>,
  raw: string | undefined = process.env[EXTERNAL_ADAPTERS_ENV],
): void {
  for (const entry of parseExternalAdapterEntries(raw)) {
    const builtin = factories.get(entry.harness);
    if (!builtin) {
      console.error(`[agent-herder] external adapter ignored for ${entry.harness}: no builtin factory to fall back to`);
      continue;
    }
    factories.set(entry.harness, withExternalAdapterFallback(entry, builtin));
  }
}

/**
 * Apply the env-configured external adapters over the LIVE adapter map, once
 * every builtin adapter has been constructed and initialized (after the
 * startup init barrier, including lazy-transport late replacements). Each
 * entry's harness keeps its builtin adapter for control and delivery; the
 * external process takes over the read surface it declared. The map is the
 * same instance the mesh, the registry and the fleet API read from, so the
 * split takes effect for every later call.
 */
export async function applyExternalAdapterOverridesToLiveAdapters(
  adapters: Map<string, HarnessAdapter>,
  raw: string | undefined = process.env[EXTERNAL_ADAPTERS_ENV],
): Promise<void> {
  for (const entry of parseExternalAdapterEntries(raw)) {
    const builtin = adapters.get(entry.harness);
    if (!builtin) {
      console.error(`[agent-herder] external adapter ignored for ${entry.harness}: no active builtin adapter to split`);
      continue;
    }
    const external = await startExternalAdapter(entry);
    if (!external) continue;
    adapters.set(entry.harness, splitExternalAdapter(external, builtin));
  }
}
