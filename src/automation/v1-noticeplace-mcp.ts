import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export const NOTICEPLACE_HERDER_MCP_URL = 'https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp';

export type NoticePlaceMcpClient = {
  connect(transport: unknown): Promise<void>;
  callTool(input: { name: string; arguments: Record<string, unknown> }, options?: { timeout?: number; signal?: AbortSignal }): Promise<unknown>;
  close(): Promise<void>;
};
export type NoticePlaceMcpTransportFactory = (url: URL, tokenProvider: () => Promise<string>) => unknown;

/** A scoped shared-child MCP client that preserves native async-task envelopes. */
export class NoticePlaceMcpPort {
  private client?: NoticePlaceMcpClient;
  private connecting?: Promise<NoticePlaceMcpClient>;
  constructor(
    private readonly tokenProvider: () => Promise<string>,
    private readonly clientFactory: () => NoticePlaceMcpClient = () => new Client({ name: 'agent-herder-noticeplace-v1', version: '1' }) as unknown as NoticePlaceMcpClient,
    private readonly transportFactory: NoticePlaceMcpTransportFactory = (url, tokenProvider) =>
      new StreamableHTTPClientTransport(url, { authProvider: { token: tokenProvider } }),
  ) {}

  private async connected(): Promise<NoticePlaceMcpClient> {
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = this.clientFactory();
        try {
          await client.connect(this.transportFactory(new URL(NOTICEPLACE_HERDER_MCP_URL), this.tokenProvider));
          this.client = client;
          return client;
        } catch (error) {
          await client.close().catch(() => undefined);
          throw error;
        }
      })().finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const timeout=tool==='create'||tool==='deliver'?60_000:tool==='compat_task'?5_000:15_000;
    const response = await (await this.connected()).callTool({ name: tool, arguments: args },{timeout});
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('noticeplace_mcp_invalid_response');
    const result = response as Record<string, unknown>;
    if (result.isError === true) return result; // Keep the exact no-effect/refusal receipt; callers classify it.
    // One layer only: compat_task's status/taskId/result are in structuredContent.
    return result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent)
      ? result.structuredContent : response;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) await client.close();
  }
}
