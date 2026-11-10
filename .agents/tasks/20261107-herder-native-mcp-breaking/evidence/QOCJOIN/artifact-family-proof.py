import http.server,threading,subprocess,os,json
runner=os.environ.get('HERDER_PROOF_RUNNER','/home/roomhacker/herder-artifacts/releases/ahap-qocjoin-1d20b7f1/fixture/runner.mjs')
for family in ['v2','v22']:
 class H(http.server.BaseHTTPRequestHandler):
  sent=False; calls=[]
  def log_message(self,*args):pass
  def answer(self,status,data):
   self.send_response(status);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps(data).encode())
  def do_GET(self):
   self.calls.append(('GET',self.path))
   if self.path=='/api/config': return self.answer(200,[{'path':'/api/session','type':'object'}]) if family=='v2' else self.answer(404,{})
   if self.path=='/global/health':return self.answer(200,None)
   if self.path.split('?')[0].endswith('/ses_test/message'):return self.answer(200,[{'id':'msg_ABC','info':{'id':'msg_ABC','role':'user'},'parts':[{'type':'text','text':'hello'}]}] if self.sent else [])
   return self.answer(200,{'id':'ses_test','title':'worker','directory':'/tmp/work','time':{'created':1,'updated':1}})
  def do_POST(self):
   body=json.loads(self.rfile.read(int(self.headers.get('content-length','0'))) or b'{}');self.calls.append(('POST',self.path,body))
   if self.path==('/api/session' if family=='v2' else '/session'):return self.answer(200,{'id':'ses_test','title':'worker','directory':'/tmp/work','time':{'created':1,'updated':1}})
   if self.path==('/api/session/ses_test/prompt' if family=='v2' else '/session/ses_test/message'):
    H.sent=True;return self.answer(200,{'id':'msg_ABC'} if family=='v2' else {'ok':True})
   return self.answer(405,{})
 s=http.server.HTTPServer(('127.0.0.1',0),H);threading.Thread(target=s.serve_forever,daemon=True).start()
 env={**os.environ,'AHAP_VERSION':'0.1','AHAP_HARNESS':'opencode','AHAP_OPENCODE_BASE_URL':f'http://127.0.0.1:{s.server_port}'}
 p=subprocess.Popen(['/usr/local/bin/node',runner],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env)
 requests=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'harness':'opencode','ahapVersion':'0.1'}},{'jsonrpc':'2.0','id':2,'method':'createSession','params':{'options':{'name':'worker','cwd':'/tmp/work'}}},{'jsonrpc':'2.0','id':3,'method':'sendMessage','params':{'id':'ses_test','options':{'message':'hello','queue':False,'start':True,'activeTurnOnly':True,'inputId':'key'}}},{'jsonrpc':'2.0','id':4,'method':'shutdown'}]
 for q in requests:
  p.stdin.write(json.dumps(q)+'\n');p.stdin.flush();r=json.loads(p.stdout.readline()); assert 'error' not in r,(family,r)
  if q['id']==1: assert r['result']['capabilities']['nativeProtocol']==family,(family,r)
  if q['id']==3: assert r['result']['nativeInputMessageId']=='msg_ABC',(family,r)
 p.wait(timeout=5);s.shutdown(); posts=[c for c in H.calls if c[0]=='POST']; assert len(posts)==2,(family,posts)
 expected={'text':'hello','delivery':'queue','metadata':{'agentHerderInputId':'key'}} if family=='v2' else {'parts':[{'type':'text','text':'hello'}]}
 assert posts[1][2]==expected,(family,posts);print(family,'PASS',json.dumps(posts))
