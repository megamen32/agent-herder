#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MCP_ENDPOINT = 'https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp';
const CONFIG_PATH = join(homedir(), '.config/agent-herder/v1-completion-hook.json');
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 30000;
const MAX_STDIN_BYTES = 64 * 1024;

/** Read-only mapping plus one bounded reconciliation; the hook never wakes a parent itself. */
export async function reconcileCompletion(input, { configPath = CONFIG_PATH, fetchImpl = fetch } = {}) {
  if (!input || typeof input !== 'object' || typeof input.session_id !== 'string' || !input.session_id ||
      typeof input.turn_id !== 'string' || !input.turn_id || typeof input.cwd !== 'string' || !input.cwd) return;
  let config;
  try {
    const mode = (await stat(configPath)).mode & 0o777;
    if (mode !== 0o600) return;
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch { return; }
  if (!config || config.endpoint !== MCP_ENDPOINT || typeof config.bearer_file !== 'string' || !Array.isArray(config.children)) return;
  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) return;
  const matches = config.children.filter((x) => x && x.session_id === input.session_id && x.cwd === input.cwd &&
    typeof x.child_ref === 'string' && typeof x.rule_ref === 'string');
  if (matches.length !== 1) return;
  let token;
  try {
    if (((await stat(config.bearer_file)).mode & 0o777) !== 0o600) return;
    token = (await readFile(config.bearer_file, 'utf8')).trim();
  } catch { return; }
  if (!token || /[\r\n]/.test(token)) return;
  // Core's CompletedTurnReader compares event_id to the exact native turn ID.
  const eventId = input.turn_id;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let sessionId;
  let rpcId = 0;
  const rpc = async (method, params, { notification = false } = {}) => {
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const response = await fetchImpl(MCP_ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: ++rpcId }), method, ...(params ? { params } : {}) }) });
    sessionId = response.headers?.get?.('mcp-session-id') ?? sessionId;
    if (notification && response.status === 204) return null;
    if (!response.ok) throw new Error('MCP HTTP failure');
    const body = await response.text();
    if (!body) { if (notification) return null; throw new Error('Empty MCP response'); }
    const payload = response.headers?.get?.('content-type')?.includes('text/event-stream')
      ? body.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).filter(Boolean).join('\n')
      : body;
    const message = JSON.parse(payload);
    if (message.error) throw new Error('MCP JSON-RPC error');
    return message.result;
  };
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'agent-herder-v1-completion-hook', version: '1' } });
    if (!initialized?.protocolVersion || !initialized?.serverInfo) return;
    await rpc('notifications/initialized', undefined, { notification: true });
    const tools = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const catalog = await rpc('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(catalog?.tools)) return;
      tools.push(...catalog.tools);
      if (!catalog.nextCursor) break;
      if (typeof catalog.nextCursor !== 'string' || page === 99) return;
      cursor = catalog.nextCursor;
    }
    const tool = tools.find((x) => x.name === 'automation');
    const actions = tool?.inputSchema?.oneOf?.flatMap((variant) => {
      const action = variant?.properties?.action?.const;
      return typeof action === 'string' ? [action] : [];
    }) ?? [];
    if (!actions.includes('reconcile')) return;
    await rpc('tools/call', {
        name: 'automation', arguments: { action: 'reconcile', rule_ref: matches[0].rule_ref,
          child_ref: matches[0].child_ref, event_id: eventId },
      });
  } catch { /* Stop hooks fail open; a missing/unknown receipt is never retried here. */ }
  finally { clearTimeout(timer); }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_STDIN_BYTES) break;
  }
  try { await reconcileCompletion(JSON.parse(raw)); } catch { /* Native Stop must remain unblocked. */ }
  process.stdout.write('{}\n');
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await main();
