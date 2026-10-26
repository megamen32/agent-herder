/** Native caller identity supplied by an MCP client in request metadata. */
export type CallerSession = { harness: "opencode" | "zcode" | "codex"; sessionId: string };

const MAX_SESSION_ID_LENGTH = 512;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedId(value: unknown, requireOpenCodePrefix: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const sessionId = value.trim();
  if (!sessionId || sessionId.length > MAX_SESSION_ID_LENGTH) return undefined;
  if (requireOpenCodePrefix && !sessionId.startsWith("ses_")) return undefined;
  return sessionId;
}

/**
 * Extract a native harness session from documented, request-scoped MCP metadata.
 * This is attribution only; callers must still apply their normal authorization.
 */
export function callerSessionFromMcpContext(context: unknown): CallerSession | null {
  const mcpReq = record(record(context)?.mcpReq);
  const meta = record(mcpReq?._meta);
  if (!meta) return null;

  const hasOpenCode = Object.hasOwn(meta, "ai.opencode/sessionID");
  const hasZcode = Object.hasOwn(meta, "com.zcode/request-context");
  const hasCodexThread = Object.hasOwn(meta, "threadId");
  const zcode = record(meta["com.zcode/request-context"]);
  const openCodeId = hasOpenCode ? boundedId(meta["ai.opencode/sessionID"], true) : undefined;
  const zcodeId = zcode ? boundedId(zcode.session_id, false) : undefined;
  const codexId = hasCodexThread ? boundedId(meta.threadId, false) : undefined;
  const providers = Number(hasOpenCode) + Number(hasZcode) + Number(hasCodexThread);

  // Conflicting or malformed native metadata must never select a different owner.
  if (providers !== 1) return null;
  if (hasOpenCode) {
    return openCodeId ? { harness: "opencode", sessionId: openCodeId } : null;
  }
  if (hasZcode) {
    return zcodeId ? { harness: "zcode", sessionId: zcodeId } : null;
  }
  if (hasCodexThread) {
    return codexId ? { harness: "codex", sessionId: codexId } : null;
  }
  return null;
}
