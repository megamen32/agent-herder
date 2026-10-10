"""Mac watchdog fast unit: expected2s/max20s; budget, fail-closed and ownership regressions.
No Darwin runtime, native actor, browser, daemon or credential operation is performed.
"""
import importlib.util
from pathlib import Path
import plistlib
import hashlib
import json
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('mac_watchdog', ROOT / 'deploy/fleet/mac-node-watchdog.py')
w = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(w)

class MacWatchdogTests(unittest.TestCase):
    def sample(self, **changes):
        value = dict(rss_kib=200*1024, processes=2, threads=12, cpu_percent=50,
                     sustained_cpu_percent=50, temp_bytes=0, state_bytes=0,
                     artifact_bytes=0, releases=2, host_available_kib=5*1024*1024,
                     disk_free_bytes=3*1024**3)
        value.update(changes)
        return value

    def test_budget_thresholds_and_cpu_startup(self):
        p = w.Policy('Macmini6,2')
        for field, value, reason in [('rss_kib',512*1024+1,'memory_hard'),
                ('threads',129,'threads'),('processes',17,'processes'),
                ('temp_bytes',128*1024**2+1,'temp'),('state_bytes',64*1024**2+1,'state'),
                ('artifact_bytes',512*1024**2+1,'artifact'),('releases',3,'releases'),
                ('disk_free_bytes',2*1024**3-1,'host_disk')]:
            self.assertIn(reason, w.violations(self.sample(**{field:value}), p, 1))
        high = self.sample(cpu_percent=151, sustained_cpu_percent=101)
        self.assertNotIn('cpu_instantaneous',w.violations(high,p,10))
        self.assertIn('cpu_instantaneous',w.violations(high,p,11))
        self.assertIn('cpu_sustained',w.violations(high,p,11))
        self.assertFalse(w.violations(self.sample(),p,30))

    def test_host_specific_reserves_and_soft_window(self):
        self.assertFalse(w.violations(self.sample(host_available_kib=3*1024**2),w.Policy('Macmini6,2'),30))
        self.assertIn('host_memory',w.violations(self.sample(host_available_kib=3*1024**2),w.Policy('MacBookPro18,2'),30))
        self.assertEqual(w.soft_memory_anchor(270*1024,0,None),0)
        self.assertEqual(w.soft_memory_anchor(280*1024,20,0),0)
        self.assertIsNone(w.soft_memory_anchor(200*1024,21,0))
        self.assertNotIn('memory_soft_sustained',w.violations(self.sample(rss_kib=270*1024),w.Policy('Macmini6,2'),29,0))
        self.assertIn('memory_soft_sustained',w.violations(self.sample(rss_kib=270*1024),w.Policy('Macmini6,2'),30,0))

    def test_cpu_and_darwin_process_thread_projection(self):
        rows=w.parse_processes('42 42 501 1024 00:01.50 Sat Oct 10 10:00:00 2026\n99 99 501 900 1:00 Sat Oct 10 10:00:00 2026\n43 42 501 512 00:00.50 Sat Oct 10 10:00:01 2026\n',42,501)
        self.assertEqual([r['pid'] for r in rows],[42,43])
        self.assertEqual(sum(r['rss_kib'] for r in rows),1536)
        self.assertEqual(w.cpu_percent({42:1},{42:1.5,43:0.5},1),100)
        self.assertEqual(w.rolling_cpu([(0,10,120),(10,20,80)],20),100)
        self.assertEqual(w.cpu_seconds('1-00:00:01'),86401)
        with patch.object(w,'command',return_value='42\n42\n43\n') as call:
            self.assertEqual(w.read_threads(rows),3)
            self.assertEqual(call.call_args.args[0],['/bin/ps','-M','-p','42,43','-o','pid='])
        with self.assertRaises(w.Refused):w.parse_processes('42 42 999 1024 00:01 Sat Oct 10 10:00:00 2026\n',42,501)

    def test_storage_does_not_follow_foreign_links_and_is_bounded(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);owned=base/'owned';owned.mkdir();foreign=base/'foreign';foreign.mkdir();(foreign/'data').write_bytes(b'x'*1024)
            (owned/'small').write_bytes(b'123');(owned/'foreign').symlink_to(foreign,target_is_directory=True)
            self.assertLess(w.storage_bytes(owned,100),100)
            with self.assertRaisesRegex(w.Refused,'storage_root_unverified'):w.storage_bytes(owned/'foreign',2000)
            with self.assertRaises(w.Refused):w.storage_bytes(owned,1)

    def test_missing_codex_socket_has_no_spawn_or_guessed_daemon(self):
        with patch.object(w.subprocess,'Popen') as spawn:
            with self.assertRaisesRegex(w.Refused,'managed_codex_socket_missing'):
                w.codex_environment({'codexSocket':'/nonexistent/owned/managed.sock','codexBin':'/nonexistent/codex'})
            spawn.assert_not_called()

    def test_join_requires_pinned_native_owner_not_a_same_uid_forward(self):
        import socket
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);pointer=home/'.codex/app-server-control/app-server-control.sock';pointer.parent.mkdir(parents=True)
            binary=home/'codex';binary.write_bytes(b'fixture');binary.chmod(0o700)
            config={'codexSocket':str(pointer),'codexBin':str(binary),'codexOwnerPid':42,'codexOwnerBin':str(binary),'codexOwnerStartedAt':'Sat Oct 10 10:00:00 2026'}
            with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as server:
                server.bind(str(pointer));pointer.chmod(0o600);server.listen(3)
                def observation(args):
                    if args[0]=='/usr/sbin/lsof':
                        self.assertIn('-a',args);return '42\n'
                    return f'{w.os.getuid()} Sat Oct 10 10:00:00 2026 /usr/bin/ssh -L remote\n'
                with patch.object(w.Path,'home',return_value=home),patch.object(w,'command',side_effect=observation):
                    with self.assertRaisesRegex(w.Refused,'managed_codex_owner_unverified'):w.codex_environment(config)
                def native(args):
                    if args[0]=='/usr/sbin/lsof':
                        self.assertIn('-a',args);return '42\n'
                    return f'{w.os.getuid()} Sat Oct 10 10:00:00 2026 {binary} app-server --listen unix://{pointer}\n'
                with patch.object(w.Path,'home',return_value=home),patch.object(w,'command',side_effect=native):
                    self.assertEqual(w.codex_environment(config)['CODEX_APP_SERVER_SOCKET'],str(pointer))
                    config['codexOwnerStartedAt']='different generation'
                    with self.assertRaisesRegex(w.Refused,'managed_codex_owner_unverified'):w.codex_environment(config)

    def test_opencode_requires_protected_existing_pointer_and_native_listener(self):
        with self.assertRaisesRegex(w.Refused,'opencode_auth_pointer_missing'):
            w.opencode_environment({'opencodePort':4097,'opencodePid':123})
        with tempfile.TemporaryDirectory() as folder:
            pointer=Path(folder)/'native.env';pointer.write_text('OPENCODE_SERVER_PASSWORD="test fixture"\nOPENCODE_SERVER_USERNAME=opencode\n');pointer.chmod(0o600)
            def native(args):
                if args[0]=='/bin/ps':return f'{w.os.getuid()} /usr/local/bin/opencode serve --port 4097\n'
                return '123\n'
            with patch.object(w,'command',side_effect=native):
                env=w.opencode_environment({'opencodePort':4097,'opencodePid':123,'opencodeEnvFile':str(pointer)})
                self.assertEqual(env['OPENCODE_URL'],'http://127.0.0.1:4097')
                self.assertEqual(env['OPENCODE_SERVER_PASSWORD'],'test fixture')
            pointer.chmod(0o644)
            with self.assertRaisesRegex(w.Refused,'protected_pointer_permissions'):
                w.protected_env(pointer)

    def test_cleanup_never_signals_foreign_or_reused_group(self):
        child=unittest.mock.Mock(pid=42);child.poll.return_value=None
        with patch.object(w.os,'getpgid',return_value=99),patch.object(w.os,'killpg') as kill:
            with self.assertRaisesRegex(w.Refused,'owned_group_identity_lost'):w.stop_owned(child,[])
            kill.assert_not_called()
        child.poll.return_value=0
        saved={'pid':43,'pgid':42,'uid':501,'identity':'old'}
        with patch.object(w,'read_processes',return_value=[{**saved,'identity':'reused'}]),patch.object(w.os,'kill') as kill:
            with self.assertRaisesRegex(w.Refused,'owned_group_identity_lost'):w.stop_owned(child,[saved])
            kill.assert_not_called()

    def test_corrupt_m1_plist_and_unrendered_template_fail_before_native_launch(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'node.plist'
            for raw in (b'["Linux unit is not a plist"]',b'<plist>broken', (ROOT/'deploy/fleet/mac-node.plist.in').read_bytes()):
                path.write_bytes(raw)
                with patch.object(w,'command') as native,patch.object(w.subprocess,'Popen') as spawn:
                    with self.assertRaises(w.Refused):w.validate_launchagent(path)
                    native.assert_not_called();spawn.assert_not_called()
            raw=(ROOT/'deploy/fleet/mac-node.plist.in').read_text().replace('__HOME__','/Users/fixture').replace('__PYTHON_BIN__','/usr/bin/python3')
            path.write_text(raw)
            with patch.object(w,'command',return_value='node.plist: OK') as native:
                self.assertFalse(w.validate_launchagent(path)['KeepAlive'])
                native.assert_called_once_with(['/usr/bin/plutil','-lint',str(path)])

    def test_manifest_exact_source_and_artifact_fences(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);dist=base/'releases'/'one'/'dist';dist.mkdir(parents=True);(base/'current').symlink_to(dist.parent)
            entry=dist/'index.js';entry.write_bytes(b'owned published artifact')
            manifest={'source_sha':'a'*40,'source_dirty':False,'payload':{'index.js':hashlib.sha256(entry.read_bytes()).hexdigest()}}
            path=dist/'fleet-deployment-manifest.json';path.write_text(json.dumps(manifest))
            self.assertEqual(w.verify_manifest(base,'a'*40),entry)
            with self.assertRaisesRegex(w.Refused,'source_identity_mismatch'):w.verify_manifest(base,'b'*40)
            manifest['source_dirty']=True;path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(w.Refused,'source_identity_mismatch'):w.verify_manifest(base,'a'*40)
            manifest['source_dirty']=False;path.write_text(json.dumps(manifest));entry.write_bytes(b'drift')
            with self.assertRaisesRegex(w.Refused,'artifact_identity_mismatch'):w.verify_manifest(base,'a'*40)

    def test_payload_closure_and_installed_wrapper_drift_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);dist=base/'releases'/'one'/'dist';dist.mkdir(parents=True);(base/'current').symlink_to(dist.parent)
            (dist/'index.js').write_bytes(b'entry');(dist/'module.js').write_bytes(b'imported module')
            payload={name:hashlib.sha256((dist/name).read_bytes()).hexdigest() for name in ('index.js','module.js')}
            manifest={'source_sha':'a'*40,'source_dirty':False,'payload':payload}
            path=dist/'fleet-deployment-manifest.json';path.write_text(json.dumps(manifest))
            w.verify_manifest(base,'a'*40);(dist/'module.js').write_bytes(b'old neighboring module')
            with self.assertRaisesRegex(w.Refused,'artifact_identity_mismatch'):w.verify_manifest(base,'a'*40)
            manifest['payload']={'../outside.js':'a'*64,'index.js':payload['index.js']};path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(w.Refused,'artifact_manifest_invalid'):w.verify_manifest(base,'a'*40)
            wrapper=base/'mac-node-watchdog.py';wrapper.write_bytes(b'published wrapper');config={'launcherHashes':{'mac-node-watchdog.py':hashlib.sha256(wrapper.read_bytes()).hexdigest()}}
            w.verify_launcher_hashes(base,config,['mac-node-watchdog.py']);wrapper.write_bytes(b'drift')
            with self.assertRaisesRegex(w.Refused,'launcher_identity_mismatch'):w.verify_launcher_hashes(base,config,['mac-node-watchdog.py'])

    def test_cleanup_has_one_ten_second_deadline_not_per_member_waits(self):
        child=unittest.mock.Mock(pid=42);child.poll.return_value=0;clock={'now':0.0}
        rows=[{'pid':42+i,'pgid':42,'uid':w.os.getuid(),'identity':'owned'} for i in range(16)]
        def observe(_group,deadline=None):clock['now']+=2;return rows
        with patch.object(w.time,'monotonic',side_effect=lambda:clock['now']),patch.object(w,'read_processes',side_effect=observe),patch.object(w.os,'kill') as kill:
            with self.assertRaisesRegex(w.Refused,'owned_cleanup_deadline'):w.stop_owned(child,rows)
            self.assertLessEqual(clock['now'],10);self.assertLess(kill.call_count,16)

    def test_launchagent_has_no_restart_loop_or_user_wide_limits(self):
        text=(ROOT/'deploy/fleet/mac-node.plist.in').read_text().replace('__HOME__','/Users/fixture').replace('__PYTHON_BIN__','/usr/bin/python3')
        value=plistlib.loads(text.encode())
        self.assertTrue(value['RunAtLoad']);self.assertFalse(value['KeepAlive']);self.assertEqual(value['ProcessType'],'Background')
        self.assertNotIn('NumberOfProcesses',str(value));self.assertNotIn('ResidentSetSize',str(value));self.assertNotIn('MemorySwapMax',str(value))
        self.assertIn('mac-node-watchdog.py',str(value['ProgramArguments']))

if __name__=='__main__':unittest.main()
