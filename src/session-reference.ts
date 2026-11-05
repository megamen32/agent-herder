export type SessionReference = { id: string; harness?: string; hostId?: string };

/** Parse a native ID or an explicit session link without guessing its owner. */
export function parseSessionReference(input: string): SessionReference {
  let value = input.trim();
  let hostId: string | undefined;
  let forcedHarness: string | undefined;
  if (/^codex:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.hostname !== "threads") throw new Error("invalid_session_reference");
    value = decodeURIComponent(url.pathname.replace(/^\//, ""));
    hostId = url.searchParams.get("hostId") || undefined;
    forcedHarness = "codex";
  } else if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!url.hash.startsWith("#/session/")) throw new Error("invalid_session_reference");
    value = decodeURIComponent(url.hash.slice("#/session/".length));
  } else {
    value = decodeURIComponent(value);
  }
  const match = value.match(/^(opencode|claude|codex|qoder|hermes|zcode|fast-agent|chatgpt|zai|minimax-code|browser-chat)::?(.+)$/);
  const harness = match?.[1] ?? forcedHarness;
  const id = match?.[2] ?? value;
  if (!id || /[\x00-\x1f\x7f]/.test(id) || (forcedHarness && harness !== forcedHarness)) throw new Error("invalid_session_reference");
  return { id, ...(harness ? { harness } : {}), ...(hostId ? { hostId } : {}) };
}

/** Preserve explicit identity constraints and reject contradictory links. */
export function normalizeSessionReference<T extends {sessionId?:string;harness?:string;hostId?:string}>(args:T):T {
  if (!args.sessionId) return args;
  const ref = parseSessionReference(args.sessionId);
  if (ref.harness && args.harness && ref.harness !== args.harness) throw new Error("session_reference_harness_conflict");
  if (ref.hostId && args.hostId && ref.hostId.toLowerCase() !== args.hostId.toLowerCase()) throw new Error("session_reference_host_conflict");
  return {...args, sessionId:ref.id, ...(ref.harness ? {harness:ref.harness} : {}), ...(ref.hostId ? {hostId:ref.hostId} : {})};
}
