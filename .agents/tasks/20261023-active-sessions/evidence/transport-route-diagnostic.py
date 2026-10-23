import subprocess,time,json,shlex,concurrent.futures,os
hosts=[('100',None,18787,'roomhacker-server-100','python3'),('44',['ssh','-T','-o','BatchMode=yes','-o','ConnectTimeout=3','roomhacker@192.168.2.5'],18791,'server-44','python3'),('88',['ssh','-T','-o','BatchMode=yes','-o','ConnectTimeout=3','roomhacker@192.168.2.75'],18791,'roomhacker-server-88','python3'),('M1',['ssh','-T','-o','BatchMode=yes','-o','ConnectTimeout=3','-p','2222','user@127.0.0.1'],18789,'MacBook-Pro-User.local','/opt/homebrew/bin/python3'),('Mini',['ssh','-T','-o','BatchMode=yes','-o','ConnectTimeout=3','roomhacker@192.168.2.4'],18789,'mac-mini-2012.lan','/usr/local/bin/python3')]
def probe(host):
 name,ssh,port,hostId,py=host;code="import time,json,urllib.request,os;t=time.monotonic();r=urllib.request.urlopen("+repr('http://127.0.0.1:'+str(port)+'/api/sessions/active?runtimeHostId='+hostId)+",timeout=5);b=r.read(1048577);x=json.loads(b);print(json.dumps({'httpMs':round((time.monotonic()-t)*1000,2),'bytes':len(b),'ownerPid':x['hosts'][0].get('ownerPid'),'active':x['activeCount'],'unknown':x['unknownActivityCount'],'observedAt':x['hosts'][0]['observedAt'],'load':os.getloadavg()}))";t=time.monotonic()
 try:
  cmd=ssh+[py+' -I -S -B -c '+shlex.quote(code)]if ssh else [py,'-I','-S','-B','-c',code];r=subprocess.run(cmd,capture_output=True,timeout=9);total=round((time.monotonic()-t)*1000,2)
  if r.returncode:return {'host':name,'totalMs':total,'error':'remote_read_failed','exit':r.returncode}
  x=json.loads(r.stdout);return {'host':name,'totalMs':total,'bootstrapMs':round(total-x['httpMs'],2),**x}
 except Exception as e:return {'host':name,'totalMs':round((time.monotonic()-t)*1000,2),'error':type(e).__name__}
out=[]
for i in range(3):
 with concurrent.futures.ThreadPoolExecutor(5)as pool:out.append({'cycle':i,'at':time.time(),'hosts':list(pool.map(probe,hosts))})
print(json.dumps(out,indent=2))
