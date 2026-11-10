// Real Herder HTTP API backed by isolated native app servers. This is an
// artifact probe; it does not claim to exercise the installed service PID.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const [dist, project, openCodeUrl] = process.argv.slice(2);
if (!dist || !project || !openCodeUrl) throw Error('usage: node native-herder-probe.mjs DIST PROJECT OPENCODE_URL');
const load = (path) => import(pathToFileURL(join(dist, path)).href);
const [{ CodexAppServerAdapter }, { OpenCodeAdapter }, { createWebServer }] = await Promise.all([
  load('adapters/codex-app-server.js'), load('adapters/opencode.js'), load('web/server.js'),
]);
const codex = new CodexAppServerAdapter({ cwd: project, codexDir: process.env.CODEX_HOME });
const opencode = new OpenCodeAdapter({ baseUrl: openCodeUrl, protocol: 'v2' });
const adapters = new Map([['codex', codex], ['opencode', opencode]]);
let server;
try {
  await codex.init();
  await opencode.init();
  server = createWebServer({ adapters, converter: { async convert() { throw Error('not used'); } } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const root = `http://127.0.0.1:${server.address().port}`;
  async function api(path, body) {
    const response = await fetch(root + path, body ? { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) } : undefined);
    const value = await response.json();
    if (!response.ok) throw Error(`${path} HTTP ${response.status}: ${JSON.stringify(value)}`);
    return value;
  }
  const results = [];
  for (const harness of ['codex', 'opencode']) {
    const model = harness === 'codex' ? 'herder-test' : 'fixture/herder-test';
    const sessions = [];
    for (let index = 0; index < 2; index++) {
      const result = await api('/api/sessions', { harness, name: `Herder CI ${harness} ${index}`, cwd: project, model });
      const id = result.session?.id ?? result.sessionId;
      assert.ok(id, `create did not return ID: ${JSON.stringify(result)}`);
      sessions.push(id);
    }
    assert.notEqual(sessions[0], sessions[1]);
    const message = `HERDER_NATIVE_USER_${harness}`;
    for (const [index, id] of sessions.entries()) {
      const sent = await api(`/api/sessions/${harness}/${id}/message`, {message, mode:'queue', inputId:`test-${harness}-${index}`});
      assert.notEqual(sent.ok, false, `send failed: ${JSON.stringify(sent)}`);
      let details;
      for (let attempt = 0; attempt < 60; attempt++) {
        details = await api(`/api/sessions/${harness}/${id}/details?limit=100&history=auto`);
        if (JSON.stringify(details).includes('HERDER_TEST_MODEL_OK')) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.ok(JSON.stringify(details).includes(message), `${harness} missing user message`);
      assert.ok(JSON.stringify(details).includes('HERDER_TEST_MODEL_OK'), `${harness} missing answer`);
      const events = [];
      let cursor;
      let pages = 0;
      let complete = false;
      const seen = new Set();
      do {
        const query = new URLSearchParams({limit:'1'});
        if (cursor) query.set('cursor', cursor);
        const value = await api(`/api/sessions/${harness}/${id}/transcript?${query}`);
        const transcript = value.transcript;
        assert.ok(transcript && Array.isArray(transcript.events), 'missing transcript page');
        events.push(...transcript.events);
        pages++;
        complete = transcript.complete === true;
        cursor = transcript.nextCursor;
        if (cursor) {
          assert.ok(!seen.has(cursor), 'repeated transcript cursor');
          seen.add(cursor);
        }
        assert.ok(pages < 500, 'transcript pagination did not finish');
      } while (cursor);
      assert.ok(complete && pages > 1, `${harness} transcript did not prove complete pagination`);
      assert.ok(JSON.stringify(events).includes(message), `${harness} transcript missing user message`);
      assert.ok(JSON.stringify(events).includes('HERDER_TEST_MODEL_OK'), `${harness} transcript missing answer`);
    }
    let list;
    for (let attempt = 0; attempt < 60; attempt++) {
      list = await api('/api/sessions?quick=1&limit=100');
      if (sessions.every(id => JSON.stringify(list).includes(id))) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    for (const id of sessions) assert.ok(JSON.stringify(list).includes(id), `${harness} list omitted ${id}: ${JSON.stringify(list)}`);
    results.push({harness, sessions, answer: true});
  }
  console.log(JSON.stringify({scope:'isolated-herder-artifact', results}));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await codex.dispose();
}
process.exit(0);
