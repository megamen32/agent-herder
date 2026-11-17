import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

export const TRUSTED_LOOPBACK_CONFIG = Object.freeze({
  openai_base_url: "http://127.0.0.1:18127/backend-api/codex",
  features: Object.freeze({ enable_request_compression: false }),
});
export type TrustedTransportConfig = Readonly<typeof TRUSTED_LOOPBACK_CONFIG>;
export type TrustedOperatorProfile = { enabled: boolean; mappings: Record<string, unknown>; preflightDir?: string };

function exactConfig(value: unknown): TrustedTransportConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("trusted operator mapping must be an object");
  const v = value as Record<string, unknown>;
  if (v.openai_base_url !== TRUSTED_LOOPBACK_CONFIG.openai_base_url) throw new Error("trusted operator mapping has invalid loopback URL");
  const f = v.features;
  if (!f || typeof f !== "object" || Array.isArray(f) || (f as Record<string, unknown>).enable_request_compression !== false || Object.keys(f as object).length !== 1 || Object.keys(v).sort().join(",") !== "features,openai_base_url") throw new Error("trusted operator mapping has unsupported keys");
  return TRUSTED_LOOPBACK_CONFIG;
}

function validId(id: string): boolean { return /^[0-9a-f-]{36}$/i.test(id); }

export async function loadTrustedOperatorProfile(path = process.env.CODEX_TRUSTED_OPERATOR_FILE): Promise<TrustedOperatorProfile | undefined> {
  if (!path?.trim()) return undefined;
  const filename = resolve(path.trim());
  const s = await stat(filename);
  if (s.uid !== (process.getuid?.() ?? s.uid) || (s.mode & 0o077) !== 0) throw new Error("trusted operator file must be owned by the runtime user and mode 0600");
  const parsed = JSON.parse(await readFile(filename, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("trusted operator profile must be an object");
  const p = parsed as Record<string, unknown>;
  if (typeof p.enabled !== "boolean" || !p.mappings || typeof p.mappings !== "object" || Array.isArray(p.mappings)) throw new Error("trusted operator profile schema invalid");
  const mappings: Record<string, unknown> = {};
  for (const [id, config] of Object.entries(p.mappings as Record<string, unknown>)) { if (!validId(id)) throw new Error("trusted operator profile has invalid thread id"); mappings[id] = exactConfig(config); }
  return { enabled: p.enabled, mappings, preflightDir: typeof p.preflightDir === "string" ? resolve(p.preflightDir) : undefined };
}

export function trustedTransportResolver(profile: TrustedOperatorProfile | undefined): ((threadId: string) => TrustedTransportConfig | undefined) | undefined {
  if (!profile?.enabled) return undefined;
  return (threadId: string) => profile.mappings[threadId] as TrustedTransportConfig | undefined;
}

export function trustedTransportPreflight(profile: TrustedOperatorProfile | undefined): ((threadId: string) => Promise<boolean>) | undefined {
  if (!profile?.enabled) return undefined;
  return async (threadId: string) => {
    if (!profile.preflightDir) return false;
    try {
      const filename = resolve(profile.preflightDir, threadId + ".json");
      const s = await stat(filename);
      if (s.uid !== (process.getuid?.() ?? s.uid) || (s.mode & 0o077) !== 0) return false;
      const proof = JSON.parse(await readFile(filename, "utf8")) as Record<string, unknown>;
      if (proof.threadId !== threadId || proof.cold !== true || proof.writerFree !== true || typeof proof.observedAt !== "string") return false;
      const age = Date.now() - Date.parse(proof.observedAt);
      return Number.isFinite(age) && age >= 0 && age <= 30_000;
    } catch { return false; }
  };
}
