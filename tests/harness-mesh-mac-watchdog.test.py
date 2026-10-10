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

# All socket fixtures stay inside tempfile's admitted TMPDIR, even when long.
# AF_UNIX bind/connect use short relative names while cwd is the OWN fixture.
import contextlib
import os
import socket
import subprocess
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

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('mac_watchdog', ROOT / 'deploy/fleet/mac-node-watchdog.py')
w = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(w)

class MacWatchdogTests(unittest.TestCase):
    def test_artifact_census_can_finish_within_its_existing_five_second_window(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'releases';root.mkdir();(root/'a').write_bytes(b'abc');(root/'b').write_bytes(b'de')
            # One complete traversal takes4s: old two2.5s passes discard it.
            clock=iter([0,0,0,0,2,4,4])
            with patch.object(w.time,'monotonic',side_effect=lambda:next(clock,6)):
                self.assertEqual(w.storage_bytes(root,10,artifact=True),5)

    def test_metadata_timeout_retries_once_without_reusing_output(self):
        ok=subprocess.CompletedProcess(['/bin/ps'],0,b'fresh\n',b'')
        with patch.object(w.subprocess,'run',side_effect=[subprocess.TimeoutExpired(['/bin/ps'],2),ok]) as run:
            self.assertEqual(w.command(['/bin/ps','-axo','pid=']),'fresh\n')
            self.assertEqual(run.call_count,2)
            self.assertTrue(all(0<call.kwargs['timeout']<=2 for call in run.call_args_list))

    def test_second_timeout_fails_with_safe_stage_and_no_raw_arguments(self):
        with patch.object(w.subprocess,'run',side_effect=subprocess.TimeoutExpired(['sensitive-argument'],2)) as run:
            with self.assertRaises(w.Refused) as error:w.command(['/usr/bin/memory_pressure','sensitive-argument'])
            self.assertEqual(run.call_count,2)
            self.assertIn('"stage":"host_memory"',str(error.exception))
            self.assertNotIn('sensitive-argument',str(error.exception))

    def test_cleanup_deadline_prevents_second_probe(self):
        with patch.object(w.time,'monotonic',side_effect=[0,0,1]),patch.object(w.subprocess,'run',side_effect=subprocess.TimeoutExpired(['/bin/ps'],.5)) as run:
            with self.assertRaises(w.Refused):w.command(['/bin/ps'],deadline=.5)
            self.assertEqual(run.call_count,1)

    def test_non_metadata_command_never_retries(self):
        with patch.object(w.subprocess,'run',side_effect=subprocess.TimeoutExpired(['/usr/bin/plutil'],2)) as run:
            with self.assertRaises(w.Refused):w.command(['/usr/bin/plutil','-lint','owned.plist'])
            self.assertEqual(run.call_count,1)

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

    def test_mac_node_bootstrap_uses_30s_observation_without_changing_node_budget(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);base=home/'fleet'
            config={'hostId':'fixture','sourceSha':'a'*40,'nodeBin':'/fixture/node','harnesses':['codex']}
            with patch.object(w.sys,'platform','darwin'),patch.object(w.Path,'home',return_value=home),patch.object(w,'command',return_value='MacBookPro18,2'),patch.object(w.socket,'gethostname',return_value='fixture'),patch.object(w,'verify_launcher_hashes'),patch.object(w,'verify_manifest',return_value=base/'index.js'),patch.object(w,'executable',return_value=Path('/fixture/node')),patch.object(w,'codex_environment',return_value={'CODEX_APP_SERVER_SOCKET':'/fixture/socket'}),patch.object(w,'release_usage',return_value=(1,1)),patch.object(w,'host_available_kib',return_value=5*1024**2),patch.object(w.shutil,'disk_usage',return_value=SimpleNamespace(free=3*w.GIB)),patch.object(w,'storage_bytes'),patch.object(w.socket,'socket'),patch.dict(w.os.environ,{'AGENT_HERDER_SESSION_OBSERVATION_INTERVAL_MS':'5000'}):
                env=w.prepare(base,config)[-1]
            self.assertEqual(env['AGENT_HERDER_SESSION_OBSERVATION_INTERVAL_MS'],'30000')
            self.assertEqual(env['CODEX_APP_SERVER_SOCKET'],'/fixture/socket')
            self.assertEqual(w.MEMORY_SOFT_KIB,256*1024);self.assertEqual(w.MEMORY_MAX_KIB,512*1024)

    def test_tcp_preflight_accepts_owned_time_wait_but_refuses_listener(self):
        # Real loopback kernel regression, no app/daemon/harness or private port.
        # Expected<1s/max3s: closed listener's TIME_WAIT must not block restart.
        with socket.socket() as server:
            server.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            server.bind(('127.0.0.1',0));port=server.getsockname()[1];server.listen(1)
            with self.assertRaises(OSError):w.probe_node_port(port)
            with socket.socket() as client:
                client.settimeout(1);client.connect(('127.0.0.1',port))
                conn,_=server.accept();conn.close();self.assertEqual(client.recv(1),b'')
        w.probe_node_port(port)

    def test_cpu_and_darwin_process_thread_projection(self):
        rows=w.parse_processes('42 42 501 1024 00:01.50 S Sat Oct 10 10:00:00 2026\n99 99 501 900 1:00 S Sat Oct 10 10:00:00 2026\n43 42 501 512 00:00.50 R Sat Oct 10 10:00:01 2026\n',42,501)
        self.assertEqual([r['pid'] for r in rows],[42,43])
        self.assertEqual(sum(r['rss_kib'] for r in rows),1536)
        self.assertEqual(w.cpu_percent({42:1},{42:1.5,43:0.5},1),100)
        self.assertEqual(w.rolling_cpu([(0,10,120),(10,20,80)],20),100)
        self.assertEqual(w.cpu_seconds('1-00:00:01'),86401)
        with patch.object(w,'command',return_value='42\n42\n43\n') as call:
            self.assertEqual(w.read_threads(rows),3)
            self.assertEqual(call.call_args.args[0],['/bin/ps','-M','-p','42,43','-o','pid='])
        with self.assertRaises(w.Refused):w.parse_processes('42 42 999 1024 00:01 S Sat Oct 10 10:00:00 2026\n',42,501)

    def test_actual_darwin_thread_table_ignoring_output_selection(self):
        table=("USER   PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND\n"
               "user 34393   ?? 0.0 S 31T 0:00.00 0:00.01 /Applic 34393\n"
               "     34393 0.0 S 31T 0:00.25 0:01.24 34393\n")
        with patch.object(w,'command',return_value=table):
            self.assertEqual(w.read_threads([{'pid':34393}]),2)
        with patch.object(w,'command',return_value=table.replace('??','ttys001')):
            self.assertEqual(w.read_threads([{'pid':34393}]),2)
        with patch.object(w,'command',return_value=table.replace('34393','99999')):
            with self.assertRaisesRegex(w.Refused,'thread_observation_invalid'):w.read_threads([{'pid':34393}])
        with patch.object(w,'command',return_value=table+'unparsed native row\n'):
            with self.assertRaisesRegex(w.Refused,'thread_observation_invalid'):w.read_threads([{'pid':34393}])
        with patch.object(w,'command',return_value='USER PID TT %CPU STAT PRI STIME UTIME COMMAND\n'):
            with self.assertRaisesRegex(w.Refused,'thread_observation_invalid'):w.read_threads([{'pid':34393}])

    def test_foreign_process_prefix_is_filtered_before_unrelated_columns(self):
        own='42 42 501 1024 00:01.50 S Sat Oct 10 10:00:00 2026\n'
        for foreign in ('99 99\n','99 99 malformed-private-path\n','99 99 bad uid rss time state start\n','0 0\n'):
            with self.subTest(foreign=foreign):
                rows=w.parse_processes(foreign+own,42,501)
                self.assertEqual([r['pid'] for r in rows],[42])
                self.assertEqual(rows[0]['identity'],'Sat Oct 10 10:00:00 2026')

    def test_actual_darwin_lstart_column_padding_preserves_generation(self):
        own='16807 16807 501 1024 00:01.50 S Sat Oct 10 05:40:28 2026'
        plain=w.parse_processes(own+'\n',16807,501)[0]
        padded=w.parse_processes(own+'    \n',16807,501)[0]
        self.assertEqual(padded,plain)
        self.assertEqual(padded['identity'],'Sat Oct 10 05:40:28 2026')
        newer=w.parse_processes(own.replace('05:40:28','05:40:29')+'    \n',16807,501)[0]
        self.assertNotEqual(padded['identity'],newer['identity'])
        with self.assertRaisesRegex(w.Refused,'owned_start'):
            w.parse_processes(own+' invalid-private-text    \n',16807,501)

    def test_owned_or_unknown_process_rows_fail_with_safe_diagnostics(self):
        cases=[('42 42','owned_shape',42,42,2),
            ('42 42 501 bad 00:01 S Sat Oct 10 10:00:00 2026','owned_numeric',42,42,11),
            ('42 42 501 1024 invalid-time S Sat Oct 10 10:00:00 2026','owned_time',42,42,11),
            ('42 42 501 1024 00:01 ? Sat Oct 10 10:00:00 2026','owned_state',42,42,11),
            ('42 42 501 1024 00:01 S private-invalid-start','owned_start',42,42,7),
            ('99 missing-private-group','unknown_prefix',99,None,2),
            ('bad-private-pid 99','unknown_prefix',None,99,2),
            ('','unknown_prefix',None,None,0)]
        for raw,rowclass,pid,pgid,count in cases:
            with self.subTest(rowclass=rowclass),self.assertRaises(w.Refused) as caught:
                w.parse_processes(raw+'\n',42,501)
            reason,details=str(caught.exception).split(' ',1)
            self.assertEqual(reason,'process_observation_invalid')
            self.assertEqual(json.loads(details),{'rowClass':rowclass,'pid':pid,'pgid':pgid,'fieldCount':count})
            self.assertNotIn('private',details)
        with self.assertRaisesRegex(w.Refused,'owned_group_identity_lost'):
            w.parse_processes('42 42 999 1024 00:01 S Sat Oct 10 10:00:00 2026\n',42,501)

    def test_thread_census_confirms_owned_child_exit_with_one_bounded_refresh(self):
        leader={'pid':42,'pgid':42,'uid':w.os.getuid(),'identity':'leader'}
        child={'pid':43,'pgid':42,'uid':w.os.getuid(),'identity':'child'}
        with patch.object(w,'command',side_effect=['42\n','42\n']),patch.object(w,'read_processes',return_value=[leader]) as refresh:
            self.assertEqual(w.read_threads([leader,child]),1);refresh.assert_called_once_with(42)
        with patch.object(w,'command',side_effect=['42\n','42\n']),patch.object(w,'read_processes',return_value=[leader,child]):
            with self.assertRaisesRegex(w.Refused,'thread_observation_invalid'):w.read_threads([leader,child])
        with patch.object(w,'command',return_value='42\n'),patch.object(w,'read_processes',return_value=[{**leader,'identity':'reused generation'}]):
            with self.assertRaisesRegex(w.Refused,'thread_observation_invalid'):w.read_threads([leader,child])
        with patch.object(w,'command',return_value='99999\n'),patch.object(w,'read_processes') as refresh:
            with self.assertRaisesRegex(w.Refused,'thread_observation_invalid'):w.read_threads([leader,child])
            refresh.assert_not_called()

    def test_owned_zombie_has_zero_threads_only_after_positive_fresh_state(self):
        leader={'pid':42,'pgid':42,'uid':w.os.getuid(),'identity':'leader','stat':'S'}
        zombie={'pid':43,'pgid':42,'uid':w.os.getuid(),'identity':'child','stat':'Z'}
        with patch.object(w,'command',side_effect=['42\n','42\n']),patch.object(w,'read_processes',return_value=[leader,zombie]) as refresh:
            self.assertEqual(w.read_threads([leader,zombie]),1)
            refresh.assert_called_once_with(42)
        with patch.object(w,'command',side_effect=['42\n','42\n']),patch.object(w,'read_processes',return_value=[leader,{**zombie,'stat':'Z+'}]):
            self.assertEqual(w.read_threads([leader,zombie]),1)
        with patch.object(w,'command',side_effect=['42\n','42\n']),patch.object(w,'read_processes',return_value=[leader,zombie]):
            self.assertEqual(w.read_threads([leader,{**zombie,'stat':'R'}]),1)
        header='USER PID TT %CPU STAT PRI STIME UTIME COMMAND\n'
        with patch.object(w,'command',side_effect=[header,header]),patch.object(w,'read_processes',return_value=[zombie]):
            self.assertEqual(w.read_threads([zombie]),0)
        for state in ('S','R','?',None):
            with self.subTest(state=state),patch.object(w,'command',side_effect=['42\n','42\n']),patch.object(w,'read_processes',return_value=[leader,{**zombie,'stat':state}]):
                with self.assertRaisesRegex(w.Refused,'thread_observation_invalid'):w.read_threads([leader,zombie])
        for key,value in (('identity','reused'),('uid',w.os.getuid()+1),('pgid',99)):
            with self.subTest(key=key),patch.object(w,'command',return_value='42\n'),patch.object(w,'read_processes',return_value=[leader,{**zombie,key:value}]):
                with self.assertRaisesRegex(w.Refused,'thread_observation_invalid'):w.read_threads([leader,zombie])
        with patch.object(w,'command',side_effect=['42\n','42\n']),patch.object(w,'read_processes',return_value=[leader,{**zombie,'pid':44}]):
            with self.assertRaisesRegex(w.Refused,'thread_observation_invalid'):w.read_threads([leader,zombie])

    def test_process_census_keeps_state_rss_and_identity_for_zombie(self):
        row=w.parse_processes('43 42 501 1024 00:01.50 Z Sat Oct 10 10:00:00 2026\n',42,501)[0]
        self.assertEqual(row['stat'],'Z');self.assertEqual(row['rss_kib'],1024)
        self.assertEqual(row['identity'],'Sat Oct 10 10:00:00 2026')
        with patch.object(w.os,'getuid',return_value=501),patch.object(w,'command',return_value='43 42 501 1024 00:01.50 Z Sat Oct 10 10:00:00 2026\n') as command:
            self.assertEqual(w.read_processes(42)[0]['stat'],'Z')
            self.assertIn('stat=',command.call_args.args[0][-1])

    def test_thread_refusal_records_bounded_safe_pid_state_without_command(self):
        leader={'pid':42,'pgid':42,'uid':w.os.getuid(),'identity':'leader secret','stat':'S'}
        live={'pid':43,'pgid':42,'uid':w.os.getuid(),'identity':'child secret','stat':'R'}
        with patch.object(w,'command',side_effect=['42\n','42\n']),patch.object(w,'read_processes',return_value=[leader,live]):
            with self.assertRaises(w.Refused) as caught:w.read_threads([leader,live])
        reason,raw=str(caught.exception).split(' ',1);details=json.loads(raw)
        self.assertEqual(reason,'thread_observation_invalid')
        self.assertEqual(details['stage'],'missing_live')
        self.assertEqual(details['missingPids'],[43])
        self.assertEqual(details['census'],[{'pid':42,'stat':'S'},{'pid':43,'stat':'R'}])
        self.assertNotIn('secret',raw)
        rows=[{**live,'pid':100+i,'stat':'R'} for i in range(100)]
        with patch.object(w,'command',return_value='42\n'),patch.object(w,'read_processes') as refresh:
            with self.assertRaises(w.Refused) as caught:w.read_threads(rows)
            refresh.assert_not_called()
        details=json.loads(str(caught.exception).split(' ',1)[1])
        self.assertLessEqual(len(details['census']),16);self.assertLessEqual(len(details['missingPids']),16)
        self.assertEqual(details['censusCount'],100)

    def test_storage_does_not_follow_foreign_links_and_is_bounded(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);owned=base/'owned';owned.mkdir();foreign=base/'foreign';foreign.mkdir();(foreign/'data').write_bytes(b'x'*1024)
            (owned/'small').write_bytes(b'123');(owned/'foreign').symlink_to(foreign,target_is_directory=True)
            observed=3+(owned/'foreign').lstat().st_size
            self.assertEqual(w.storage_bytes(owned,observed+1),observed)
            with self.assertRaisesRegex(w.Refused,'storage_root_unverified'):w.storage_bytes(owned/'foreign',2000)
            with self.assertRaises(w.Refused):w.storage_bytes(owned,1)

    def storage_clock_fixture(self,now,on_entry):
        original=w.os.scandir;attempts=[]
        @contextlib.contextmanager
        def scan(directory):
            attempts.append(directory)
            with original(directory) as entries:
                def observed():
                    for entry in entries:
                        on_entry(len(attempts),entry)
                        yield entry
                yield observed()
        return patch.object(w.time,'monotonic',side_effect=lambda:now[0]),patch.object(w.os,'scandir',side_effect=scan),attempts

    def test_storage_deadline_gets_one_fresh_census_without_double_counting(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'releases';root.mkdir();(root/'data').write_bytes(b'123')
            now=[0.0]
            clock,scan,attempts=self.storage_clock_fixture(now,lambda n,e:now.__setitem__(0,1.01 if n==1 else 1.02))
            with clock,scan:self.assertEqual(w.storage_bytes(root,10),3)
            self.assertEqual(len(attempts),2)

    def test_storage_two_deadlines_or_changed_root_refuse_with_safe_diagnostic(self):
        for changed in (False,True):
            with self.subTest(changed=changed),tempfile.TemporaryDirectory() as folder:
                root=Path(folder)/'releases';root.mkdir();(root/'private-filename').write_bytes(b'123')
                now=[0.0]
                def entry(n,e):
                    now[0]=1.01 if n==1 else 2.01
                    if changed and n==1:
                        root.rename(Path(folder)/'old');root.mkdir()
                clock,scan,attempts=self.storage_clock_fixture(now,entry)
                with clock,scan,self.assertRaises(w.Refused) as caught:w.storage_bytes(root,10)
                reason,raw=str(caught.exception).split(' ',1);details=json.loads(raw)
                self.assertEqual(reason,'storage_root_unverified' if changed else 'storage_observation_limit')
                self.assertEqual(details['rootClass'],'artifact');self.assertEqual(details['count'],1)
                self.assertGreaterEqual(details['elapsedSeconds'],1)
                self.assertNotIn(folder,raw);self.assertNotIn('private-filename',raw)
                self.assertEqual(len(attempts),1 if changed else 2)

    def test_storage_hard_limits_do_not_retry_even_if_deadline_also_expires(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'data').write_bytes(b'123')
            now=[0.0]
            clock,scan,attempts=self.storage_clock_fixture(now,lambda n,e:now.__setitem__(0,1.01))
            with clock,scan,self.assertRaisesRegex(w.Refused,'storage_budget_exceeded'):w.storage_bytes(root,1)
            self.assertEqual(len(attempts),1)
            original=w.os.scandir
            @contextlib.contextmanager
            def many(directory):
                with original(directory) as entries:
                    item=next(entries)
                    yield iter([item]*30001)
            with patch.object(w.os,'scandir',side_effect=many) as scan,patch.object(w.time,'monotonic',return_value=0),self.assertRaises(w.Refused) as caught:
                w.storage_bytes(root,100000)
            self.assertEqual(scan.call_count,1)
            details=json.loads(str(caught.exception).split(' ',1)[1])
            self.assertEqual(details['kind'],'file_limit');self.assertEqual(details['count'],30001)

    def test_storage_retry_rejects_changed_uid_or_device(self):
        from types import SimpleNamespace
        for field in ('st_uid','st_dev'):
            with self.subTest(field=field),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);(root/'data').write_bytes(b'123');now=[0.0]
                original=w.Path.lstat
                def observed(path,*args,**kwargs):
                    info=original(path,*args,**kwargs)
                    if path==root and now[0]>0:
                        values={key:getattr(info,key) for key in ('st_uid','st_dev','st_ino','st_mode')}
                        values[field]+=1;return SimpleNamespace(**values)
                    return info
                clock,scan,attempts=self.storage_clock_fixture(now,lambda n,e:now.__setitem__(0,1.01))
                with clock,scan,patch.object(w.Path,'lstat',autospec=True,side_effect=observed),self.assertRaisesRegex(w.Refused,'storage_root_unverified'):
                    w.storage_bytes(root,10)
                self.assertEqual(len(attempts),1)

    def test_artifact_full_five_second_window_never_restarts_after_exhaustion(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'releases';root.mkdir();(root/'data').write_bytes(b'123');now=[0.0]
            clock,scan,attempts=self.storage_clock_fixture(now,lambda n,e:now.__setitem__(0,4.99))
            with clock,scan:self.assertEqual(w.storage_bytes(root,512*w.MIB,artifact=True),3)
            self.assertEqual(len(attempts),1)
            now[0]=0
            clock,scan,attempts=self.storage_clock_fixture(now,lambda n,e:now.__setitem__(0,5.01))
            with clock,scan,self.assertRaisesRegex(w.Refused,'storage_observation_limit') as caught:
                w.storage_bytes(root,512*w.MIB,artifact=True)
            self.assertEqual(len(attempts),1)
            self.assertEqual(json.loads(str(caught.exception).split(' ',1)[1])['attempt'],1)

    def test_artifact_census_cache_requires_known_closure_and_expires_at_thirty_seconds(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);releases=base/'releases';releases.mkdir();(releases/'one').mkdir()
            cache=w.ArtifactCensus();now=[0.0]
            with patch.object(w.time,'monotonic',side_effect=lambda:now[0]),patch.object(w,'storage_bytes',return_value=123) as census:
                self.assertEqual(w.release_usage(base,cache),(1,123));self.assertEqual(cache.age_seconds(),0)
                now[0]=29;self.assertEqual(w.release_usage(base,cache),(1,123));self.assertEqual(census.call_count,1)
                self.assertEqual(cache.age_seconds(),29)
                now[0]=30;self.assertEqual(w.release_usage(base,cache),(1,123));self.assertEqual(census.call_count,2)
                census.assert_called_with(releases,512*w.MIB,artifact=True)
                now[0]=31;(releases/'two').mkdir()
                self.assertEqual(w.release_usage(base,cache),(2,123));self.assertEqual(census.call_count,3)
                (releases/'three').mkdir()
                with self.assertRaisesRegex(w.Refused,'release_budget_exceeded'):w.release_usage(base,cache)
                self.assertEqual(census.call_count,3)

    def test_artifact_generation_change_requires_fresh_success_never_old_usage(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);releases=base/'releases';releases.mkdir();(releases/'one').mkdir();cache=w.ArtifactCensus()
            with patch.object(w,'storage_bytes',return_value=123):self.assertEqual(w.release_usage(base,cache),(1,123))
            (releases/'one').rename(base/'old');(releases/'one').mkdir()
            with patch.object(w,'storage_bytes',side_effect=w.Refused('storage_budget_exceeded')) as census:
                with self.assertRaisesRegex(w.Refused,'storage_budget_exceeded'):w.release_usage(base,cache)
                self.assertEqual(census.call_count,1)
            with patch.object(w,'storage_bytes',return_value=456) as census:
                self.assertEqual(w.release_usage(base,cache),(1,456));self.assertEqual(census.call_count,1)

    def test_artifact_payload_changes_have_explicit_dated_lag_until_next_census(self):
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);payload=base/'releases/one/dist/payload';payload.parent.mkdir(parents=True)
            payload.write_bytes(b'123');cache=w.ArtifactCensus();now=[0.0]
            with patch.object(w.time,'monotonic',side_effect=lambda:now[0]),patch.object(w,'storage_bytes',wraps=w.storage_bytes) as census:
                self.assertEqual(w.release_usage(base,cache),(1,3));original=w.release_closure(base)
                payload.write_bytes(b'123456');self.assertEqual(w.release_closure(base),original)
                now[0]=29;self.assertEqual(w.release_usage(base,cache),(1,3));self.assertEqual(cache.age_seconds(),29)
                self.assertEqual(census.call_count,1)
                now[0]=30;self.assertEqual(w.release_usage(base,cache),(1,6));self.assertEqual(census.call_count,2)
                now[0]=60
                with patch.object(w,'storage_bytes',side_effect=w.Refused('storage_budget_exceeded')):
                    with self.assertRaisesRegex(w.Refused,'storage_budget_exceeded'):w.release_usage(base,cache)
                    self.assertIsNone(cache.age_seconds())

    def test_storage_directory_symlink_race_never_follows_or_retries(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder:
            base=Path(folder);root=base/'owned';root.mkdir();nested=root/'nested';nested.mkdir()
            foreign=base/'foreign';foreign.mkdir();(foreign/'private').write_bytes(b'x'*100)
            original=w.os.scandir
            @contextlib.contextmanager
            def scan(directory):
                with original(directory) as entries:
                    item=next(entries)
                    def observed(*args,**kwargs):
                        self.assertFalse(kwargs['follow_symlinks'])
                        info=item.stat(*args,**kwargs)
                        nested.rename(base/'old');nested.symlink_to(foreign,target_is_directory=True)
                        return info
                    yield iter([SimpleNamespace(name=item.name,stat=observed)])
            with patch.object(w.os,'scandir',side_effect=scan) as census,self.assertRaisesRegex(w.Refused,'storage_root_unverified'):
                w.storage_bytes(root,1000)
            self.assertEqual(census.call_count,1)

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
            with owned_unix_fixture(folder) as server:
                server.bind(str(pointer));pointer.chmod(0o600);server.listen(3)
                def observation(args):
                    if args[0]=='/usr/sbin/lsof':
                        self.assertIn('-a',args)
                        return f'p42\nn{binary}\n' if '-d' in args else '42\n'
                    return f'{w.os.getuid()} Sat Oct 10 10:00:00 2026 /usr/bin/ssh -L remote\n'
                with patch.object(w.Path,'home',return_value=home),patch.object(w,'command',side_effect=observation):
                    with self.assertRaisesRegex(w.Refused,'managed_codex_owner_unverified'):w.codex_environment(config)
                def native(args):
                    if args[0]=='/usr/sbin/lsof':
                        self.assertIn('-a',args)
                        return f'p42\nn{binary}\n' if '-d' in args else '42\n'
                    return f'{w.os.getuid()} Sat Oct 10 10:00:00 2026 codex -c features.code_mode_host=true app-server --listen unix://\n'
                with patch.object(w.Path,'home',return_value=home),patch.object(w,'command',side_effect=native):
                    self.assertEqual(w.codex_environment(config)['CODEX_APP_SERVER_SOCKET'],str(pointer))
                    with patch.object(w,'command',side_effect=lambda args: 'p42\nn/usr/bin/ssh\n' if '-d' in args else native(args)):
                        with self.assertRaisesRegex(w.Refused,'managed_codex_owner_unverified'):w.codex_environment(config)
                    config['codexOwnerStartedAt']='different generation'
                    with self.assertRaisesRegex(w.Refused,'managed_codex_owner_unverified'):w.codex_environment(config)

    def test_native_argv_global_options_do_not_accept_proxy_or_fake_subcommands(self):
        pointer=Path('/Users/fixture/.codex/app-server-control/app-server-control.sock')
        self.assertTrue(w.native_app_server_argv(['codex','-c','features.code_mode_host=true','app-server','--listen','unix://'],pointer))
        self.assertTrue(w.native_app_server_argv(['codex','--config=features.x=true','--enable','x','app-server','--listen','unix://'+str(pointer)],pointer))
        for args in (['codex','--unknown','app-server','--listen','unix://'], ['codex','app-server','proxy','--listen','unix://'], ['codex','-c','app-server','--listen','unix://'], ['ssh','-L','app-server','--listen','unix://']):
            self.assertFalse(w.native_app_server_argv(args,pointer))

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

    def test_owned_stderr_drains_beyond_pipe_capacity_and_never_exposes_raw_text(self):
        import sys,time
        marker=b'JavaScript heap out of memory';secret=b'PRIVATE_FIXTURE_DO_NOT_STORE'
        payload=b'x'*(4096-12)+marker+secret+b'x'*(1024*1024)
        script='import os,sys; data='+repr(payload)+';\nfor pos in range(0,len(data),4096):os.write(2,data[pos:pos+4096])\nsys.exit(7)'
        # Payload is pipe data, never a real native writer/credential. Avoid argv length limits.
        child=w.subprocess.Popen([sys.executable,'-I','-S','-B','-c','import sys;exec(sys.stdin.read())'],stdin=w.subprocess.PIPE,stdout=w.subprocess.DEVNULL,stderr=w.subprocess.PIPE,start_new_session=True)
        reader=None
        try:
            reader=w.ChildStderrDiagnostic(child.stderr)
            child.stdin.write(script.encode());child.stdin.close()
            self.assertEqual(child.wait(timeout=3),7)
            diagnostic=reader.close(time.monotonic()+1)
            self.assertEqual(diagnostic['stderrClass'],'heap_oom')
            self.assertEqual(diagnostic['stderrBytes'],len(payload))
            self.assertEqual(diagnostic['stderrSha256'],hashlib.sha256(payload).hexdigest())
            self.assertTrue(diagnostic['stderrComplete']);self.assertTrue(diagnostic['stderrReaderStopped'])
            self.assertTrue(child.stderr.closed);self.assertLessEqual(reader.TAIL_LIMIT,65536)
            self.assertNotIn(secret.decode(),json.dumps(diagnostic));self.assertNotIn(marker.decode(),json.dumps(diagnostic))
        finally:
            if child.poll() is None:child.kill();child.wait(timeout=1)
            if reader:reader.close(time.monotonic()+1)

    def test_stderr_fixed_panic_and_unknown_classes(self):
        import time
        for data,expected in [(b"thread 'main' panicked at PRIVATE_FILE",'panic'),(b'ordinary private dialogue', 'unknown')]:
            read,write=os.pipe();pipe=os.fdopen(read,'rb');os.write(write,data);os.close(write)
            reader=w.ChildStderrDiagnostic(pipe);result=reader.close(time.monotonic()+1)
            self.assertEqual(result['stderrClass'],expected);self.assertTrue(result['stderrComplete'])
            self.assertNotIn('PRIVATE_FILE',json.dumps(result));self.assertTrue(pipe.closed)

    def test_stderr_cleanup_does_not_wait_for_unknown_inherited_writer(self):
        import time
        read,write=os.pipe();pipe=os.fdopen(read,'rb');reader=w.ChildStderrDiagnostic(pipe)
        try:
            began=time.monotonic();result=reader.close(began+.3)
            self.assertLess(time.monotonic()-began,.4)
            self.assertTrue(result['stderrReaderStopped']);self.assertFalse(result['stderrComplete']);self.assertTrue(pipe.closed)
            os.fstat(write) # Closing our reader never closes/adopts the other fd.
        finally:os.close(write);reader.close(time.monotonic()+1)

    def test_stderr_frames_are_fixed_owned_basenames_and_never_paths_or_dialogue(self):
        import time
        root=Path('/fixture/releases/owned/dist')
        data=(b'Error: PRIVATE_DIALOGUE https://private.invalid/token\n'
            b'    at Example.run (file:///fixture/releases/owned/dist/mesh/fleet-owner-http-transport.js:12:34)\n'
            b'    at foreign (file:///foreign/dist/web/server.js:99:22)\n'
            b'    at credential (file:///fixture/releases/owned/dist/secret-token.js:1:2)\n'
            b'    at Example.run (file:///fixture/releases/owned/dist/mesh/fleet-owner-http-transport.js:12:34)\n')
        read,write=os.pipe();pipe=os.fdopen(read,'rb');os.write(write,data);os.close(write)
        reader=w.ChildStderrDiagnostic(pipe,root);result=reader.close(time.monotonic()+1)
        self.assertEqual(result['stderrFrames'],[{'file':'fleet-owner-http-transport.js','line':12,'column':34}])
        for value in ('PRIVATE_DIALOGUE','private.invalid','/fixture','/foreign','secret-token'):self.assertNotIn(value,json.dumps(result))

    def test_stderr_expired_cleanup_is_bounded_and_never_claims_unknown_thread_stopped(self):
        import time
        read,write=os.pipe();pipe=os.fdopen(read,'rb');reader=w.ChildStderrDiagnostic(pipe)
        try:
            # Deterministic held reader boundary, no foreign thread/process signal.
            with patch.object(reader._thread,'join') as join,patch.object(reader._thread,'is_alive',return_value=True):
                result=reader.close(time.monotonic()-1)
                self.assertFalse(result['stderrReaderStopped']);self.assertFalse(result['stderrComplete'])
                self.assertTrue(all(call.kwargs['timeout']==0 for call in join.call_args_list))
        finally:os.close(write);reader.close(time.monotonic()+1)

    def test_main_records_child_exit_code_and_sanitized_stderr_only(self):
        import sys
        with tempfile.TemporaryDirectory() as folder:
            home=Path(folder);base=home/'.local/share/agent-herder/fleet';state=home/'state';temp=base/'run/tmp'
            config={'sourceSha':'a'*40,'hostId':'fixture','harnesses':['codex']}
            env={};env.update({'ENABLE_'+name.upper().replace('-','_'):'false' for name in ('codex','zcode','opencode','claude','qoder','hermes','fast-agent','chatgpt')})
            native_popen=w.subprocess.Popen;children=[]
            def fake_child(*args,**kwargs):
                self.assertEqual(kwargs['stderr'],w.subprocess.PIPE)
                child=native_popen([sys.executable,'-I','-S','-B','-c','import os,sys;os.write(2,b"PRIVATE_FIXTURE");sys.exit(7)'],stdout=w.subprocess.DEVNULL,stderr=w.subprocess.PIPE)
                original_wait=child.wait
                # First census sees the actual exited child only after its owned reader starts.
                child.poll=lambda:original_wait(timeout=2)
                children.append(child);return child
            with patch.object(w.Path,'home',return_value=home),patch.object(w.sys,'argv',['watchdog']),patch.object(w,'json_file',return_value=config),patch.object(w,'prepare',return_value=(w.Policy('Macmini6,2'),Path('/fake/node'),base/'index.js',state,temp,env)),patch.object(w.subprocess,'Popen',side_effect=fake_child),patch.object(w.signal,'signal'),patch.object(w,'read_processes',return_value=[]):
                self.assertEqual(w.main(),78)
            report=json.loads((state/'last-run.json').read_text())
            self.assertEqual(report['childExitCode'],7);self.assertEqual(report['reason'],'node_exit')
            self.assertEqual(report['stderrClass'],'unknown');self.assertEqual(report['stderrBytes'],len(b'PRIVATE_FIXTURE'))
            self.assertTrue(report['stderrComplete']);self.assertTrue(children[0].stderr.closed)
            self.assertNotIn('PRIVATE_FIXTURE',(state/'last-run.json').read_text())

    def test_stderr_codes_are_fixed_not_error_messages(self):
        import time
        data=b'Error [ERR_INTERNAL_ASSERTION]: PRIVATE_COOKIE\nError [SECRET_CODE]: PRIVATE_DIALOGUE\n'
        read,write=os.pipe();pipe=os.fdopen(read,'rb');os.write(write,data);os.close(write)
        reader=w.ChildStderrDiagnostic(pipe);result=reader.close(time.monotonic()+1)
        self.assertEqual(result['stderrErrorCodes'],['ERR_INTERNAL_ASSERTION'])
        for value in ('PRIVATE_COOKIE','PRIVATE_DIALOGUE','SECRET_CODE'):self.assertNotIn(value,json.dumps(result))

    def test_launchagent_has_no_restart_loop_or_user_wide_limits(self):
        text=(ROOT/'deploy/fleet/mac-node.plist.in').read_text().replace('__HOME__','/Users/fixture').replace('__PYTHON_BIN__','/usr/bin/python3')
        value=plistlib.loads(text.encode())
        self.assertTrue(value['RunAtLoad']);self.assertFalse(value['KeepAlive']);self.assertEqual(value['ProcessType'],'Background')
        self.assertNotIn('NumberOfProcesses',str(value));self.assertNotIn('ResidentSetSize',str(value));self.assertNotIn('MemorySwapMax',str(value))
        self.assertIn('mac-node-watchdog.py',str(value['ProgramArguments']))

if __name__=='__main__':unittest.main()
