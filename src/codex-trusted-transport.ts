import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";

export const TRUSTED_LOOPBACK_CONFIG = Object.freeze({
  openai_base_url: "http://127.0.0.1:18127/backend-api/codex",
  features: Object.freeze({ enable_request_compression: false }),
});
export type TrustedTransportConfig = Readonly<typeof TRUSTED_LOOPBACK_CONFIG>;
export type TrustedOperatorProfile = { enabled: boolean; mappings: Record<string, unknown> };

function exactConfig(value: unknown): TrustedTransportConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("trusted operator mapping must be an object");
  const v = value as Record<string, unknown>;
  if (v.openai_base_url !== TRUSTED_LOOPBACK_CONFIG.openai_base_url) throw new Error("trusted operator mapping has invalid loopback URL");
  const f = v.features;
  if (!f || typeof f !== "object" || Array.isArray(f) || (f as Record<string, unknown>).enable_request_compression !== false || Object.keys(f as object).length !== 1 || Object.keys(v).sort().join(",") !== "features,openai_base_url") throw new Error("trusted operator mapping has unsupported keys");
  return TRUSTED_LOOPBACK_CONFIG;
}

function validId(id: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id); }

export async function loadTrustedOperatorProfile(path = process.env.CODEX_TRUSTED_OPERATOR_FILE): Promise<TrustedOperatorProfile | undefined> {
  if (!path?.trim()) return undefined;
  const filename = path.trim();
  if (!isAbsolute(filename)) throw new Error("trusted operator file must use an absolute path");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let parsed: unknown;
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.uid !== (process.getuid?.() ?? s.uid) || (s.mode & 0o777) !== 0o600 || s.size > 65536) {
      throw new Error("trusted operator file must be a bounded regular file owned by the runtime user and mode 0600");
    }
    const raw = await handle.readFile("utf8");
    if (Buffer.byteLength(raw) > 65536) throw new Error("trusted operator file exceeds budget");
    parsed = JSON.parse(raw) as unknown;
  } finally { await handle.close(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("trusted operator profile must be an object");
  const p = parsed as Record<string, unknown>;
  if (typeof p.enabled !== "boolean" || !p.mappings || typeof p.mappings !== "object" || Array.isArray(p.mappings) || Object.keys(p).sort().join(",") !== "enabled,mappings") throw new Error("trusted operator profile schema invalid");
  const mappings: Record<string, unknown> = {};
  for (const [id, config] of Object.entries(p.mappings as Record<string, unknown>)) { if (!validId(id)) throw new Error("trusted operator profile has invalid thread id"); mappings[id] = exactConfig(config); }
  return { enabled: p.enabled, mappings };
}

export function trustedTransportResolver(profile: TrustedOperatorProfile | undefined): ((threadId: string) => TrustedTransportConfig | undefined) | undefined {
  if (!profile?.enabled) return undefined;
  return (threadId: string) => profile.mappings[threadId] as TrustedTransportConfig | undefined;
}

