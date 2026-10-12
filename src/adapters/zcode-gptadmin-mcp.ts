/** Native session/create needs the MCP definitions explicitly. Directory records
 * are resolved by ZCode itself; this bridge selects only the already enabled
 * GPTAdmin connection and enabled connections already migrated through that
 * gateway. Authority is the exact selected directory row, not a shared header
 * map or a domain-wide tenant identity. Each native binding stays isolated. */
function managedConnection(config: any): boolean {
  if (!config || typeof config.url !== 'string') return false;
  try {
    const url = new URL(config.url);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && !url.port &&
      /^[a-z0-9-]+\.t\.gptadmin\.bezrabotnyi\.com$/.test(url.hostname) &&
      /^\/connection\/[a-z0-9][a-z0-9-]{0,255}\/mcp$/.test(url.pathname) && url.href === config.url;
  } catch { return false; }
}
export function configuredGptAdminMcp(value: unknown, workspacePath: string) {
  const records = (value as {servers?: unknown[]})?.servers;
  if (!Array.isArray(records) || records.length > 128) throw new Error('ZCode MCP directory response invalid');
  const namespaces = new Map<string, any[]>();
  for (const r of records as any[]) {
    if (!r || typeof r.name !== 'string' || !r.name || r.name.length > 128 || /[\x00-\x1f\x7f]/.test(r.name)) continue;
    if (r.scope !== 'user' && !(r.scope === 'workspace' && r.projectPath === workspacePath)) continue;
    const key = r.name.toLowerCase();
    const group = namespaces.get(key) ?? []; group.push(r); namespaces.set(key, group);
  }
  return [...namespaces].flatMap(([name, candidates]) => {
  if (name !== 'gptadmin' && !candidates.some(r => managedConnection(r.config))) return [];
  // Select scope before eligibility: disabled or direct workspace overrides
  // cannot fall back to a user's enabled managed gateway/credential.
  const own = candidates.filter(r => r.scope === 'workspace');
  const group = own.length ? own : candidates.filter(r => r.scope === 'user');
  if (group.length !== 1) throw new Error('ZCode GPTAdmin MCP scope ambiguous');
  const row = group[0] as any;
  if (row.enabled !== true) return [];
  const config = row.config;
  if (name !== 'gptadmin' && !managedConnection(config)) return [];
  if (!config || !(name === 'gptadmin' ? ['http', 'sse'] : ['http']).includes(config.type) || typeof config.url !== 'string') throw new Error('ZCode GPTAdmin MCP configuration invalid');
  // This delivery uses the existing header-authenticated caller. Never drop
  // another configuration's OAuth semantics or silently replace its identity.
  if (config.oauth !== undefined) throw new Error('ZCode GPTAdmin OAuth binding requires a supported native auth resolver');
  const url = new URL(config.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('ZCode GPTAdmin MCP origin invalid');
  if (!config.headers || typeof config.headers !== 'object' || Array.isArray(config.headers)) throw new Error('ZCode GPTAdmin MCP headers invalid');
  const headers = Object.entries(config.headers).map(([name, value]) => {
    if (!name || /[\r\n]/.test(name) || typeof value !== 'string' || value.length > 8192 || /[\r\n]/.test(value)) throw new Error('ZCode GPTAdmin MCP headers invalid');
    return {name, value};
  });
  if (headers.length > 32) throw new Error('ZCode GPTAdmin MCP headers invalid');
  if (config.protocolVersion !== undefined && !['legacy','auto','2026-07-28'].includes(config.protocolVersion)) throw new Error('ZCode GPTAdmin MCP protocol invalid');
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0 || config.timeoutMs > 120000)) throw new Error('ZCode GPTAdmin MCP timeout invalid');
  return [{name: row.name as string, type: config.type as 'http'|'sse', url: config.url as string, headers, isolation: 'session' as const,
    ...(config.protocolVersion ? {protocolVersion: config.protocolVersion} : {}),
    ...(config.timeoutMs ? {timeoutMs: config.timeoutMs} : {})}];
  });
}
