import { describe, expect, it } from "vitest";
import { selectRelevantTranscriptContext } from "../src/context-retrieval.js";
import { GetTranscriptSchema } from "../src/mcp-tools/definitions.js";
import { handleGetTranscript } from "../src/mcp-tools/handlers.js";
import type { HarnessAdapter } from "../src/types/index.js";

const transcript = [
  "User: Inspect the JWT refresh-token regression.",
  "Assistant: I will investigate the authentication failure.",
  "User: Please refactor the authentication middleware and add a regression test.",
  "Assistant: Refactored the authentication middleware; the regression test now passes.",
  "User: Update the deployment checklist.",
].join("\n\n");

describe("selectRelevantTranscriptContext", () => {
  it("uses a Context Mode-style query to return ranked matching context, not the full transcript", () => {
    const selected = selectRelevantTranscriptContext(transcript, {
      query: "refactoring authentication",
      matchLimit: 2,
      contextMessages: 0,
      maxChars: 10_000,
    });

    expect(selected).toContain("Please refactor the authentication middleware");
    expect(selected).toContain("Refactored the authentication middleware");
    expect(selected).not.toContain("JWT refresh-token regression");
    expect(selected).not.toContain("deployment checklist");
  });

  it("keeps newest-message fallback bounded when the lead has no explicit context question", () => {
    const selected = selectRelevantTranscriptContext(transcript, {
      matchLimit: 2,
      contextMessages: 0,
      maxChars: 10_000,
    });

    expect(selected).toContain("deployment checklist");
    expect(selected).toContain("regression test now passes");
    expect(selected).not.toContain("JWT refresh-token regression");
  });

  it("accepts a lead's context need as a query alias", () => {
    expect(GetTranscriptSchema.parse({ sessionId: "session-1", need: "authentication status" }).need).toBe(
      "authentication status",
    );
  });

  it("honours maxChars even when it needs to mark the result as truncated", () => {
    const selected = selectRelevantTranscriptContext("authentication ".repeat(20), {
      query: "authentication",
      matchLimit: 1,
      contextMessages: 0,
      maxChars: 100,
    });

    expect(selected).toHaveLength(100);
    expect(selected.startsWith("[truncated to 100 characters]")).toBe(true);
  });

  it("bounds a no-match diagnostic when the supplied query is very long", () => {
    const selected = selectRelevantTranscriptContext("unrelated transcript", {
      query: "x".repeat(1_000),
      matchLimit: 1,
      contextMessages: 0,
      maxChars: 100,
    });

    expect(selected.length).toBeLessThanOrEqual(100);
  });

  it("enforces maxChars across the public MCP result, including its header", async () => {
    const session = {
      id: "session-1",
      harness: "codex" as const,
      status: "idle" as const,
      title: "test",
      cwd: "/tmp",
      lastActivity: new Date().toISOString(),
    };
    const adapter = {
      type: "codex",
      name: "test",
      listSessions: async () => [session],
      getSession: async () => session,
      getTranscript: async () => "unrelated transcript",
    } as unknown as HarnessAdapter;

    const result = await handleGetTranscript(new Map([["codex", adapter]]), {
      sessionId: "session-1",
      harness: "codex",
      query: "x".repeat(1_000),
      maxChars: 100,
    });

    expect(result.length).toBeLessThanOrEqual(100);
  });
});
