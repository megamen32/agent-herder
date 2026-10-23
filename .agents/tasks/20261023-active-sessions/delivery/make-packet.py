from pathlib import Path
import difflib,json,subprocess,shutil
subprocess.run(['git','diff','--exit-code','--quiet','HEAD','--','src'],check=True)
packet=Path('.tmp/active-release');repl=[]
for p in ['session-supervisor.js','adapters/minimax-code.js','adapters/zcode.js','adapters/opencode.js']:
 a=(packet/'base'/p).read_text().splitlines(keepends=True);b=(Path('dist')/p).read_text().splitlines(keepends=True)
 for g in difflib.SequenceMatcher(None,a,b).get_grouped_opcodes(1):repl.append(dict(path=p,before=''.join(a[g[0][1]:g[-1][2]]),after=''.join(b[g[0][3]:g[-1][4]])))
def add(p,b,a):repl.append(dict(path=p,before=b,after=a))
add('index.js','import { registerSessionSearchTools }','import { registerActiveSessionTools } from "./mcp/active-session-tools.js";\nimport { registerSessionWorkspaceTools } from "./session-workspaces-tools.js";\nimport { registerSessionSearchTools }')
add('index.js','    registerRagTools(server, adapters);','    registerRagTools(server, adapters);\n    registerActiveSessionTools(server);\n    registerSessionWorkspaceTools(server);')
web=Path('dist/web/server.js').read_text();start=web.index('    if (request.method === "GET" && url.pathname === "/api/sessions/active")');end=web.index('    if (request.method === "GET" && url.pathname === "/api/sessions")',start);block=web[start:end]
add('web/server.js','import { projectSessionInventory }','import { startActiveInventoryOwner } from "../active-session-inventory.js";\nimport { listActiveSessions } from "../mcp/active-session-tools.js";\nimport { projectSessionInventory }')
add('web/server.js','    const rag = agentHerderRag();','    const rag = agentHerderRag();\n    const stopActiveInventory = process.env.VITEST ? undefined : startActiveInventoryOwner(() => supervisor.nativeInventorySnapshot(), dependencies.adapters);')
add('web/server.js','    server.once("close", () => {','    server.once("close", () => {\n        stopActiveInventory?.();')
add('web/server.js','    if (request.method === "GET" && url.pathname === "/api/sessions")',block+'    if (request.method === "GET" && url.pathname === "/api/sessions")')
add('mcp/session-tools.js','List all coding agent sessions, including ZCode. Filter by harness, status, age','Historical/session browsing. For a current global active inventory with actual code work hosts, multiple paths and freshness use list_active_sessions. List coding agent sessions, including ZCode. Filter by harness, status, age')
add('index.js','            "Use Herder to inspect/message agents. Send necessary decisions, conflicts or results; no ACK.",','            "Use Herder to inspect/message agents. Send necessary decisions, conflicts or results; no ACK.",\n            "For coding tasks, publish actual code work computers and all absolute project paths with session_workspaces_declare at task start and when locations change. Runtime/GUI host and launch cwd are separate; keep unknown locations explicit. This information does not gate ordinary reads or builds.",')
new=['active-session-inventory','mcp/active-session-tools','session-workspaces','session-workspaces-tools','session-workspaces-backfill','adapters/minimax-code-active','adapters/zcode-active','adapters/opencode-active']
for p in new:
 target=packet/'overlay'/(p+'.js');target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(Path('dist')/(p+'.js'),target)
base=Path('/home/roomhacker/agents-projects/.fleet-candidate/current/dist');files={}
for item in repl:
 data=files.get(item['path'],(base/item['path']).read_text());assert data.count(item['before'])==1,(item['path'],item['before'][:100]);files[item['path']]=data.replace(item['before'],item['after'],1)
sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();sources=subprocess.check_output(['git','diff','--name-only','f139e3f..HEAD'],text=True).splitlines();blobs={p:subprocess.check_output(['git','rev-parse','HEAD:'+p],text=True).strip() for p in sources if p.startswith('src/')}
(packet/'patch.json').write_text(json.dumps(dict(patchSourceSha=sha,sourceGitBlobs=blobs,files=new,replacements=repl),indent=2)+'\n');print('packet validated',len(repl),'surgical hunks',len(new),'new modules',sha)
