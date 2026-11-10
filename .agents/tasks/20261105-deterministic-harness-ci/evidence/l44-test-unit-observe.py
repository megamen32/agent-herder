import importlib.util,json,os,socket,subprocess,sys
from pathlib import Path
stage=Path('/tmp/herder-l42-search-U2ePQ0');scripts=stage/'scripts'
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);return mod
boundary=load('boundary',scripts/'codex-unix-boundary.py'); inspector=load('inspector',scripts/'inspect-installed-herder.py'); tx=load('transaction',scripts/'codex-unix-transaction.py')
unit=sys.argv[1];candidate=stage/'candidate';port=23917
if [line.split(':',1)[0].strip() for line in Path('/proc/net/dev').read_text().splitlines()[2:] if ':' in line]!=['lo']:raise RuntimeError('network not isolated')
s=socket.socket();s.settimeout(.5);rc=s.connect_ex(('192.168.2.5',22));s.close()
if rc==0:raise RuntimeError('production network reachable')
before=boundary.inspect_unit_listener(inspector,unit,port,candidate/'dist')
generation={key:before[key] for key in ('pid','starttime','port','entrypoint','unitProcessChain')}
contract={'fence':7,'run':'a'*32,'hostId':'test-host','unit':unit,'candidateSha':'b'*40,'descriptorDigest':'c'*64}
policy={'hostId':'test-host','unit':unit,'descriptorDigest':'c'*64,'required_harnesses':['codex','fast-agent']}
evidence={'candidateSha':'b'*40,'report_sha256':'d'*64,'artifact_sha256':before['artifact_sha256'],'full_artifact_sha256':'f'*64,'harnesses':['codex','fast-agent']}
binding=tx.prepare_binding(contract,policy,evidence,generation);tx.check_observation(binding,contract,generation)
after=boundary.inspect_unit_listener(inspector,unit,port,candidate/'dist');inspector.verify_unchanged(before,after);tx.check_observation(binding,contract,{key:after[key] for key in generation})
print(json.dumps({'scope':'isolated-unit-binding-experiment','unit':unit,'before':before,'after':after,'binding':binding,'lanConnectErrno':rc,'limitations':['synthetic transaction and unauthenticated CI fields','no peer, sessions or consumer executed','not a production or full release proof']}))
