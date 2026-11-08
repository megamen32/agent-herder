import hashlib,json,os,signal,sqlite3,subprocess,sys,time
from pathlib import Path
NATIVE=Path('/home/roomhacker/.codex/worktrees/herder-final-acceptance/agent-herder/tests/native')
sys.path.insert(0,str(NATIVE))
from ahap_opencode_stand import RpcProcess,rpc_tool,persist_evidence
from v1_zcode_stand import validate_manifest
from launch import sandbox_command
ROOT=Path('/home/roomhacker/herder-artifacts/ci-runs/zcode-82b91db9-archive-ede4cb8ab457')
RELEASE=Path('/home/roomhacker/herder-artifacts/releases/herder-v1-c5a84dec-archivefill')
SHA='bcdd172d52d7728f6bb9fa3ce225d873c08056e5d98fd7c11bfcbbb5dc399937'
RUNTIME=Path('/tmp/herder-zcode-v1-runtime-recovered-6ad71fab/runtime')
SESSION='session:f7c76a9a837f13ef424b7629045ace8f'
NATIVE_ID='sess_e06e622c-7d06-4e15-a168-5da6bfb93fa4'
PROFILE='zcode-c5a-profile.json'
if len(sys.argv)==1:
    parent=os.stat('/proc/self/ns/net')
    raise SystemExit(subprocess.call(['unshare','--user','--map-root-user','--net','--',sys.executable,__file__,'--net',str(parent.st_ino)]))
if sys.argv[1]=='--net':
    assert str(os.stat('/proc/self/ns/net').st_ino)!=sys.argv[2]
    assert all(x['ifname']=='lo' for x in json.loads(subprocess.check_output(['ip','-j','link','show'])))
    assert not json.loads(subprocess.check_output(['ip','-j','-4','route','show']))
    assert not json.loads(subprocess.check_output(['ip','-j','-6','route','show']))
    subprocess.run(['ip','link','set','lo','up'],check=True)
    env={'HOME':'/herder-owner-home/supervisor','PATH':os.defpath,'XDG_CONFIG_HOME':'/herder-owner-home/config','XDG_CACHE_HOME':'/herder-owner-home/cache','XDG_DATA_HOME':'/herder-owner-home/data','XDG_STATE_HOME':'/herder-owner-home/state','TMPDIR':'/herder-owner-home/tmp'}
    command=sandbox_command([sys.executable,str(Path(__file__).resolve()),'--inside'],str(ROOT),[RELEASE,RUNTIME.parent,Path(__file__).resolve()])
    raise SystemExit(subprocess.call(command,env=env))
manifest=validate_manifest(RELEASE/'manifest.json',SHA)
protected=Path('/herder-owner-home'); home=protected/'supervisor'; project=protected/'work'
old=json.loads((protected/'zcode-v1-receipt.json').read_text())
assert old['session_ref']==SESSION
assert old['archive']['structuredContent']=={'code':'unsupported_archive','effect':'none'}
assert not (protected/'zcode-c5a-retained-receipt.json').exists(),'existing accepted/UNKNOWN attempt must not replay'
profile=json.loads((protected/'authority/zcode-profile.json').read_text())
assert profile['owner']['instance']==old['instance']
profile['owner']['executable']=manifest['node'];profile['owner']['ahap_script']=manifest['adapters']['zcode']
profile_path=protected/'authority'/PROFILE
with os.fdopen(os.open(profile_path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as f:json.dump(profile,f)
with sqlite3.connect((protected/'authority/state.db').as_uri()+'?mode=ro',uri=True) as db:
    assert db.execute('select native_session_id from session_bindings where session_ref=?',(SESSION,)).fetchone()==(NATIVE_ID,)
native_db=home/'.zcode/cli/db/db.sqlite'
def messages():
    with sqlite3.connect(native_db.as_uri()+'?mode=ro',uri=True) as db:
        return db.execute('select id,data,sequence from message where session_id=? order by sequence',(NATIVE_ID,)).fetchall()
before=messages()
receipt={'status':'UNKNOWN','phase':'before_start','manifest_sha256':SHA,'session_ref':SESSION,'native_session_id':NATIVE_ID,'instance':old['instance'],'network':'isolated namespace, loopback only, no model server','model_sends':0,'previous_archive':old['archive'],'archive_key':old['archive_key'],'profile':str(profile_path)}
receipt_path=protected/'zcode-c5a-retained-receipt.json';persist_evidence(receipt_path,receipt)
server_root=home/'.zcode/server';node=RUNTIME/'node';entry=home/'official-runtime/zcode.cjs'
env=dict(os.environ,HOME=str(home),ZCODE_DATA_BASE_DIR=str(home),ZCODE_SERVER_ROOT=str(server_root),ZCODE_SERVER_SKIP_SERVICE_REGISTRATION='1',ZCODE_SERVER_RUNTIME_ROOT=str(RUNTIME),ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=str(entry.parent/'provider/zcode-builtin.json'),ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=str(home/'.zcode/v2/provider_config.json'),ZCODE_AGENT_SERVER_COMMAND=str(node),ZCODE_AGENT_SERVER_ARGS_JSON=json.dumps([str(entry),'app-server','--stdio']))
client=None
with (protected/'zcode-c5a-supervisor.log').open('x') as log:
    server=subprocess.Popen([str(node),str(RUNTIME/'server-cli.js'),'serve','--server-root',str(server_root),'--json'],cwd=project,env=env,stdout=log,stderr=log,start_new_session=True)
    try:
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            if server.poll() is not None:raise RuntimeError('isolated supervisor exited')
            try:
                status=json.loads((server_root/'run/status.json').read_text())
                if status.get('state')=='ready' and (server_root/'run/control.sock').is_socket():break
            except (OSError,ValueError):pass
            time.sleep(.1)
        else:raise RuntimeError('isolated supervisor readiness timeout')
        client=RpcProcess(manifest['core'],profile_path,dict(os.environ));client.preflight()
        read=rpc_tool(client,'session',{'action':'messages','session_ref':SESSION})
        assert not read.get('isError')
        receipt.update(phase='before_archive',readback=read);persist_evidence(receipt_path,receipt)
        reply=rpc_tool(client,'session',{'action':'archive','session_ref':SESSION,'request_key':old['archive_key']})
        receipt['archive']=reply;persist_evidence(receipt_path,receipt)
        body=reply.get('structuredContent',{})
        assert not reply.get('isError') and body.get('archived') is True and body.get('effect')=='confirmed' and body.get('session_ref')==SESSION,'archive not confirmed; no replay'
        index=home/'.zcode/v2/tasks-index.sqlite'
        with sqlite3.connect(index.as_uri()+'?mode=ro',uri=True) as db:
            rows=db.execute('select task_id,workspace_path,workspace_identity,archived,deleted from tasks where task_id=?',(NATIVE_ID,)).fetchall()
        assert len(rows)==1 and rows[0][1]=='/herder-owner-home/work' and rows[0][3:]==(1,0),rows
        assert messages()==before,'native history changed'
        receipt.update(status='PASS',phase='complete',native_index_rows=rows,native_messages_unchanged=True,native_message_count=len(before));persist_evidence(receipt_path,receipt)
    except Exception as error:
        receipt.update(error=str(error));persist_evidence(receipt_path,receipt);raise
    finally:
        if client:client.close()
        try:os.killpg(server.pid,signal.SIGTERM)
        except ProcessLookupError:pass
        try:server.wait(timeout=5)
        except subprocess.TimeoutExpired:os.killpg(server.pid,signal.SIGKILL);server.wait()
print(json.dumps(receipt),flush=True)
