import { createHash } from "node:crypto";

/**
 * Stable short reference for one native session.
 *
 * Full native ids are long (zai::route%3A<uuid>), so every surface that
 * lists sessions also shows a short id and every lookup path accepts it as
 * the sessionId. The value is derived deterministically from the harness and
 * the native id: the same chat keeps the same short id forever, across
 * restarts and hosts, without any stored counter.
 */
const HARNESS_PREFIXES: Record<string, string> = {
  codex: "c",
  chatgpt: "g",
  zai: "z",
  opencode: "o",
  claude: "l",
  zcode: "k",
  hermes: "h",
  qoder: "q",
  "fast-agent": "f",
  "minimax-code": "m",
  "browser-chat": "b",
};

/** Short id shape: one harness letter plus four hex characters (z3f9a). */
export const SHORT_ID_PATTERN = /^[a-z][0-9a-f]{4}$/;

export function sessionShortId(harness: string, nativeSessionId: string): string {
  const prefix = HARNESS_PREFIXES[harness] ?? (harness[0]?.toLowerCase() ?? "s");
  const digest = createHash("sha256").update(`${harness}::${nativeSessionId}`).digest("hex");
  return `${prefix}${digest.slice(0, 4)}`;
}

/** True when a reference looks like a short id rather than a native id form. */
export function isShortSessionId(value: string): boolean {
  return SHORT_ID_PATTERN.test(value);
}
