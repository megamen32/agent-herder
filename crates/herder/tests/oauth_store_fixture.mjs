// Test-only authority process. All requests and tokens travel only through its private pipes.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const { McpOAuthTokenStore, MCP_OAUTH_OWNER_SCOPE, pkceS256 } = await import(pathToFileURL(process.argv[2]).href);
const store = new McpOAuthTokenStore(join(process.argv[3], 'oauth.json'));
const issuer = 'https://test.invalid', audience = 'https://test.invalid/mcp';
const client = await store.registerClient('test', 'https://test.invalid/callback');
const verifier = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~';
const state = 'test-state';
const transaction = await store.createAuthorizationTransaction({clientId:client.clientId, redirectUri:client.redirectUri, codeChallenge:pkceS256(verifier),resource:audience,scopes:[MCP_OAUTH_OWNER_SCOPE],state});
const code = await store.approveAuthorizationTransaction({transaction,clientId:client.clientId,redirectUri:client.redirectUri,state,subject:'alice'});
const tokens = await store.exchangeAuthorizationCode({clientId:client.clientId,code,redirectUri:client.redirectUri,codeVerifier:verifier,resource:audience,issuer});
process.stdout.write(JSON.stringify({access:tokens.accessToken})+'\n');
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  try {
    const request=JSON.parse(line);
    if(request.action==='verify') {
      const p=await store.verifyAccessToken(request.bearer,{issuer:request.issuer,audience:request.audience,requiredScope:request.scope});
      process.stdout.write(JSON.stringify(p ? {subject:p.subject,issuer:p.issuer,audience:p.audience,scopes:p.scopes,expires_at_ms:p.expiresAt}:null)+'\n');
    } else if(request.action==='revoke') {
      await store.revoke({clientId:client.clientId,token:tokens.refreshToken});
      process.stdout.write('{"ok":true}\n');
    } else throw Error('unknown action');
  } catch { process.stdout.write('{"error":true}\n'); }
}
