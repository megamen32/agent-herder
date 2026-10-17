import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,chmod,lstat,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {configuredFleetRustCore} from '../src/web/fleet-wiring.js';

it('explicit core configuration preserves disabled default and refuses invalid endpoints',()=>{
 expect(configuredFleetRustCore('', 'local')).toBeUndefined();
 expect(()=>configuredFleetRustCore('relative','local')).toThrow(/configuration_invalid/);
});

// Focused integration: real compiled shared Rust core; no native sessions,
// browser, credentials, remote tool effects or another service's lifecycle.
it.skipIf(!process.env.MESH_CORE_TEST_BINARY)('configured Fleet resolver uses the real core and preserves exact owner',async()=>{
 const binary=process.env.MESH_CORE_TEST_BINARY as string;
 expect(binary).toBeTruthy();
 expect(process.env.TMPDIR).toBeTruthy();
 const dir=await mkdtemp(join(process.env.TMPDIR!,'c-'));await chmod(dir,0o700);
 const socket=join(dir,'c.sock');expect(Buffer.byteLength(socket)<104).toBe(true);
 const child=spawn(binary,['--socket',socket],{stdio:['ignore','ignore','pipe']});const exit=once(child,'exit');
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
  expect(ready).toBe(true);
  const core=configuredFleetRustCore(socket,'local')!;
  expect(await core.resolveHost('server-44',['server-44','server-88'],'wiring-own-read')).toBe('server-44');
  await expect(core.resolveHost('foreign',['server-44'],'wiring-unknown-read')).rejects.toThrow();
  await stop();expect(child.exitCode).toBe(0);
  await expect(core.resolveHost('server-44',['server-44'],'wiring-owned-unavailable-read')).rejects.toThrow();
 }finally{
  await stop();
  await rmdir(dir); // Core removes only its own socket generation.
 }
});
