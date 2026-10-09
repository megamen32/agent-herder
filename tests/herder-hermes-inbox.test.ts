import {expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
// Fast unit of the real plugin callback; catches lost ACK dropping an already-read context. <1s/max5s.
it('returns received Hermes context even when inbox acknowledgement loses its response',()=>{
 const code=`import ast,os,urllib.parse\nfrom pathlib import Path\np=Path('integrations/hermes/agent-herder-autopilot/__init__.py')\ntree=ast.parse(p.read_text())\nnode=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_coordination_pre_llm')\ndef api(path,payload=None):\n if 'inbox-ack' in path: raise TimeoutError('ack response lost after remove')\n return {'context':'received decision','inboxIds':['one']}\nns={'Any':object,'os':os,'urllib':urllib,'_coordination_api':api}\nexec(compile(ast.Module(body=[node],type_ignores=[]),str(p),'exec'),ns)\nassert ns['_coordination_pre_llm'](session_id='owned') == {'context':'received decision'}\n`;
 const result=spawnSync('python3',['-c',code],{encoding:'utf8'});expect(result.status,result.stderr).toBe(0);
});
