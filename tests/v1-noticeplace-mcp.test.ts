import { describe, expect, it, vi } from 'vitest';
import { NOTICEPLACE_HERDER_MCP_URL, NoticePlaceMcpPort, type NoticePlaceMcpClient } from '../src/automation/v1-noticeplace-mcp.js';

describe('NoticePlace scoped Rust MCP port', () => {
  it('preserves compat_task task identity/status/result from one structuredContent layer', async () => {
    const client: NoticePlaceMcpClient = {
      connect: vi.fn(async () => undefined),
      callTool: vi.fn(async () => ({
        content: [{ type: 'text', text: 'opaque compatibility text' }],
        structuredContent: { taskId: 'create-operation:fixture', resultType: 'complete', status: 'completed', result: { structuredContent: { create: { effect: 'confirmed', session_ref: 'opaque-session' }, prompt: { effect: 'confirmed' } } } },
      })),
      close: vi.fn(async () => undefined),
    };
    const token = vi.fn(async () => 'protected-test-token');
    let endpoint: URL | undefined;
    let auth: (() => Promise<string>) | undefined;
    const port = new NoticePlaceMcpPort(token, () => client, (url, provider) => {
      endpoint = url;
      auth = provider;
      return {};
    });

    const response = await port.call('compat_task', { action: 'get', task_ref: 'create-operation:fixture' }) as Record<string, unknown>;

    expect(endpoint?.href).toBe(NOTICEPLACE_HERDER_MCP_URL);
    expect(await auth?.()).toBe('protected-test-token');
    expect(response).toMatchObject({ taskId: 'create-operation:fixture', resultType: 'complete', status: 'completed' });
    expect((response.result as Record<string, unknown>).structuredContent).toMatchObject({ create: { session_ref: 'opaque-session' } });
    expect(client.callTool).toHaveBeenCalledWith({ name: 'compat_task', arguments: { action: 'get', task_ref: 'create-operation:fixture' } },{timeout:5_000});
  });

  it('uses one authenticated client connection for concurrent calls', async () => {
    const client: NoticePlaceMcpClient = { connect: vi.fn(async () => undefined), callTool: vi.fn(async () => ({ structuredContent: { ok: true } })), close: vi.fn(async () => undefined) };
    const port = new NoticePlaceMcpPort(async () => 'private', () => client, () => ({}));
    await Promise.all([port.call('sessions', { action: 'list' }), port.call('sessions', { action: 'list' })]);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledTimes(2);
  });
});
