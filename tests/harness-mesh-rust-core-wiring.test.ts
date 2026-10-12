import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,chmod,lstat,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {configuredFleetRustCore} from '../src/web/fleet-wiring.js';

test('explicit core configuration preserves disabled default and refuses invalid endpoints',()=>{
 assert.equal(configuredFleetRustCore('', 'local'),undefined);
 assert.throws(()=>configuredFleetRustCore('relative','local'),/configuration_invalid/);
});

// Focused integration: real compiled shared Rust core; no native sessions,
// browser, credentials, remote tool effects or another service's lifecycle.
test('configured Fleet resolver uses the real core and preserves exact owner',{skip:!process.env.MESH_CORE_TEST_BINARY},async()=>{
 const binary=process.env.MESH_CORE_TEST_BINARY;
 assert.ok(binary,'real core binary required; fake acceptance is forbidden');
 assert.ok(process.env.TMPDIR,'owned admitted temporary directory required');
 const dir=await mkdtemp(join(process.env.TMPDIR!,'c-'));await chmod(dir,0o700);
 const socket=join(dir,'c.sock');assert.ok(Buffer.byteLength(socket)<104,'owned socket path exceeds native bound');
 const child=spawn(binary!,['--socket',socket],{stdio:['ignore','ignore','pipe']});const exit=once(child,'exit');
 const boundedExit=async()=>{
  let timer:NodeJS.Timeout|undefined;
  try{return await Promise.race([exit,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('owned core shutdown deadline')),2000);})]);}
  finally{clearTimeout(timer);}
 };
 const stop=async()=>{
  if(child.exitCode!==null||child.signalCode!==null)return;
  child.kill('SIGTERM');
  try{await boundedExit();}catch(error){child.kill('SIGKILL');await boundedExit();throw error;}
 };
 try{
  let ready=false;for(let i=0;i<40;i++){try{await lstat(socket);ready=true;break;}catch{}if(child.exitCode!==null)throw new Error('real core failed during startup');await new Promise(r=>setTimeout(r,25));}
  assert.ok(ready);
  const core=configuredFleetRustCore(socket,'local')!;
  assert.equal(await core.resolveHost('server-44',['server-44','server-88'],'wiring-own-read'),'server-44');
  await assert.rejects(core.resolveHost('foreign',['server-44'],'wiring-unknown-read'));
  await stop();assert.equal(child.exitCode,0);
  await assert.rejects(core.resolveHost('server-44',['server-44'],'wiring-owned-unavailable-read'));
 }finally{
  await stop();
  await rmdir(dir); // Core removes only its own socket generation.
 }
});
