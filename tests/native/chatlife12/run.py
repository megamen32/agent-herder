#!/usr/bin/env python3
"""Isolated real Rust -> bundled AHAP -> UserIO HTTP -> extension fixture."""
import json,os,pathlib,subprocess,sys,urllib.request
root=pathlib.Path(sys.argv[1]).resolve(); userio=pathlib.Path(sys.argv[2]).resolve(); build=pathlib.Path(sys.argv[3]).resolve()
root.mkdir(mode=0o700,parents=True,exist_ok=False)
server=subprocess.Popen(['node',str(pathlib.Path(__file__).with_name('server.mjs')),str(userio/'extensions/vk-inbox')],stdout=subprocess.PIPE,text=True)
core=None
try:
 info=json.loads(server.stdout.readline()); endpoint='http://127.0.0.1:'+str(info['port'])
 def control(v={}):
  req=urllib.request.Request(endpoint+'/control',data=json.dumps(v).encode(),headers={'content-type':'application/json'});return json.load(urllib.request.urlopen(req))
 home=root/'herder-owner-home';home.mkdir(mode=0o700)
 boot='/home/roomhacker/herder-artifacts/releases/herder-v1-userio-schema-2d70f4b9/fixture/ahap-owner-bootstrap'
 seed=json.loads(subprocess.check_output([boot,str(home)],text=True))
 token=home/'token';token.write_text('fixture-token-only');token.chmod(0o600)
 bundle=build/'fixture/ahap-browser-runner.mjs';bundle.chmod(0o500)
 env={'AHAP_BROWSER_TRANSPORT':'userio','AHAP_BROWSER_ACCOUNT_SCOPE':info['scope'],'AHAP_USERIO_ENDPOINT':endpoint,'AHAP_USERIO_AGENT_ID':info['agent'],'AHAP_USERIO_INSTANCE_ID':info['instance'],'AHAP_USERIO_TOKEN_FILE':str(token),'AHAP_USERIO_CONNECTION_ID':info['connection'],'AHAP_USERIO_PRINCIPAL_ID':info['principal']}
 profile={k:seed[k] for k in ('database','gate','generation')};profile['owner']={'kind':'chatgpt','principal':'fixture-owner','node':'node','instance':'chatgpt-fixture','executable':os.path.realpath(subprocess.check_output(['which','node'],text=True).strip()),'ahap_script':str(bundle),'ahap_env':env,'code_home':str(home),'cwd':str(home)}
 path=home/'authority/profile.json';path.write_text(json.dumps(profile));path.chmod(0o600)
 binary=build/'target/release/herder_native_stdio'
 def start():return subprocess.Popen([str(binary),'--trusted-owner-profile',str(path)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,bufsize=1)
 core=start(); counter=0
 meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{'extensions':{'io.modelcontextprotocol/tasks':{}}},'io.modelcontextprotocol/clientInfo':{'name':'fixture','version':'1'}}
 def call(method,params):
  global counter
  counter+=1;req={'jsonrpc':'2.0','id':counter,'method':method,'params':{'_meta':meta,**params}}
  core.stdin.write(json.dumps(req)+'\n');core.stdin.flush();line=core.stdout.readline()
  if not line:raise RuntimeError('core closed')
  result=json.loads(line);print(json.dumps({'request':req,'response':result}),flush=True);return result
 def tool(name,args):return call('tools/call',{'name':name,'arguments':args})
 def finish(r):
  task=r['result']['taskId'];return call('tasks/get',{'taskId':task})
 if len(sys.argv)>4 and sys.argv[4]=='unknown':
  control({'hideNext':True})
  args={'action':'create','instance_ref':'chatgpt-fixture','prompt':'unknown fixture message','request_key':'unknown-create'}
  created=finish(tool('create',args));assert created['result']['result']['structuredContent']['prompt']['code']=='outcome_unknown'
  assert control()['sends']==1
  files=list((home/'.local/state/agent-herder/browser-chat-drafts/chatgpt'/info['scope']).glob('*.json'));assert len(files)==1
  draft=json.loads(files[0].read_text());assert draft['state']=='uncertain' and draft['commandId']
  original=draft['commandId'];assert any(r['id']==original and r['action']=='gpt_first_send' for r in control()['results'])
  core.stdin.close();core.wait(timeout=20);core=start()
  replay=finish(tool('create',args));assert control()['sends']==1
  core.stdin.close();core.wait(timeout=20);core=None
  nativeenv={'HOME':str(home),'PATH':'/usr/bin:/bin','AHAP_HARNESS':'chatgpt','AHAP_VERSION':'0.1',**env}
  adapter=subprocess.Popen([profile['owner']['executable'],str(bundle)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True,env=nativeenv,bufsize=1)
  def ahap(method,params):
   ahap.seq+=1;adapter.stdin.write(json.dumps({'jsonrpc':'2.0','id':ahap.seq,'method':method,'params':params})+'\n');adapter.stdin.flush();r=json.loads(adapter.stdout.readline());print('AHAP',json.dumps(r),flush=True);return r
  ahap.seq=0
  ahap('initialize',{'harness':'chatgpt','ahapVersion':'0.1'});ahap('init',{})
  sessions=ahap('listSessions',{})['result'];drafts=[s for s in sessions if s.get('meta',{}).get('pendingRemoteCreation')];assert len(drafts)==1,sessions
  recovered=ahap('sendMessage',{'id':drafts[0]['id'],'options':{'message':'unknown fixture message','queue':True,'inputId':'same-original'}})
  assert recovered['result']['nativeInputMessageId']=='00000002-0000-4000-8000-000000000000',recovered
  assert control()['sends']==1;after=json.loads(files[0].read_text());assert after['commandId']==original and after['state']=='admitted'
  adapter.stdin.close();adapter.wait(timeout=20)
  print(json.dumps({'PASS':'UNKNOWN original command receipt recovered after restart; no resend','commandId':original}),flush=True)
  sys.exit(0)
 bad=tool('create',{'action':'create','instance_ref':'foreign','prompt':'forbidden','request_key':'bad'});assert bad['result']['isError'];assert control()['sends']==0
 created=finish(tool('create',{'action':'create','instance_ref':'chatgpt-fixture','prompt':'first fixture message','request_key':'create-one'}))
 content=created['result']['result']['structuredContent'];assert content['prompt']['outcome']=='confirmed',content
 session=content['create']['session_ref'];assert control()['sends']==1
 second=finish(tool('deliver',{'action':'session','session_ref':session,'message':'second fixture message','mode':'queue','request_key':'second-one'}));assert second['result']['result']['structuredContent']['outcome']=='confirmed',second
 assert control()['sends']==2
 core.stdin.close();core.wait(timeout=20);core=start()
 read=tool('session',{'action':'messages','session_ref':session});rows=read['result']['structuredContent']['page']['messages'];assert any(m['text']=='first fixture message' for m in rows);assert any(m['text']=='second fixture message' for m in rows)
 archived=tool('session',{'action':'archive','session_ref':session,'request_key':'archive-one'});assert archived['result']['structuredContent']['archived'];assert control()['archived']
 control({'mismatch':True});denied=tool('session',{'action':'messages','session_ref':session});assert denied['result'].get('isError');assert control()['sends']==2;control({'mismatch':False})
 print(json.dumps({'PASS':'first send, second send, restart read, scope refusal, archive','state':control()}),flush=True)
finally:
 if core and core.poll() is None:
  core.stdin.close()
  try:core.wait(timeout=10)
  except subprocess.TimeoutExpired:core.terminate();core.wait(timeout=5)
 server.terminate();server.wait(timeout=5)
