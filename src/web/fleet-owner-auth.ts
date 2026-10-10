import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { hostname } from 'node:os';

type RequestBoundary = (options: RequestOptions, response: (message: IncomingMessage) => void) => ClientRequest;

// Dependency injection is limited to the request boundary for isolated units.
// Public verification always uses the fixed, CA-validated HAOS route below.
export function createFleetOwnerCookieVerifier(request: RequestBoundary): (cookie: string) => Promise<boolean> {
  // The mobile M1 is reached by its existing reverse SSH outside the home LAN.
  // Its verifier uses the same signed owner authority at the normal public TLS URL.
  const mobile = hostname() === 'MacBook-Pro-User.local';
  return async (cookie: string): Promise<boolean> => {
    if (typeof cookie !== 'string' || Buffer.byteLength(cookie) > 16384 || /[\r\n]/.test(cookie)) return false;
    return new Promise<boolean>(resolve => {
      let pending: ClientRequest | undefined;
      let response: IncomingMessage | undefined;
      let settled = false;
      let bytes = 0;
      const finish = (valid: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        // Only this verification's request/response are closed. Error listeners
        // remain until disposal so a late transport error cannot escape.
        response?.destroy();
        pending?.destroy();
        resolve(valid);
      };
      const deadline = setTimeout(() => finish(false), 3000);
      try {
        pending = request({
          hostname: 'auth.bezrabotnyi.com', port: mobile ? 443 : 8443,
          servername: 'auth.bezrabotnyi.com', rejectUnauthorized: true,
          // Do not reuse another caller's pooled connection to this TLS name.
          agent: false,
          method: 'GET', path: '/check',
          headers: { Host: 'auth.bezrabotnyi.com', Cookie: cookie },
          ...(mobile ? {} : { lookup: (_hostname, options, callback) => {
            // Match native DNS's asynchronous contract. A synchronous connect
            // refusal on Darwin must wait until TLS/request error handlers exist.
            queueMicrotask(() => {
              if (options.all) callback(null, [{ address: '192.168.2.101', family: 4 }]);
              else callback(null, '192.168.2.101', 4);
            });
          } } as Pick<RequestOptions, 'lookup'>),
        }, message => {
          message.on('error', () => finish(false));
          if (settled) { message.destroy(); return; }
          response = message;
          message.once('aborted', () => finish(false));
          message.once('close', () => finish(false));
          message.on('data', (chunk: Buffer | string) => {
            bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
            if (bytes > 1024) finish(false);
          });
          message.once('end', () => {
            const identityHeaders = message.rawHeaders.filter((_, i) =>
              i % 2 === 0 && message.rawHeaders[i].toLowerCase() === 'x-gptadmin-user');
            finish(message.complete && message.statusCode === 204
              && message.headers['x-gptadmin-user'] === 'roomhacker'
              && identityHeaders.length <= 1);
          });
        });
        pending.on('error', () => finish(false));
        pending.once('close', () => { if (!response?.complete) finish(false); });
        if (settled) pending.destroy();
        else pending.end();
      } catch {
        finish(false);
      }
    });
  };
}

/** Verify the sole current cabinet owner using HAOS, independently of server100. */
export const verifyFleetOwnerCookie: (cookie: string) => Promise<boolean> = createFleetOwnerCookieVerifier(httpsRequest);
