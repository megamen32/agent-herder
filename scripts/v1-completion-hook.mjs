#!/usr/bin/env node
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MCP_ENDPOINT = 'https://mcp.bezrabotnyi.com/server/shell-roomhacker-server-100-agentherder/mcp';
const CONFIG_PATH = process.env.AGENT_HERDER_V1_HOOK_CONFIG || join(homedir(), '.config/agent-herder/v1-completion-hook.json');
const DEFAULT_TIMEOUT_MS = 5000;
const MIN_TIMEOUT_MS = 250;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_DEFER_MS = 300;
const DEFAULT_COMPLETION_WAIT_MS = 5000;
const DEFAULT_COMPLETION_POLL_MS = 250;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 4096;
const SAFE_RECEIPT_VALUE = /^[a-zA-Z0-9_.:-]{1,96}$/;

function safeValue(value) { return typeof value === 'string' && SAFE_RECEIPT_VALUE.test(value) ? value : undefined; }

async function writeReceipt(receiptDir, input, fields) {
  if (typeof receiptDir !== 'string' || !receiptDir.startsWith('/') || !input?.session_id || !input?.turn_id) return;
  try {
    await mkdir(receiptDir, { recursive: true, mode: 0o700 });
    await chmod(receiptDir, 0o700);
    const digest = createHash('sha256').update(`${input.session_id}\0${input.turn_id}`).digest('hex');
    const receipt = {
      timestamp: new Date().toISOString(),
      native_session_id: input.session_id,
      native_turn_id: input.turn_id,
      observed_identity_keys: Object.keys(input).filter((key) => ['session_id', 'turn_id', 'cwd', 'hook_event_name', 'agent_id', 'agent_type', 'thread_id'].includes(key)).sort(),
      ...fields,
    };
    for (const key of ['code', 'effect', 'task_ref']) {
      const value = safeValue(receipt[key]);
      if (value === undefined) delete receipt[key]; else receipt[key] = value;
    }
    const body = `${JSON.stringify(receipt)}\n`;
    if (Buffer.byteLength(body) <= MAX_RECEIPT_BYTES) await writeFile(join(receiptDir, `${digest}.json`), body, { mode: 0o600 });
  } catch { /* Receipts are best-effort and never block native Stop. */ }
}

/** Read-only mapping plus one bounded reconciliation; the hook never wakes a parent itself. */
export async function reconcileCompletion(input, { configPath = CONFIG_PATH, fetchImpl = fetch } = {}) {
  if (!input || typeof input !== 'object') return;
  let config;
  try {
    const mode = (await stat(configPath)).mode & 0o777;
    if (mode !== 0o600) return;
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch { return; }
  if (!config || config.endpoint !== MCP_ENDPOINT || typeof config.bearer_file !== 'string' || !Array.isArray(config.children)) return;
  if (typeof input.session_id !== 'string' || !input.session_id ||
      typeof input.turn_id !== 'string' || !input.turn_id || typeof input.cwd !== 'string' || !input.cwd) return;
  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) return;
  const completionWaitMs = config.completion_wait_ms ?? DEFAULT_COMPLETION_WAIT_MS;
  const completionPollMs = config.completion_poll_ms ?? DEFAULT_COMPLETION_POLL_MS;
  if (!Number.isInteger(completionWaitMs) || completionWaitMs < 0 || completionWaitMs > 10000 ||
      !Number.isInteger(completionPollMs) || completionPollMs < 100 || completionPollMs > 1000) return;
  const matches = config.children.filter((x) => x && x.session_id === input.session_id &&
    x.child_native_id === input.session_id && typeof x.parent_native_id === 'string' && x.parent_native_id && x.cwd === input.cwd &&
    typeof x.parent_native_id === 'string' && x.parent_native_id &&
    typeof x.parent_ref === 'string' && x.parent_ref &&
    typeof x.child_ref === 'string' && x.child_ref && typeof x.rule_ref === 'string' && x.rule_ref);
  if (matches.length !== 1) return;
  const receiptDir = config.receipt_dir;
  await writeReceipt(receiptDir, input, { stage: 'mapped' });
  let token;
  try {
    if (((await stat(config.bearer_file)).mode & 0o777) !== 0o600) {
      await writeReceipt(receiptDir, input, { stage: 'auth', code: 'unprotected_bearer' }); return;
    }
    token = (await readFile(config.bearer_file, 'utf8')).trim();
  } catch { await writeReceipt(receiptDir, input, { stage: 'auth', code: 'bearer_unavailable' }); return; }
  if (!token || /[\r\n]/.test(token)) { await writeReceipt(receiptDir, input, { stage: 'auth', code: 'invalid_bearer' }); return; }
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
    if (!initialized?.protocolVersion || !initialized?.serverInfo) { await writeReceipt(receiptDir, input, { stage: 'initialize', code: 'invalid_handshake' }); return; }
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
    if (!actions.includes('reconcile')) { await writeReceipt(receiptDir, input, { stage: 'discovery', code: 'reconcile_unavailable' }); return; }
    const callArgs = {
        name: 'automation', arguments: { action: 'reconcile', rule_ref: matches[0].rule_ref,
          child_ref: matches[0].child_ref, event_id: eventId },
      };
    const deadline = Date.now() + completionWaitMs;
    while (true) {
      const result = await rpc('tools/call', callArgs);
      const content = result?.structuredContent;
      await writeReceipt(receiptDir, input, { stage: 'reconcile', code: safeValue(content?.code),
        effect: safeValue(content?.effect), task_ref: safeValue(content?.task_ref) });
      if (content?.code !== 'completion_unconfirmed' || content?.effect !== 'none' || Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(completionPollMs, Math.max(0, deadline - Date.now()))));
    }
  } catch { await writeReceipt(receiptDir, input, { stage: 'transport', code: 'transport_error' }); }
  finally { clearTimeout(timer); }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_STDIN_BYTES) break;
  }
  try {
    const input = JSON.parse(raw);
    const configPath = process.env.AGENT_HERDER_V1_HOOK_CONFIG || CONFIG_PATH;
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (input && typeof input.session_id === 'string' && typeof input.turn_id === 'string' && typeof input.cwd === 'string') {
      const worker = spawn(process.execPath, [fileURLToPath(import.meta.url), '--deferred'], {
        detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: { AGENT_HERDER_V1_HOOK_CONFIG: configPath },
      });
      worker.stdin.end(raw);
      worker.unref();
    }
  } catch { /* Native Stop must remain unblocked. */ }
  process.stdout.write('{}\n');
}

async function deferredMain() {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > MAX_STDIN_BYTES) return; }
  try {
    const configPath = process.env.AGENT_HERDER_V1_HOOK_CONFIG || CONFIG_PATH;
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    const deferMs = config.defer_ms ?? DEFAULT_DEFER_MS;
    if (!Number.isInteger(deferMs) || deferMs < 0 || deferMs > 2000) return;
    await new Promise((resolve) => setTimeout(resolve, deferMs));
    await reconcileCompletion(JSON.parse(raw), { configPath });
  } catch { /* No retry on transport errors, unknown outcomes, or malformed state. */ }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === '--deferred') await deferredMain();
  else await main();
}
