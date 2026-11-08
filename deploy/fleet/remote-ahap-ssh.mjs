#!/usr/bin/env node
// One explicitly configured AHAP stdio transport. No shell expansion of inputs.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;
const SAFE_HOST = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
export function loadConfig(file) {
  if (!path.isAbsolute(file) || realpathSync(file) !== file) throw new Error('config path must be canonical');
  const st = lstatSync(file);
  if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077) || st.nlink !== 1) throw new Error('config must be private');
  const c = JSON.parse(readFileSync(file, 'utf8'));
  const common = ['host','user','port','nodeRef','kind','remoteNode','remoteRunner','remoteHome','remoteCwd','remoteRunnerSha256'];
  const keys = [...common, ...(c.kind === 'opencode' ? ['opencodeBaseUrl'] : c.kind === 'codex' ? ['codexSocket'] : [])];
  if (!['opencode','codex'].includes(c.kind)) throw new Error('invalid kind');
  const allowed = c.kind === 'codex' ? [...keys, 'model'] : keys;
  if (Object.keys(c).some(k => !allowed.includes(k)) || keys.some(k => !(k in c))) throw new Error('invalid config keys');
  if ('model' in c && (typeof c.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(c.model))) throw new Error('invalid model');
  if (!SAFE_HOST.test(c.nodeRef) || !SAFE_HOST.test(c.host) || !/^[a-z_][a-z0-9_-]*$/.test(c.user) || !Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new Error('invalid ssh destination');
  for (const k of ['remoteNode','remoteRunner','remoteHome','remoteCwd']) if (!SAFE_PATH.test(c[k]) || c[k].includes('/../') || c[k].endsWith('/..')) throw new Error('invalid remote path');
  if (!/^[a-f0-9]{64}$/.test(c.remoteRunnerSha256)) throw new Error('invalid digest');
  if (c.kind === 'opencode') {
    const u = new URL(c.opencodeBaseUrl);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('expected explicit remote loopback OpenCode endpoint');
    c.opencodeBaseUrl = u.href;
  } else if (!SAFE_PATH.test(c.codexSocket) || c.codexSocket.includes('/../') || c.codexSocket.endsWith('/..')) throw new Error('invalid codex socket');
  return c;
}
export function sshArgs(c) {
  // All interpolated fields have been constrained above. The hash gate runs on
  // the remote host before executing the runner, and never reconnects/replays.
  const native = c.kind === "codex" ? `AHAP_CODEX_SOCKET=${c.codexSocket} AHAP_CODEX_CWD=${c.remoteCwd}${c.model === undefined ? "" : ` AHAP_CODEX_MODEL=${c.model}`}` : `AHAP_OPENCODE_BASE_URL=${c.opencodeBaseUrl}`;
  const command = `cd ${c.remoteCwd} && test "$(sha256sum ${c.remoteRunner} | cut -d' ' -f1)" = ${c.remoteRunnerSha256} && exec env HOME=${c.remoteHome} PATH=/usr/bin:/bin AHAP_VERSION=0.1 AHAP_HARNESS=${c.kind} AHAP_ROLE=adapter ${native} ${c.remoteNode} ${c.remoteRunner}`;
  return ['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=5','-p',String(c.port),`${c.user}@${c.host}`,command];
}
export function main() {
  if (process.argv.length !== 2) throw new Error('no runtime arguments supported');
  const config = loadConfig(fileURLToPath(import.meta.url) + '.json');
  if (process.env.AHAP_HARNESS !== config.kind) throw new Error('wrong harness');
  const child = spawn('/usr/bin/ssh', sshArgs(config), {stdio:'inherit', env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin'}});
  child.on('error', () => { process.stderr.write('remote AHAP transport failed\n'); process.exitCode=1; });
  child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); } catch { process.stderr.write('invalid remote AHAP configuration\n'); process.exitCode=1; }
}
