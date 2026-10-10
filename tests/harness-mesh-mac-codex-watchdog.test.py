"""Native manager fast unit: expected2s/max20s; no live Darwin/native writer.
Defects detected: duplicate writer, foreign listener, stale generation, bounds.
"""
import importlib.util
from pathlib import Path
import hashlib
import plistlib
import socket
import tempfile
import unittest
from unittest.mock import patch,Mock
# All socket fixtures stay inside tempfile's admitted TMPDIR, even when long.
# AF_UNIX bind/connect use short relative names while cwd is the OWN fixture.
import contextlib
import os
import socket
@contextlib.contextmanager
def owned_unix_fixture(folder):
    original=socket.socket
    root=Path(folder).resolve();previous=os.open('.',os.O_RDONLY)
    def address(value):
        if not isinstance(value,str) or not os.path.isabs(value):return value
        target=Path(value).absolute()
        if root not in target.parents:raise AssertionError('socket escaped owned fixture')
        return os.path.relpath(target,root)
    class RelativeSocket(original):
        def bind(self,value):return super().bind(address(value))
        def connect(self,value):return super().connect(address(value))
    try:
        os.chdir(root)
        with patch.object(socket,'socket',RelativeSocket),RelativeSocket(socket.AF_UNIX,socket.SOCK_STREAM) as server:
            yield server
    finally:os.fchdir(previous);os.close(previous)

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('native',ROOT/'deploy/fleet/mac-codex-watchdog.py')
n=importlib.util.module_from_spec(spec);spec.loader.exec_module(n)

class NativeManagerTests(unittest.TestCase):
    def sample(self,**changes):
        sample=dict(rss_kib=200*1024,processes=2,threads=12,cpu_percent=50,sustained_cpu_percent=50,temp_bytes=0,state_bytes=0,artifact_bytes=0,releases=0,host_available_kib=5*1024**2,disk_free_bytes=3*1024**3)
        sample.update(changes);return sample

    def test_explicit_native_budget(self):
        for field,value,reason in [('threads',65,'threads'),('processes',17,'processes'),('rss_kib',512*1024+1,'memory_hard'),('temp_bytes',16*n.w.MIB+1,'temp'),('state_bytes',16*n.w.MIB+1,'state'),('host_available_kib',4*1024**2-1,'host_memory'),('cpu_percent',201,'cpu_instantaneous')]:
            self.assertIn(reason,n.native_violations(self.sample(**{field:value}),1))
        self.assertNotIn('cpu_sustained',n.native_violations(self.sample(sustained_cpu_percent=101),10))
        self.assertIn('cpu_sustained',n.native_violations(self.sample(sustained_cpu_percent=101),11))
        self.assertEqual(n.native_violations(self.sample(cpu_percent=200),1),[])

    def test_occupied_or_unknown_socket_is_never_unlinked_adopted_or_spawned(self):
        with tempfile.TemporaryDirectory() as folder:
            pointer=Path(folder)/'control.sock';pointer.symlink_to(Path(folder)/'missing')
            with patch.object(n.subprocess,'Popen') as spawn,patch.object(n.os,'unlink') as unlink:
                with self.assertRaisesRegex(n.w.Refused,'already_owned_or_unknown'):n.refuse_existing_socket(pointer)
                spawn.assert_not_called();unlink.assert_not_called()
            pointer.unlink()
            with owned_unix_fixture(folder) as server:
                server.bind(str(pointer));server.listen(1)
                with self.assertRaises(n.w.Refused):n.refuse_existing_socket(pointer)

    def test_exact_installed_binary_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'codex';path.write_bytes(b'fixture binary only');path.chmod(0o700)
            self.assertEqual(n.binary_identity(str(path),hashlib.sha256(path.read_bytes()).hexdigest()),path)
            with self.assertRaisesRegex(n.w.Refused,'native_binary_identity_mismatch'):n.binary_identity(str(path),'0'*64)

    def test_listener_is_not_ready_for_another_writer(self):
        with tempfile.TemporaryDirectory() as folder:
            pointer=Path(folder)/'sock'
            with owned_unix_fixture(folder) as server:
                server.bind(str(pointer));pointer.chmod(0o600);server.listen(1);child=Mock(pid=42);child.poll.return_value=None
                with patch.object(n.w,'command',return_value='99\n'):
                    with self.assertRaisesRegex(n.w.Refused,'native_listener_identity_mismatch'):n.listener_proof(pointer,child)
                with patch.object(n.w,'command',return_value='42\n'):
                    proof=n.listener_proof(pointer,child);self.assertEqual(proof['inode'],pointer.lstat().st_ino)

    def test_installed_native_rendezvous_symlink_and_generation_are_preserved(self):
        with tempfile.TemporaryDirectory() as folder:
            physical=Path(folder)/'physical.sock';pointer=Path(folder)/'control.sock'
            with owned_unix_fixture(folder) as server:
                server.bind(str(physical));physical.chmod(0o600);server.listen(2);pointer.symlink_to(physical)
                child=Mock(pid=42);child.poll.return_value=None
                with patch.object(n.w,'command',return_value='42\n'):
                    proof=n.listener_proof(pointer,child)
                n.verify_socket_generation(pointer,proof)
                pointer.unlink();pointer.write_text('foreign replacement')
                with self.assertRaisesRegex(n.w.Refused,'native_socket_generation_changed'):
                    n.verify_socket_generation(pointer,proof)

    def test_production_start_refuses_occupied_socket_under_startup_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);base=home/'.local/share/agent-herder/fleet';base.mkdir(parents=True)
            state=home/'state';temp=base/'run/tmp';pointer=home/'.codex/app-server-control/app-server-control.sock'
            pointer.parent.mkdir(mode=0o700,parents=True);pointer.write_text('unknown existing writer')
            with patch.object(n.Path,'home',return_value=home),patch.object(n.sys,'argv',['manager']),patch.object(n.w,'json_file',return_value={'hostId':'fixture','sourceSha':'a'*40}),patch.object(n,'prepare',return_value=(Path('/fixture/codex'),pointer,state,temp,{})),patch.object(n.subprocess,'Popen') as spawn:
                with self.assertRaisesRegex(n.w.Refused,'already_owned_or_unknown'):n.main()
                spawn.assert_not_called();self.assertEqual(pointer.read_text(),'unknown existing writer')

    def test_fake_owned_budget_failure_retains_generation_and_closes_readiness(self):
        with tempfile.TemporaryDirectory() as folder:
            state=Path(folder);child=Mock(pid=42);child.poll.return_value=None
            observed=[{'pid':i,'pgid':42,'uid':n.os.getuid(),'identity':'owned','rss_kib':1,'cpu_seconds':0} for i in range(17)]
            def cleanup_check(_child,_rows):
                import json
                self.assertFalse(json.loads((state/'ready.json').read_text())['ready'])
            with patch.object(n.w,'read_processes',return_value=observed),patch.object(n.w,'stop_owned',side_effect=cleanup_check) as cleanup,patch.object(n.signal,'signal'):
                self.assertEqual(n.monitor(child,state/'missing.sock',state,state,{'hostId':'fixture','sourceSha':'a'*40}),78)
                cleanup.assert_called_once_with(child,observed)
            import json
            receipt=json.loads((state/'last-run.json').read_text());ready=json.loads((state/'ready.json').read_text())
            self.assertEqual(receipt['violations'],['processes']);self.assertFalse(receipt['receiptsReplayed']);self.assertFalse(ready['ready'])
            self.assertEqual(receipt['generation'],ready['generation']);self.assertEqual(receipt['pid'],42)

    def test_production_preimport_seal_rejects_drifted_companion_without_loading(self):
        import runpy,json,io,contextlib
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);base=home/'.local/share/agent-herder/fleet';base.mkdir(parents=True)
            script=base/'mac-codex-watchdog.py';script.write_bytes((ROOT/'deploy/fleet/mac-codex-watchdog.py').read_bytes())
            companion=base/'mac-node-watchdog.py';companion.write_text('raise RuntimeError("must never execute drifted helper")')
            config={'launcherHashes':{'mac-codex-watchdog.py':hashlib.sha256(script.read_bytes()).hexdigest(),'mac-node-watchdog.py':'0'*64}}
            (base/'native-codex-config.json').write_text(json.dumps(config))
            with patch.object(n.Path,'home',return_value=home),patch.object(n.sys,'argv',[str(script)]),patch.object(n.importlib.util,'spec_from_file_location') as load,patch.object(n.subprocess,'Popen') as spawn,contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as exit_:runpy.run_path(str(script),run_name='__main__')
                self.assertEqual(exit_.exception.code,78);load.assert_not_called();spawn.assert_not_called()

    def test_launchagent_is_distinct_valid_and_no_restartloop(self):
        raw=(ROOT/'deploy/fleet/mac-codex.plist.in').read_text().replace('__HOME__','/Users/fixture').replace('__PYTHON_BIN__','/usr/bin/python3')
        value=plistlib.loads(raw.encode());self.assertEqual(value['Label'],'com.bezrabotnyi.agent-herder-native-codex');self.assertFalse(value['KeepAlive'])
        self.assertIn('mac-codex-watchdog.py',str(value['ProgramArguments']))
        self.assertNotIn('NumberOfProcesses',str(value));self.assertNotIn('ResidentSetSize',str(value))

if __name__=='__main__':unittest.main()
