import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
// Release utility, not an SDK/vendor copy. Fast unit expected <1s/max5s.
// @ts-expect-error Plain Node packaging entrypoint has no TS declaration.
import { prepareCodexNativeProjection } from '../scripts/prepare-codex-native-projection.mjs';

async function fixture(root:string) {
 const source=join(root,'package');
 const values:Record<string,unknown>={
  'package.json':{name:'agent-herder',version:'0.2.2',type:'module'},
  'plugin.json':{$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'agent-herder',extensions:{'com.openai':{hooks:'./com.openai/hooks/hooks.json'}}},
  '.codex-plugin/plugin.json':{name:'agent-herder',version:'0.2.2',hooks:'./com.openai/hooks/hooks.json',skills:'./skills/',mcpServers:'./.mcp.json'},
  '.agents/plugins/marketplace.json':{name:'agent-herder-local',plugins:[{name:'agent-herder',source:{source:'local',path:'.'},policy:{installation:'AVAILABLE',authentication:'ON_INSTALL'}}]},
  '.mcp.json':{mcpServers:{'agent-herder':{type:'http',url:'http://127.0.0.1:18787/mcp'}}},
  'com.openai/hooks/hooks.json':{hooks:{Stop:[{hooks:[{type:'command',command:'node "${PLUGIN_ROOT}/scripts/codex-stop-hook.mjs"'}]}]}},
  'node_modules/proper-lockfile/package.json':{name:'proper-lockfile',version:'4.1.2',dependencies:{retry:'0.12.0'}},
  'node_modules/retry/package.json':{name:'retry',version:'0.12.0'},
 };
 for(const [path,value]of Object.entries(values)){await mkdir(join(source,path,'..'),{recursive:true});await writeFile(join(source,path),JSON.stringify(value));}
 for(const [path,value]of Object.entries({'dist/autopilot-hook.js':'import lock from "proper-lockfile"; import "./sql-module.js";' , 'dist/sql-module.js':"const sql = \"select * from ' + table + '\"; // from 'not-a-package'\nexport {};",'dist/autopilot-runner.js':'process.stdout.write(JSON.stringify({enabled:false}));','dist/human-stop-store.js':'import lock from "proper-lockfile";','scripts/codex-stop-hook.mjs':'process.stdout.write("{}");','scripts/coordination-hook.mjs':'process.stdout.write("{}");','scripts/autopilot-hook-launcher.sh':'#!/bin/bash\n','scripts/autopilot-command-launcher.sh':await readFile(join(process.cwd(),'scripts/autopilot-command-launcher.sh'),'utf8'),'skills/autopilot/scripts/run.sh':await readFile(join(process.cwd(),'skills/autopilot/scripts/run.sh'),'utf8'),'skills/autopilot/SKILL.md':'native skill','skills/chat-triage/SKILL.md':'triage'})){
  await mkdir(join(source,path,'..'),{recursive:true});await writeFile(join(source,path),value);
 }
 return source;
}
describe('native legacy projection without losing portable plugin',()=>{
 it('builds a deterministic native package with exact hooks/HTTP/skills/dependencies and no root AgentPlugin',async()=>{
  const root=await mkdtemp(join(tmpdir(),'herder-codex-projection-'));
  try{
   const source=await fixture(root),original=await readFile(join(source,'plugin.json'));
   const first=await prepareCodexNativeProjection(source,join(root,'first'),'0.2.3');
   const second=await prepareCodexNativeProjection(source,join(root,'second'),'0.2.3');
   expect(first.version).toBe(second.version);expect(first.version).toBe('0.2.3');expect(first.releaseHash).toBe(second.releaseHash);
   await expect(prepareCodexNativeProjection(source,join(root,'old-version'),'0.2.2')).rejects.toThrow('exceed');
   await expect(prepareCodexNativeProjection(source,join(root,'pre-version'),'0.2.2-codex-native.hash')).rejects.toThrow('stable');
   await expect(readFile(join(root,'first','plugin.json'))).rejects.toThrow();
   expect(await readFile(join(source,'plugin.json'))).toEqual(original);
   for(const path of ['com.openai/hooks/hooks.json','.mcp.json','skills/autopilot/SKILL.md','scripts/codex-stop-hook.mjs','node_modules/retry/package.json'])expect(await readFile(join(root,'first',path))).toEqual(await readFile(join(source,path)));
   await mkdir(join(root,'home'),{recursive:true});
   const consumer=await promisify(execFile)('bash',[join(root,'first','skills/autopilot/scripts/run.sh'),'status'],{env:{...process.env,HOME:join(root,'home'),CLAUDE_CODE_SESSION_ID:'',CODEX_THREAD_ID:'isolated-projection-fixture',PLUGIN_ROOT:join(root,'first'),AGENT_HERDER_NODE_BIN:process.execPath,AGENT_HERDER_AUTOPILOT_STATE_DIR:join(root,'state')},timeout:5000});
   expect(consumer.stdout).toContain('Autopilot выключен');
   const legacy=JSON.parse(await readFile(join(root,'first','.codex-plugin/plugin.json'),'utf8'));
   expect(legacy.name).toBe('agent-herder');expect(legacy.version).toBe(first.version);
   const route=JSON.parse(await readFile(first.marketplacePath,'utf8'));expect(route.name).toBe('agent-herder-local');expect(route.plugins[0].source.path).toBe('.');
   await expect(prepareCodexNativeProjection(source,join(root,'first'),'0.2.3')).rejects.toThrow('already exists');
  }finally{await rm(root,{recursive:true,force:true});}
 });
 it.each(['dependency-missing','symlink','spawn-mcp','outside-import'] as const)('rejects unsupported release inputs: %s',async boundary=>{
  const root=await mkdtemp(join(tmpdir(),'herder-codex-projection-invalid-'));
  try{
   const source=await fixture(root);
   if(boundary==='dependency-missing')await rm(join(source,'node_modules/retry'),{recursive:true});
   if(boundary==='symlink'){await rm(join(source,'scripts/codex-stop-hook.mjs'));await symlink('/etc/passwd',join(source,'scripts/codex-stop-hook.mjs'));}
   if(boundary==='spawn-mcp')await writeFile(join(source,'.mcp.json'),JSON.stringify({mcpServers:{'agent-herder':{type:'http',url:'http://127.0.0.1:18787/mcp',command:'node'}}}));
   if(boundary==='outside-import')await writeFile(join(source,'dist/autopilot-hook.js'),'import x from "../../private.js";');
   await expect(prepareCodexNativeProjection(source,join(root,'output'),'0.2.3')).rejects.toThrow();
  }finally{await rm(root,{recursive:true,force:true});}
 });
});
