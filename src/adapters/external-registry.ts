import { isAbsolute } from "node:path";
import type { HarnessAdapter, HarnessType } from "../types/index.js";
import { ExternalProcessAdapter } from "./external-process.js";

/**
 * Env-configured external adapter processes (AHAP — see
 * docs/external-adapter-protocol.md). One JSON entry names a harness and an
 * executable; the external process takes over that harness's adapter when it
 * starts and answers `initialize`. When it cannot start, the builtin
 * TypeScript adapter keeps the harness alive, so a broken binary never takes
 * a driver down with it.
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

/**
 * Wrap one harness factory: the external process wins when it starts and
 * answers initialize; otherwise the builtin adapter keeps the harness alive.
 */
export function withExternalAdapterFallback(entry: ExternalAdapterEntry, builtin: AdapterFactory): AdapterFactory {
  return async () => {
    const external = new ExternalProcessAdapter({
      harness: entry.harness as HarnessType,
      name: entry.name,
      command: entry.command,
      ...(entry.args ? { args: entry.args } : {}),
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      ...(entry.env && Object.keys(entry.env).length ? { env: entry.env } : {}),
      ...(entry.requestTimeoutMs ? { requestTimeoutMs: entry.requestTimeoutMs } : {}),
      ...(entry.shutdownGraceMs ? { shutdownGraceMs: entry.shutdownGraceMs } : {}),
    });
    try {
      await external.init();
      console.error(`[agent-herder] external adapter active for ${entry.harness}: ${entry.command}`);
      return external;
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      console.error(`[agent-herder] external adapter unavailable for ${entry.harness} (${reason}); builtin adapter retained`);
      void external.stop().catch(() => undefined);
      return await builtin();
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
