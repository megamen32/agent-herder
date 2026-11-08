#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { immutableNoticePlaceReleaseRoot } from './noticeplace-release-path.mjs';

const fail = message => { console.error(`[noticeplace-v1] ${message}`); process.exit(2); };
const configPath = process.argv[2] || process.env.NOTICEPLACE_V1_CONFIG;
if (!configPath) fail('pass protected config path as argv[2] or NOTICEPLACE_V1_CONFIG');
let config;
try {
  const info = await stat(configPath);
  if ((info.mode & 0o777) !== 0o600 || !info.isFile()) fail('protected config must be a regular file with mode 0600');
  config = JSON.parse(await readFile(configPath, 'utf8'));
} catch { fail('protected config is unavailable or invalid JSON'); }
const validRef = value => typeof value === 'string' && value.trim().length > 0 && !/[\r\n\0]/u.test(value);
let releaseRoot;
try { releaseRoot=immutableNoticePlaceReleaseRoot(import.meta.url); } catch { fail('launcher must run from an immutable SHA release bundle'); }
if (!config || config.schemaVersion !== 1
  || !validRef(config.noticeplaceBearerEnv) || !validRef(config.gptadmin?.target) || !validRef(config.gptadmin?.profileFile)
  || !validRef(config.policyPath) || !validRef(config.stateDirectory) || !validRef(config.cwd)
  || !validRef(config.instance?.instanceRef) || config.instance?.harness !== 'opencode'
  || config.instance?.model !== 'minimax-coding-plan/MiniMax-M3.1-Flash'
  || !['start','queue'].includes(config.instance?.deliveryMode)
  || config.instance?.instanceRef !== 'opencode-noticeplace-local'
  || !validRef(config.instance?.baseUrl)
  || config.bind?.host !== '127.0.0.1' || !Number.isInteger(config.bind?.port) || config.bind.port < 1 || config.bind.port > 65535)
  fail('protected config does not satisfy the v1 NoticePlace runtime schema');
try {
  const info=await stat(config.noticeplaceEnvFile);
  if((info.mode&0o777)!==0o600||!info.isFile()||info.uid!==process.getuid?.())fail('NoticePlace env file must be user-owned mode 0600');
  const content=await readFile(config.noticeplaceEnvFile,'utf8');
  const line=content.split(/\r?\n/u).find(row=>row.trim().startsWith(`${config.noticeplaceBearerEnv}=`));
  const value=line?.slice(line.indexOf('=')+1).trim().replace(/^(['"])(.*)\1$/u,'$2');
  if(!value)fail('configured NoticePlace bearer reference is unavailable');
  process.env[config.noticeplaceBearerEnv]=value;
} catch { fail('protected NoticePlace env file is unavailable'); }
let deps;
try {
  const runtime = await import(pathToFileURL(resolve(releaseRoot,'dist/automation/v1-noticeplace-runtime.js')).href);
  deps = await runtime.createNoticePlaceRuntime(config);
} catch { fail('production runtime bootstrap refused configuration'); }
if (!deps || !deps.policyStore || !deps.attempts || !deps.runner || !deps.ownerState) fail('runtime bootstrap returned incomplete facade dependencies');
const { createV1NoticePlaceServer } = await import(pathToFileURL(resolve(releaseRoot,'dist/v1-noticeplace-server.js')).href);
const server = createV1NoticePlaceServer(deps);
server.on('error', () => fail('HTTP facade failed to bind'));
server.listen(config.bind.port, config.bind.host, () => console.error(`[noticeplace-v1] listening on ${config.bind.host}:${config.bind.port}`));
const shutdown = () => server.close(() => process.exit(0));
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
