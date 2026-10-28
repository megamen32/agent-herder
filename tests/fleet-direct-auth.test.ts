import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const program = readFileSync(new URL("../src/mesh/fleet-direct-transport.ts", import.meta.url), "utf8").split("const bridge=String.raw`")[1]!.split("`;")[0]!;
// Execute the production Python bridge against an in-memory HTTP opener. No
// network, native process, owner credential or installed state is involved.
const fixture = String.raw`import sys,json,io,socket,pwd,os,tempfile,pathlib,types,urllib.request,urllib.error
packet=json.loads(sys.stdin.read());source=packet['program'];mode=packet['mode']
real_user=pwd.getpwuid(os.getuid())
with tempfile.TemporaryDirectory() as home:
 pwd.getpwuid=lambda uid:types.SimpleNamespace(pw_name=real_user.pw_name,pw_dir=home)
 os.environ.pop('AGENT_HERDER_HTTP_TOKEN',None)
 if mode=='env':os.environ['AGENT_HERDER_HTTP_TOKEN']='isolated-fixture-token'
 if mode in ['file','unsafe-file','unauthorized','forbidden','rpc-error','symlink']:
  path=pathlib.Path(home)/'.config/agent-herder/herder.env';path.parent.mkdir(parents=True)
  path.write_text("export AGENT_HERDER_HTTP_TOKEN='isolated-fixture-token'\nUNRELATED=$(must_not_execute)\n")
  path.chmod(0o644 if mode=='unsafe-file' else 0o600)
  if mode=='symlink':target=path.with_name('fixture.env');path.rename(target);path.symlink_to(target)
 class Reply:
  def __init__(self,value):self.headers={'Content-Type':'application/json'};self.body=io.BytesIO(json.dumps(value).encode())
  def __enter__(self):return self
  def __exit__(self,*args):return False
  def read1(self,n):return self.body.read(n)
 class Opener:
  def open(self,request,timeout):
   if request.get_header('Authorization')!='Bearer isolated-fixture-token' or mode in ['unauthorized','forbidden']:raise urllib.error.HTTPError(request.full_url,403 if mode=='forbidden' else 401,'unauthorized',{},None)
   data=json.loads(request.data)
   if mode=='rpc-error' and data['method']=='initialize':return Reply({'jsonrpc':'2.0','id':data.get('id'),'error':{'code':-32000,'message':'fixture failure'}})
   return Reply({'jsonrpc':'2.0','id':data.get('id'),'result':{'tools':[{'name':'automation_disarm'}]}})
 urllib.request.build_opener=lambda *args:Opener()
 request={'hostId':socket.gethostname(),'nativeUser':real_user.pw_name,'port':18791,'timeoutMs':10000,'method':'herder_runtime_probe','params':{}}
 sys.stdin=io.TextIOWrapper(io.BytesIO(json.dumps(request).encode()))
 exec(compile(source,'isolated-direct-auth-bridge','exec'))`;
function execute(mode: string) { return spawnSync("/usr/bin/python3", ["-I", "-S", "-B", "-c", fixture], { input: JSON.stringify({ program, mode }), encoding: "utf8", timeout: 5000, maxBuffer: 65536 }); }
it.each(["env", "file"])("authenticates the actual runtime probe using the canonical %s credential", mode => {
  const result = execute(mode);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ hasRuntime: true, hasDisarmTool: true });
  expect(result.stdout + result.stderr).not.toContain("isolated-fixture-token");
});
it.each(["missing", "unsafe-file", "unauthorized", "forbidden", "rpc-error", "symlink"])("does not turn %s authentication/protocol failure into no_runtime", mode => {
  const result = execute(mode);
  expect(result.status).not.toBe(0);
  expect(result.stdout).not.toContain('"hasRuntime": false');
  expect(result.stdout + result.stderr).not.toContain("isolated-fixture-token");
});
