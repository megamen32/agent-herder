import { describe, expect, it } from "vitest";
import {
  AgentInfoSchema,
  CreateSessionSchema,
  ExportTranscriptSchema,
  ListAgentsSchema,
  NewOrResumeSchema,
  SendMessageSchema,
  toolDefinitions,
} from "../src/mcp-tools/definitions.js";

function harnessEnum(toolName: string): string[] {
  const tool = toolDefinitions.find((definition) => definition.name === toolName);
  const property = tool?.inputSchema.properties?.harness as { enum?: string[] } | undefined;
  return property?.enum ?? [];
}

describe("canonical MCP harness definitions", () => {
  it("lists Hermes for generic observation, export, and message operations", () => {
    for (const toolName of ["list_agents", "agent_info", "export_transcript", "send_message"]) {
      expect(harnessEnum(toolName), toolName).toContain("hermes");
    }

    expect(ListAgentsSchema.parse({ harness: "hermes" }).harness).toBe("hermes");
    expect(AgentInfoSchema.parse({ sessionId: "conversation-1", harness: "hermes" }).harness).toBe("hermes");
    expect(ExportTranscriptSchema.parse({ sessionId: "conversation-1", harness: "hermes" }).harness).toBe("hermes");
    expect(SendMessageSchema.parse({ sessionId: "conversation-1", harness: "hermes", message: "hello" }).harness).toBe("hermes");
  });

  it("keeps Hermes out of named-session creation and resume", () => {
    expect(harnessEnum("create_session")).not.toContain("hermes");
    expect(harnessEnum("new_or_resume")).not.toContain("hermes");
    expect(() => CreateSessionSchema.parse({ harness: "hermes", name: "x", cwd: "/tmp" })).toThrow();
    expect(() => NewOrResumeSchema.parse({ harness: "hermes", name: "x", cwd: "/tmp", message: "hello" })).toThrow();
  });
});
