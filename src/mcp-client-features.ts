import type { McpServer } from "@modelcontextprotocol/server";

export interface McpClientFeatures {
  protocolVersion?: string;
  modern: boolean;
  inputRequired: boolean;
  legacyElicitation: boolean;
  taskVocabulary: boolean;
}

/** Centralized compatibility policy so protocol-version checks stay out of domain handlers. */
export function resolveMcpClientFeatures(server: McpServer): McpClientFeatures {
  const protocolVersion = server.server.getNegotiatedProtocolVersion();
  const capabilities = server.server.getClientCapabilities() as Record<string, unknown> | undefined;
  const elicitation = capabilities?.elicitation;
  const modern = protocolVersion === "2026-07-28";
  return {
    protocolVersion,
    modern,
    inputRequired: modern && Boolean(elicitation),
    legacyElicitation: !modern && Boolean(elicitation),
    taskVocabulary: Boolean(capabilities?.tasks),
  };
}
