import {createHash} from 'node:crypto';
import {shareZcodeSessionService} from './shared-session-service.mjs';

/** Pin the reviewed entry, retaining the earlier catalogue correction. */
export function stageSharedSessionService(source, role, expectedSha256, runtimeRoot) {
  if (createHash('sha256').update(source).digest('hex') !== expectedSha256) throw Error('Native host changed; revalidate the exact source');
  const desktop = role === 'desktop';
  const marker = desktop ? '.register(Jn,re)' : '.register(IZCodeAgentService, zcodeAgentService)';
  if (source.split(marker).length !== 2 || source.includes('__herderSharedNativeV1')) throw Error('Unsupported native service registration');
  const config = `{service:${desktop ? 're' : 'zcodeAgentService'},role:${JSON.stringify(role)},socketPath:${JSON.stringify(runtimeRoot + '/zcode-' + role + '.sock')},peerPath:${JSON.stringify(runtimeRoot + '/zcode-' + (desktop ? 'herder' : 'desktop') + '.sock')},net:process.getBuiltinModule('node:net'),fs:process.getBuiltinModule('node:fs'),createScope:${desktop ? 'th' : 'createZCodeAgentConnectionScope'},randomUUID:process.getBuiltinModule('node:crypto').randomUUID}`;
  const bridge = `(()=>{const shared=shareZcodeSessionService(${config});(globalThis.__herderSharedNativeV1??=new Set()).add(shared);return shared.service})()`;
  return shareZcodeSessionService.toString() + ';' + source.replace(marker, desktop ? `.register(Jn,${bridge})` : `.register(IZCodeAgentService, ${bridge})`);
}
