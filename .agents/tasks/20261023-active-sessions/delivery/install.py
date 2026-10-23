import argparse,os,json,shutil,hashlib,subprocess,time,socket
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--fleet',required=True);p.add_argument('--expected',required=True);p.add_argument('--owner100',action='store_true');p.add_argument('--activate',action='store_true');p.add_argument('--prepare-from');a=p.parse_args()
fleet=Path(a.fleet).expanduser();packet=Path(__file__).resolve().parent;patch=json.loads((packet/'patch.json').read_text());sha=patch['patchSourceSha'];current=fleet/'current';base=Path(a.prepare_from).resolve(strict=True) if a.prepare_from else current.resolve(strict=True)
assert not(a.prepare_from and a.activate),'prepare_only_base_override'
assert base.name==a.expected,('current_changed',base.name)
configpath=fleet/'node-config.json';configraw=configpath.read_bytes();config=json.loads(configraw);assert a.prepare_from or config['sourceSha']==a.expected,('config_changed',config['sourceSha'])
node=config.get('nodeBin','/usr/local/bin/node');assert shutil.disk_usage(fleet).free>2*1024**3,'disk_reserve'
settings=Path.home()/'.local/state/agent-herder';protected=[settings/'settings'/n for n in ['profiles.json','projects.json','secrets.json']]
hashfile=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
before={str(f):hashfile(f) for f in protected if f.is_file()}
release=fleet/'releases'/sha
if not release.exists():shutil.copytree(base,release,copy_function=os.link,symlinks=True)
else:
 info=release/'active-patch-manifest.json';assert info.exists() and json.loads(info.read_text())['patchSourceSha']==sha,'candidate_not_owned'
def write_owned(path,data):
 if path.exists() or path.is_symlink():path.unlink()
 path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
for path in (packet/'overlay').rglob('*.js'):write_owned(release/'dist'/path.relative_to(packet/'overlay'),path.read_bytes())
for item in patch['replacements']:
 path=release/'dist'/item['path'];data=path.read_text()
 assert data.count(item['before'])==1,('owned_patch_anchor',item['path'],item['before'][:100])
 write_owned(path,data.replace(item['before'],item['after'],1).encode())
oldmanifest=json.loads((base/'dist/fleet-deployment-manifest.json').read_text());payload={str(f.relative_to(release/'dist')):hashfile(f) for f in sorted((release/'dist').rglob('*')) if f.is_file() and not f.is_symlink() and f.name!='fleet-deployment-manifest.json'}
manifest={**oldmanifest,'source_sha':sha,'source_dirty':False,'input_kind':'immutable-host-baseline-plus-owned-committed-delta','base_source_sha':a.expected,'patch_source_sha':sha,'patch_source_blobs':patch['sourceGitBlobs'],'payload':payload};manifest.pop('source_pins',None)
write_owned(release/'dist/fleet-deployment-manifest.json',(json.dumps(manifest,indent=2)+'\n').encode())
receipt={**patch,'baseRelease':str(base),'baseSourceSha':a.expected,'builtAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'preservedBaselineWebSha':hashfile(base/'dist/web/server.js'),'payloadSha256':hashfile(release/'dist/fleet-deployment-manifest.json'),'protectedSettingsBefore':before}
write_owned(release/'active-patch-manifest.json',(json.dumps(receipt,indent=2)+'\n').encode())
for file in ['index.js','web/server.js',*[(file+'.js') for file in patch['files']]]:subprocess.run([node,'--check',str(release/'dist'/file)],check=True,capture_output=True)
subprocess.run([node,'--input-type=module','-e',"await import("+json.dumps((release/'dist/index.js').as_uri())+")"],check=True,capture_output=True,timeout=30)
assert before=={str(f):hashfile(f) for f in protected if f.is_file()},'settings_changed_during_prepare'
print(json.dumps({'state':'prepared','host':socket.gethostname(),'base':a.expected,'candidate':sha,'files':len(payload),'settingsPreserved':True}),flush=True)
if not a.activate:raise SystemExit(0)
# Compare-and-swap preconditions immediately before switching config + symlink.
assert current.resolve().name==a.expected and configpath.read_bytes()==configraw,'activation_state_changed'
rollback=fleet/'rollback'/('before-active-'+sha[:8]);rollback.mkdir(parents=True,exist_ok=True)
shutil.copy2(configpath,rollback/'node-config.json')
if a.owner100:
 dropin=Path.home()/'.config/systemd/user/agent-herder.service.d/10-release-exec.conf';shutil.copy2(dropin,rollback/'10-release-exec.conf')
 write_owned(dropin,('[Service]\nExecStart=\nExecStart='+node+' '+str(release/'dist/index.js')+'\n').encode())
config['sourceSha']=sha;tmp=configpath.with_suffix('.active-new');tmp.write_text(json.dumps(config,indent=1)+'\n');tmp.chmod(0o600);os.replace(tmp,configpath)
link=fleet/'.current-active-new';os.symlink(str(release),link);os.replace(link,current)
if os.uname().sysname=='Darwin':
 label='com.bezrabotnyi.agent-herder-fleet-node';subprocess.run(['launchctl','kickstart','-k','user/'+str(os.getuid())+'/'+label],check=True)
else:
 unit='agent-herder.service' if a.owner100 else 'agent-herder-fleet.service';subprocess.run(['systemctl','--user','daemon-reload'],check=True);subprocess.run(['systemctl','--user','restart',unit],check=True)
print(json.dumps({'state':'switched','host':socket.gethostname(),'candidate':sha,'rollback':str(rollback)}),flush=True)
