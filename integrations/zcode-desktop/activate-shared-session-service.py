"""Attach the reviewed bridge to one existing native service, initially disabled.
No runtime/process restart, native input, script-source replacement or reload.
Expected10s/emergency100s. Always remove breakpoint and resume the native host.
"""
import argparse, hashlib, json, os, signal, socket, time, urllib.request
from pathlib import Path
import websocket

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--role',choices=['desktop','herder'],required=True);p.add_argument('--pid',type=int,required=True)
 p.add_argument('--start-ticks',required=True);p.add_argument('--live-source',type=Path,required=True)
 p.add_argument('--receipt',type=Path,required=True);a=p.parse_args()
 actual=Path(f'/proc/{a.pid}/stat').read_text().split(') ',1)[1].split()[19]
 if actual!=a.start_ticks:raise RuntimeError('Native process generation changed')
 probe=socket.socket();occupied=probe.connect_ex(('127.0.0.1',9229))==0;probe.close()
 if occupied:raise RuntimeError('Inspector already owned; no attachment')
 source=a.live_source.read_text();helper=Path(__file__).with_name('shared-session-service.mjs').read_text().replace('export function','function',1)
 if a.role=='desktop':
  marker='async function z(x){';off=source.index(marker,source.index('function $8('))+len(marker)
  condition='true'
 else:
  marker='let result = target.apply(handler, args || []);';off=source.index(marker)
  condition='command === "readSession"'
 line=source[:off].count('\n');column=len(source[:off].rsplit('\n',1)[-1].encode('utf-16-le'))//2
 os.kill(a.pid,signal.SIGUSR1);ws=None;bp=None;paused=False;seq=0;events=[]
 try:
  for _ in range(30):
   try:targets=json.load(urllib.request.urlopen('http://127.0.0.1:9229/json/list',timeout=.5));break
   except Exception:time.sleep(.1)
  else:raise RuntimeError('Native inspector unavailable')
  ws=websocket.create_connection(targets[0]['webSocketDebuggerUrl'],timeout=20)
  def call(method,params=None):
   nonlocal seq
   seq+=1;ws.send(json.dumps({'id':seq,'method':method,'params':params or {}}))
   while True:
    response=json.loads(ws.recv())
    if response.get('id')==seq:
     if 'error' in response:raise RuntimeError(method+' rejected')
     return response.get('result',{})
    events.append(response)
  call('Debugger.enable')
  suffix='/out/host/index.js' if a.role=='desktop' else '/.zcode/server/zcode-server.cjs'
  scripts=[e['params'] for e in events if e.get('method')=='Debugger.scriptParsed' and e['params'].get('url','').endswith(suffix)]
  if len(scripts)!=1:raise RuntimeError('Native script identity ambiguous')
  script=scripts[0]
  if call('Debugger.getScriptSource',{'scriptId':script['scriptId']})['scriptSource']!=source:raise RuntimeError('Exact live source differs; no activation')
  def fields_in_scopes(function_id, names):
   properties=call('Runtime.getProperties',{'objectId':function_id,'ownProperties':True})
   target=next((x.get('value',{}).get('objectId') for x in properties.get('internalProperties',[]) if x['name']=='[[TargetFunction]]'),None)
   if target:return fields_in_scopes(target,names)
   scopes=next(x['value']['objectId'] for x in properties.get('internalProperties',[]) if x['name']=='[[Scopes]]')
   found={}
   for entry in call('Runtime.getProperties',{'objectId':scopes,'ownProperties':True})['result']:
    identity=entry.get('value',{}).get('objectId')
    if not identity:continue
    for field in call('Runtime.getProperties',{'objectId':identity,'ownProperties':True})['result']:
     if field['name'] in names and field.get('value',{}).get('objectId'):found.setdefault(field['name'],field['value']['objectId'])
   return found
  # The approved catalogue observer already retains the exact native source
  # resolver. Reuse that closure instead of waiting for or triggering a UI read.
  service_id=scope_id=None
  if a.role=='desktop':
   ref=call('Runtime.evaluate',{'expression':'globalThis.__herderCatalogueRefreshV1?.keys().next().value','returnByValue':False})['result']
   if ref.get('objectId'):
    fields=fields_in_scopes(ref['objectId'],{'e','n','th'})
    if set(fields)=={'e','n','th'}:
     result=call('Runtime.callFunctionOn',{'objectId':fields['e'],'functionDeclaration':"function(scopes){return Array.from(scopes.values()).map(scope=>this.resolveSource(scope)).find(source=>source?.scope.kind==='local'&&source.agentService)?.agentService;}",'arguments':[{'objectId':fields['n']}]})
     service_id=result['result'].get('objectId');scope_id=fields['th']
  else:
   ref=call('Runtime.evaluate',{'expression':'globalThis.__herderSharedNativeV1?.values().next().value?.service','returnByValue':False})['result']
   if ref.get('objectId'):
    properties=call('Runtime.getProperties',{'objectId':ref['objectId'],'ownProperties':True})['result']
    fn=next(x['value']['objectId'] for x in properties if x['name']=='readSession')
    fields=fields_in_scopes(fn,{'createZCodeAgentConnectionScope'})
    if fields:service_id=ref['objectId'];scope_id=fields['createZCodeAgentConnectionScope']
  if service_id and scope_id:
   other='desktop' if a.role=='herder' else 'herder'
   function='''async function(createScope){
    const registry=globalThis.__herderSharedNativeV1??=new Set();
    for(const old of registry){if(old.enabled||old.owners.size)throw Error('Existing routed sessions; no replacement');await new Promise((resolve,reject)=>old.server.close(error=>error?reject(error):resolve()));registry.delete(old);}
    const share=(HELPER);
    const value=share({service:this,role:ROLE,socketPath:SOCKET,peerPath:PEER,net:process.getBuiltinModule('node:net'),fs:process.getBuiltinModule('node:fs'),createScope,randomUUID:process.getBuiltinModule('node:crypto').randomUUID,activate:false});
    registry.add(value);return {installed:true,routingEnabled:false,pid:process.pid,role:ROLE};
   }'''.replace('HELPER',helper).replace('ROLE',json.dumps(a.role)).replace('SOCKET',json.dumps('/run/user/1000/agent-herder/zcode-'+a.role+'.sock')).replace('PEER',json.dumps('/run/user/1000/agent-herder/zcode-'+other+'.sock'))
   result=call('Runtime.callFunctionOn',{'objectId':service_id,'functionDeclaration':function,'arguments':[{'objectId':scope_id}],'awaitPromise':True,'returnByValue':True})
   if result.get('exceptionDetails'):raise RuntimeError('Native service export rejected')
   value=result['result']['value'];value.update(startTicks=a.start_ticks,liveSourceSha256=hashlib.sha256(source.encode()).hexdigest())
   a.receipt.write_text(json.dumps(value));a.receipt.chmod(0o600);print(json.dumps(value),flush=True);return
  bp=call('Debugger.setBreakpoint',{'location':{'scriptId':script['scriptId'],'lineNumber':line,'columnNumber':column},'condition':condition})['breakpointId']
  deadline=time.monotonic()+20
  while time.monotonic()<deadline:
   event=next((e for e in events if e.get('method')=='Debugger.paused'),None)
   if event:events.remove(event)
   else:event=json.loads(ws.recv())
   if event.get('method')=='Debugger.paused':paused=True;frame=event['params']['callFrames'][0]['callFrameId'];break
  else:raise RuntimeError('No native read before bounded deadline')
  if a.role=='desktop':
   service="Array.from(n.values()).map(scope=>e.resolveSource(scope)).find(source=>source?.scope.kind==='local'&&source.agentService)?.agentService"
   scope='th'
  else:
   # The stdio handler is connection-scoped. Recover its existing base through
   # the native scope closure, rather than wrapping that consumer as an owner.
   fn=call('Debugger.evaluateOnCallFrame',{'callFrameId':frame,'expression':'handler.sendConversationCommandV4','returnByValue':False})['result']['objectId']
   properties=call('Runtime.getProperties',{'objectId':fn,'ownProperties':True})
   scopes=next(x['value']['objectId'] for x in properties.get('internalProperties',[]) if x['name']=='[[Scopes]]')
   base=None
   for entry in call('Runtime.getProperties',{'objectId':scopes,'ownProperties':True})['result']:
    identity=entry.get('value',{}).get('objectId')
    if not identity:continue
    for field in call('Runtime.getProperties',{'objectId':identity,'ownProperties':True})['result']:
     if field['name']=='base':base=field['value']['objectId'];break
    if base:break
   if not base:raise RuntimeError('Native connection scope base unavailable')
   call('Runtime.callFunctionOn',{'objectId':base,'functionDeclaration':'function(){globalThis.__herderSharedActivationBase=this;}'} )
   service='globalThis.__herderSharedActivationBase';scope='createZCodeAgentConnectionScope'
  expression='''(()=>{
   if(globalThis.__herderSharedNativeV1?.size)throw Error('Native bridge already installed; receipt-only');
   const service=SERVICE;
   if(typeof service?.readSession!=='function'||typeof service?.createSession!=='function')throw Error('Native service scope mismatch');
   const share=(HELPER);
   const value=share({service,role:ROLE,socketPath:SOCKET,peerPath:PEER,net:process.getBuiltinModule('node:net'),fs:process.getBuiltinModule('node:fs'),createScope:SCOPE,randomUUID:process.getBuiltinModule('node:crypto').randomUUID,activate:false});
   globalThis.__herderSharedNativeV1=new Set([value]);delete globalThis.__herderSharedActivationBase;
   return {installed:true,routingEnabled:false,pid:process.pid,role:ROLE};
  })()'''.replace('SERVICE',service).replace('HELPER',helper).replace('SCOPE',scope)
  role=a.role;other='desktop' if role=='herder' else 'herder'
  expression=expression.replace('ROLE',json.dumps(role)).replace('SOCKET',json.dumps('/run/user/1000/agent-herder/zcode-'+role+'.sock')).replace('PEER',json.dumps('/run/user/1000/agent-herder/zcode-'+other+'.sock'))
  result=call('Debugger.evaluateOnCallFrame',{'callFrameId':frame,'expression':expression,'returnByValue':True})
  if result.get('exceptionDetails'):raise RuntimeError('Native bridge activation rejected: '+str(result['exceptionDetails'].get('exception',{}).get('description',''))[:300])
  value=result['result']['value'];value.update(startTicks=a.start_ticks,liveSourceSha256=hashlib.sha256(source.encode()).hexdigest())
  a.receipt.write_text(json.dumps(value));a.receipt.chmod(0o600);print(json.dumps(value),flush=True)
 finally:
  if ws:
   if bp:
    try:call('Debugger.removeBreakpoint',{'breakpointId':bp})
    except Exception:pass
   if paused:
    try:call('Debugger.resume')
    except Exception:pass
   try:call('Debugger.disable')
   except Exception:pass
   try:ws.send(json.dumps({'id':999999,'method':'Runtime.evaluate','params':{'expression':"setTimeout(()=>process.getBuiltinModule('node:inspector').close(),100);undefined"}}))
   except Exception:pass
   ws.close()

if __name__=='__main__':main()
