import json, os, select, subprocess, time
from pathlib import Path

root=Path(__file__).resolve().parent
binary=root.parent/'v003-followup/codex-app-server-x86_64-unknown-linux-musl'
env={'PATH':'/usr/bin:/bin','HOME':str(root/'home'),'CODEX_HOME':str(root/'codex-home'),'TMPDIR':str(root/'tmp'),'LANG':'C.UTF-8','NO_PROXY':'localhost,127.0.0.1'}
p=subprocess.Popen([str(binary),'--session-source','vscode'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(root/'app-server.stderr','w'),env=env,cwd=root/'project',bufsize=0)
log=open(root/'app-transcript.jsonl','w',buffering=1)
buffer=b''
def send(obj):
    log.write(json.dumps({'direction':'driver_to_app','message':obj},ensure_ascii=False)+'\n')
    p.stdin.write((json.dumps(obj)+'\n').encode())
def response(rid, timeout=35):
    global buffer
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        while b'\n' in buffer:
            line,buffer=buffer.split(b'\n',1)
            if not line: continue
            obj=json.loads(line)
            log.write(json.dumps({'direction':'app_to_driver','message':obj},ensure_ascii=False)+'\n')
            if obj.get('id')==rid: return obj
        if select.select([p.stdout],[],[],max(0,end-time.monotonic()))[0]:
            chunk=os.read(p.stdout.fileno(),65536)
            if not chunk: raise RuntimeError('app-server closed')
            buffer+=chunk
    raise TimeoutError(f'RPC {rid}')
try:
    send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'v003-isolated-driver','version':'1'},'capabilities':{'experimentalApi':True}}})
    print('initialize',response(1))
    send({'method':'initialized','params':{}})
    send({'id':8,'method':'experimentalFeature/list','params':{}})
    print('features',response(8))
    send({'id':2,'method':'thread/start','params':{'cwd':str(root/'project'),'modelProvider':'fixture','model':'unused'}})
    thread=response(2)
    print('thread/start',thread)
    send({'id':3,'method':'mcpServerStatus/list','params':{}})
    print('mcpServerStatus/list',response(3))
    send({'id':5,'method':'mcpServer/tool/call','params':{'threadId':thread['result']['thread']['id'],'server':'herder_probe','tool':'probe_count','arguments':{}}})
    print('count before',response(5))
    send({'id':4,'method':'mcpServer/tool/call','params':{'threadId':thread['result']['thread']['id'],'server':'herder_probe','tool':'probe_task','arguments':{}}})
    print('mcpServer/tool/call',response(4))
    send({'id':6,'method':'mcpServer/tool/call','params':{'threadId':thread['result']['thread']['id'],'server':'herder_probe','tool':'probe_count','arguments':{}}})
    print('count after',response(6))
    send({'id':7,'method':'mcpServer/resource/read','params':{'threadId':thread['result']['thread']['id'],'server':'herder_probe','uri':'skill://probe/SKILL.md'}})
    print('resource read',response(7))
finally:
    p.stdin.close()
    try: p.wait(timeout=5)
    except subprocess.TimeoutExpired: p.terminate(); p.wait(timeout=5)
    print('app_exit',p.returncode)
