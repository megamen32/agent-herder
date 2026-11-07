// Read-only MCP search for sessions created by the CI journey.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, isAbsolute } from 'node:path';

const [dist, origin, expectations] = process.argv.slice(2);
const url = new URL(origin);
if (!isAbsolute(dist) || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash)
  throw new Error('absolute candidate dist and loopback origin required');
const journeys = JSON.parse(expectations);
if (!Array.isArray(journeys) || !process.env.HERDER_CI_TOKEN) throw new Error('search scope and fixture token required');
const require = createRequire(join(dist, '..', 'package.json'));
const { Client, StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/client')));
const client = new Client({ name: 'herder-ci-search', version: '1' });
const replies = [];
try {
  process.stderr.write('connecting MCP\n');
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { authProvider: { token: async () => process.env.HERDER_CI_TOKEN } }));
  process.stderr.write('connected MCP\n');
  for (const journey of journeys) {
    for (const session of journey.sessions) {
      process.stderr.write(`search ${journey.harness} ${session.id}\n`);
      if (!session.id || !session.marker || !journey.harness) throw new Error('missing exact search expectation');
      let response;
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await client.callTool({ name: 'search', arguments: { scope: 'fleet', query: session.marker, harnesses: [journey.harness], limit: 20 } });
        response = result.isError ? null : result.structuredContent;
        if (attempt === 0) process.stderr.write(`search status ${JSON.stringify({ error: !!result.isError, partial: response?.partial, hosts: response?.hosts?.map(h => ({ state: h.state, partial: h.partial, run: h.index?.run?.status, sources: h.index?.sources?.filter(s => s.harness === journey.harness).map(s => ({ state: s.state, reason: s.reason })) })) })}\n`);
        if (!result.isError && response?.partial === false && response.results?.some(r => r.harness === journey.harness && r.nativeSessionId === session.id)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      replies.push({ harness: journey.harness, sessionId: session.id, response });
    }
  }
  process.stdout.write(JSON.stringify(replies) + '\n');
} finally { await client.close(); }
