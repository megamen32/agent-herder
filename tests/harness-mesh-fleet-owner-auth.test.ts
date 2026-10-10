import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFleetOwnerCookieVerifier } from '../src/web/fleet-owner-auth.js';

function fixture() {
  const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  let respond!: (res: IncomingMessage) => void;
  const request = vi.fn((_: RequestOptions, cb: (res: IncomingMessage) => void) => {
    respond = cb;
    return req as unknown as ClientRequest;
  });
  const verify = createFleetOwnerCookieVerifier(request);
  const response = (status = 204, owner: unknown = 'roomhacker') => {
    const res = Object.assign(new EventEmitter(), {
      statusCode: status, headers: { 'x-gptadmin-user': owner }, rawHeaders: [] as string[],
      complete: false, destroy: vi.fn(),
    });
    respond(res as unknown as IncomingMessage);
    return res;
  };
  return { req, request, verify, response };
}

describe('HAOS owner cookie gate (fast unit; expected 1s, maximum 15s)', () => {
  afterEach(() => vi.useRealTimers());

  it('pins the physical TLS route, certificate identity and GET without redirect machinery', async () => {
    const f = fixture();
    const pending = f.verify('session=fixture');
    const options = f.request.mock.calls[0][0];
    expect(options).toMatchObject({ hostname: 'auth.bezrabotnyi.com', port: 8443,
      servername: 'auth.bezrabotnyi.com', method: 'GET', path: '/check',
      rejectUnauthorized: true, agent: false,
      headers: { Host: 'auth.bezrabotnyi.com', Cookie: 'session=fixture' } });
    const lookup = options.lookup as Function;
    const cb = vi.fn(); lookup('auth.bezrabotnyi.com', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '192.168.2.101', 4);
    const all = vi.fn(); lookup('auth.bezrabotnyi.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '192.168.2.101', family: 4 }]);
    const res = f.response(); res.complete = true; res.emit('end');
    expect(await pending).toBe(true);
    expect(f.req.end).toHaveBeenCalledOnce();
    expect(f.req.destroy).toHaveBeenCalledOnce(); expect(res.destroy).toHaveBeenCalledOnce();
  });

  it.each([[401, 'roomhacker'], [200, 'roomhacker'], [302, 'roomhacker'],
    [204, 'someone'], [204, 'Roomhacker'], [204, 'roomhacker '],
    [204, undefined], [204, ['roomhacker']], [204, 'roomhacker, roomhacker']])(
    'rejects status %s and non-exact owner %s without another request', async (status, owner) => {
      const f = fixture(); const pending = f.verify('s=fixture');
      const res = f.response(status, owner); res.headers['x-gptadmin-user'] = owner;
      res.complete = true; res.emit('end');
      expect(await pending).toBe(false); expect(f.request).toHaveBeenCalledOnce();
      expect(res.destroy).toHaveBeenCalledOnce();
    });

  it.each(['s=x\r\nX-GPTAdmin-User: roomhacker', 's=x\n', 's=x\r', 'x'.repeat(16385)])(
    'rejects malformed or oversized cookies before transport', async cookie => {
      const f = fixture(); expect(await f.verify(cookie)).toBe(false);
      expect(f.request).not.toHaveBeenCalled();
    });

  it('accepts the cookie boundary and rejects duplicate identity headers', async () => {
    const f = fixture(); const pending = f.verify('x'.repeat(16384)); const res = f.response();
    res.rawHeaders = ['X-GPTAdmin-User', 'roomhacker', 'x-gptadmin-user', 'roomhacker'];
    res.complete = true; res.emit('end'); expect(await pending).toBe(false);
    expect(f.request).toHaveBeenCalledOnce();
  });

  it.each([1024, 1025])('bounds response bytes at 1024 (%s)', async bytes => {
    const f = fixture(); const pending = f.verify('s=fixture'); const res = f.response();
    res.emit('data', Buffer.alloc(bytes)); res.complete = true; res.emit('end');
    expect(await pending).toBe(bytes === 1024); expect(res.destroy).toHaveBeenCalledOnce();
  });

  it.each(['request', 'body'])('enforces one total 3s deadline during %s and destroys owned resources', async stage => {
    vi.useFakeTimers(); const f = fixture(); const pending = f.verify('s=fixture');
    const res = stage === 'body' ? f.response() : undefined;
    await vi.advanceTimersByTimeAsync(2999);
    expect(f.req.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toBe(false);
    expect(f.req.destroy).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    if (res) expect(res.destroy).toHaveBeenCalledOnce();
    else {
      const late = f.response(); expect(late.destroy).toHaveBeenCalledOnce();
      expect(() => late.emit('error', new Error('late fixture'))).not.toThrow();
    }
  });

  it.each(['error', 'aborted', 'close', 'incomplete-end'])('fails closed on response %s', async event => {
    vi.useFakeTimers(); const f = fixture(); const pending = f.verify('s=fixture'); const res = f.response();
    res.emit(event === 'incomplete-end' ? 'end' : event, event === 'error' ? new Error('fixture') : undefined);
    expect(await pending).toBe(false); expect(vi.getTimerCount()).toBe(0);
    expect(f.req.destroy).toHaveBeenCalledOnce(); expect(res.destroy).toHaveBeenCalledOnce();
  });

  it.each(['error', 'close'])('fails closed on request %s before response', async event => {
    vi.useFakeTimers(); const f = fixture(); const pending = f.verify('s=fixture');
    f.req.emit(event, event === 'error' ? new Error('fixture') : undefined);
    expect(await pending).toBe(false); expect(vi.getTimerCount()).toBe(0);
    expect(f.req.destroy).toHaveBeenCalledOnce();
  });

  it('handles synchronous transport failure without leaking the deadline', async () => {
    vi.useFakeTimers();
    const verify = createFleetOwnerCookieVerifier(() => { throw new Error('fixture'); });
    expect(await verify('s=fixture')).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
});
