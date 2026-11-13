import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { UserIoAgentChannel, type UserIoConfig } from "../adapters/userio-agent-channel.js";
import { UserIoDotClient, type DotBinding } from "../adapters/userio-dot.js";
import { structuredValueResult } from "./results.js";

export type UserIoDotBinding = {
  client: UserIoDotClient;
  binding: DotBinding;
};

const required = [
  "AGENT_HERDER_DOT_USERIO_ENDPOINT",
  "AGENT_HERDER_DOT_AGENT_ID",
  "AGENT_HERDER_DOT_INSTANCE_ID",
  "AGENT_HERDER_DOT_ACCOUNT_SCOPE",
  "AGENT_HERDER_DOT_ACCESS_TOKEN_FILE",
  "AGENT_HERDER_DOT_PRINCIPAL_ID",
  "AGENT_HERDER_DOT_URL",
  "AGENT_HERDER_DOT_ROOM",
] as const;

export function createUserIoDotBinding(env: NodeJS.ProcessEnv = process.env): UserIoDotBinding | undefined {
  const values = required.map(key => env[key]?.trim() ?? "");
  if (values.every(value => !value)) return undefined;
  if (values.some(value => !value)) throw new Error("userio_dot_configuration_incomplete");
  const [endpoint, agentId, instanceId, accountScope, tokenFile, principalId, url, room] = values;
  const config: UserIoConfig = { endpoint, agentId, instanceId, accountScope, tokenFile, principalId };
  return { client: new UserIoDotClient(new UserIoAgentChannel(config)), binding: { url, room } };
}

export function registerUserIoDotTools(server: McpServer, binding?: UserIoDotBinding): void {
  if (!binding) return;
  server.registerTool("dot_snapshot", {
    description: "Read the bound ChatGPT Dot room through the existing UserIO MV3 extension. Uses the supplied cursor and never sends or evaluates arbitrary browser code.",
    inputSchema: z.object({ after: z.string().trim().min(1).max(512).nullable().optional() }).strict(),
  }, async args => structuredValueResult(await binding.client.snapshot({ ...binding.binding, after: args.after ?? null })));

  server.registerTool("dot_send", {
    description: "Send one text message to the bound ChatGPT Dot room through UserIO MV3, then perform bounded readback. An uncertain result is returned as UNKNOWN and is never retried automatically.",
    inputSchema: z.object({
      text: z.string().min(1).max(16_000),
      replyTo: z.string().trim().min(1).max(512).nullable().optional(),
      entities: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
    }).strict(),
  }, async args => structuredValueResult(await binding.client.send({
    ...binding.binding,
    text: args.text,
    replyTo: args.replyTo ?? null,
    entities: args.entities,
  })));
}
