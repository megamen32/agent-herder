from pathlib import Path
import difflib,json,subprocess,shutil,os
subprocess.run(['git','diff','--exit-code','--quiet','HEAD','--','src'],check=True)
packet=Path('.tmp/active-release');repl=[]
for p in ['session-supervisor.js','adapters/minimax-code.js','adapters/zcode.js','adapters/opencode.js','adapters/zcode-protocol.js','adapters/zcode-runtime-observation.js','mesh/fleet-direct-transport.js','mesh/local.js']:
 a=(packet/'base'/p).read_text().splitlines(keepends=True);b=(Path('dist')/p).read_text().splitlines(keepends=True)
 for g in difflib.SequenceMatcher(None,a,b).get_grouped_opcodes(3 if p=='mesh/local.js' else 1):repl.append(dict(path=p,before=''.join(a[g[0][1]:g[-1][2]]),after=''.join(b[g[0][3]:g[-1][4]])))
for item in repl:
 if item['path']!='mesh/local.js':continue
 b=item['before'].splitlines(keepends=True);a=item['after'].splitlines(keepends=True)
 while b and a and b[0]==a[0]:b.pop(0);a.pop(0)
 suffix=[]
 while b and a and b[-1]==a[-1]:suffix.insert(0,b.pop());a.pop()
 if not b:b=suffix;a+=suffix
 item['before']=''.join(b);item['after']=''.join(a)
def add(p,b,a):repl.append(dict(path=p,before=b,after=a))
add('adapters/codex-app-server.js','import { execFile } from "node:child_process";','import { readCodexActiveRuntime } from "./codex-active-runtime.js";\nimport { execFile } from "node:child_process";')
codex=Path('dist/adapters/codex-app-server.js').read_text();start=codex.index('    activeSessionSnapshotReceipt = null;');end=codex.index('    async listSessions(options = {}) {',start)
add('adapters/codex-app-server.js','    async listSessions(options = {}) {',codex[start:end]+'    async listSessions(options = {}) {')
add('index.js','import { registerSessionSearchTools }','import { registerActiveSessionTools } from "./mcp/active-session-tools.js";\nimport { registerSessionWorkspaceTools } from "./session-workspaces-tools.js";\nimport { registerSessionSearchTools }')
add('index.js','    registerRagTools(server, adapters);','    registerRagTools(server, adapters);\n    registerActiveSessionTools(server);\n    registerSessionWorkspaceTools(server);')
web=Path('dist/web/server.js').read_text();start=web.index('    if (request.method === "GET" && url.pathname === "/api/sessions/active")');end=web.index('    if (request.method === "GET" && url.pathname === "/api/sessions")',start);block=web[start:end]
add('web/server.js','import { projectSessionInventory }','import { startActiveInventoryOwner } from "../active-session-inventory.js";\nimport { listActiveSessions } from "../mcp/active-session-tools.js";\nimport { projectSessionInventory }')
add('web/server.js','    const rag = agentHerderRag();','    const rag = agentHerderRag();\n    const stopActiveInventory = process.env.VITEST ? undefined : startActiveInventoryOwner(() => supervisor.nativeInventorySnapshot(), dependencies.adapters);')
add('web/server.js','    server.once("close", () => {','    server.once("close", () => {\n        stopActiveInventory?.();')
add('web/server.js','    if (request.method === "GET" && url.pathname === "/api/sessions")',block+'    if (request.method === "GET" && url.pathname === "/api/sessions")')
add('mcp/session-tools.js','List all coding agent sessions, including ZCode. Filter by harness, status, age','Historical/session browsing. For a current global active inventory with actual code work hosts, multiple paths and freshness use list_active_sessions. List coding agent sessions, including ZCode. Filter by harness, status, age')
add('index.js','            "Use Herder to inspect/message agents. Send necessary decisions, conflicts or results; no ACK.",','            "Use Herder to inspect/message agents. Send necessary decisions, conflicts or results; no ACK.",\n            "For coding tasks, publish actual code work computers and all absolute project paths with session_workspaces_declare at task start and when locations change. Runtime/GUI host and launch cwd are separate; keep unknown locations explicit. This information does not gate ordinary reads or builds.",')
add('web/server.js','import { startActiveInventoryOwner }',web.splitlines()[0]+'\nimport { startActiveInventoryOwner }')
add('web/server.js','    const rag = agentHerderRag();','    const rag = agentHerderRag();\n    const stopActiveFleetInventory = process.env.VITEST ? undefined : startActiveFleetInventoryOwner();')
add('web/server.js','        stopActiveInventory?.();','        stopActiveInventory?.();\n        stopActiveFleetInventory?.();')
new=['active-session-inventory','mcp/active-session-tools','session-workspaces','session-workspaces-tools','session-workspaces-backfill','adapters/minimax-code-active','adapters/zcode-active','adapters/opencode-active','adapters/zcode-server-control','adapters/codex-active-runtime','active-session-fleet']
for p in new:
 target=packet/'overlay'/(p+'.js');target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(Path('dist')/(p+'.js'),target)
for item in repl:
 if item['path']=='adapters/codex-app-server.js' and item['before'].startswith('import { execFile }'):item['alreadyPresent']=['import { readCodexActiveRuntime } from \"./codex-active-runtime.js\";']
 if item['path']=='index.js' and item['before']=='    registerRagTools(server, adapters);':item['alreadyPresent']=['registerActiveSessionTools(server);','registerSessionWorkspaceTools(server);']
base=Path('/home/roomhacker/agents-projects/.fleet-candidate/current/dist');files={}
for item in ([] if os.environ.get('HERDER_SKIP_LOCAL_BASE_VALIDATION') else repl):
 data=files.get(item['path'],(base/item['path']).read_text());
 if data.count(item['after'])==1 or (item.get('alreadyPresent') and all(x in data for x in item['alreadyPresent'])):continue
 assert data.count(item['before'])==1,(item['path'],item['before'][:100]);files[item['path']]=data.replace(item['before'],item['after'],1)
sha=os.environ.get('HERDER_PATCH_SOURCE_SHA') or subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();sha=subprocess.check_output(['git','rev-parse',sha],text=True).strip();sources=subprocess.check_output(['git','diff','--name-only','f139e3f..'+sha],text=True).splitlines();blobs={p:subprocess.check_output(['git','rev-parse',sha+':'+p],text=True).strip() for p in sources if p.startswith('src/')}
(packet/'patch.json').write_text(json.dumps(dict(patchSourceSha=sha,sourceGitBlobs=blobs,files=new,replacements=repl),indent=2)+'\n');print('packet validated',len(repl),'surgical hunks',len(new),'new modules',sha)
