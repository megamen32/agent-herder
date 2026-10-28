import {afterEach, expect, it, vi} from 'vitest';
import {OpenCodeClient} from '../src/harness/opencode/client.js';
afterEach(() => vi.unstubAllGlobals());
it('explicitly parks steering and queued work when stopping a v2 session', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({interrupted: true}), {headers: {'Content-Type': 'application/json'}}));
  vi.stubGlobal('fetch', fetch);
  const client = new OpenCodeClient({baseUrl: 'http://native.test', protocol: 'v2'});
  expect(await client.interrupt('ses_duplicate')).toEqual({ok: true});
  expect(String(fetch.mock.calls[0]?.[0])).toBe('http://native.test/api/session/ses_duplicate/interrupt?resume=false');
});
