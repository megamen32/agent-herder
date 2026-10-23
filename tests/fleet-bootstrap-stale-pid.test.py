"""The fleet bootstrap survives a stale OpenCode pid: it adopts or starts the live OpenCode.
Only a fixture proc tree and a fixture config are used: no live node, service, release
or credential is touched.
"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('node_bootstrap', ROOT / 'deploy/fleet/node-bootstrap.py')
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)

OPENCODE_CMDLINE = ['/home/roomhacker/.npm-global/bin/opencode', 'serve',
                    '--hostname', '127.0.0.1', '--port', '4097']


def fixture_proc(root, processes=(), listeners=()):
    """A proc tree with fixture processes and fixture LISTEN sockets."""
    root.mkdir(parents=True, exist_ok=True)
    for pid, cmdline, environ in processes:
        directory = root / str(pid)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / 'cmdline').write_bytes(b'\0'.join(part.encode() for part in cmdline) + b'\0')
        (directory / 'environ').write_bytes(b'\0'.join(part.encode() for part in environ) + b'\0')
        (directory / 'status').write_text('Name:\topencode\nUid:\t%d\t%d\t%d\t%d\n' % ((os.getuid(),) * 4))
    rows = ['  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode']
    for port in listeners:
        rows.append('   0: 0100007F:%04X 00000000:0000 0A 00000000:00000000 00:00000000 00000000  100 0 0 100 0 0 0 0 0 0' % port)
    (root / 'net').mkdir(exist_ok=True)
    (root / 'net' / 'tcp').write_text('\n'.join(rows) + '\n')
    return root


class BootstrapOpencodeTests(unittest.TestCase):
    def config(self, folder, **overrides):
        config = {'opencodePid': 3688, 'opencodePort': 4097, 'harnesses': ['opencode']}
        config.update(overrides)
        path = Path(folder) / 'node-config.json'
        path.write_text(json.dumps(config, indent=1) + '\n')
        return config, path

    def test_stale_pid_adopts_the_live_opencode_and_records_it(self):
        # The measured incident: the recorded pid is gone, the OpenCode is alive.
        with tempfile.TemporaryDirectory() as folder:
            proc = fixture_proc(Path(folder) / 'proc', processes=[(
                2053045, OPENCODE_CMDLINE,
                ['OPENCODE_SERVER_PASSWORD=fixture', 'OPENCODE_SERVER_USERNAME=opencode'],
            )], listeners=[4097])
            config, path = self.config(folder)
            pid, native = bootstrap.opencode_environment(config, path, proc_root=proc)
            self.assertEqual(pid, 2053045)
            self.assertEqual(native['OPENCODE_URL'], 'http://127.0.0.1:4097')
            self.assertEqual(native['OPENCODE_SERVER_PASSWORD'], 'fixture')
            self.assertEqual(json.loads(path.read_text())['opencodePid'], 2053045)

    def test_live_recorded_pid_is_kept_and_the_record_is_not_rewritten(self):
        with tempfile.TemporaryDirectory() as folder:
            proc = fixture_proc(Path(folder) / 'proc', processes=[(
                2053045, OPENCODE_CMDLINE, [],
            )], listeners=[4097])
            config, path = self.config(folder, opencodePid=2053045)
            before = path.read_bytes()
            pid, _native = bootstrap.opencode_environment(config, path, proc_root=proc)
            self.assertEqual(pid, 2053045)
            self.assertEqual(path.read_bytes(), before)

    def test_reused_pid_is_treated_as_stale_and_the_live_opencode_wins(self):
        with tempfile.TemporaryDirectory() as folder:
            proc = fixture_proc(Path(folder) / 'proc', processes=[
                (3688, ['/usr/bin/sleep', '3600'], []),
                (2053045, OPENCODE_CMDLINE, []),
            ], listeners=[4097])
            config, path = self.config(folder)
            pid, _native = bootstrap.opencode_environment(config, path, proc_root=proc)
            self.assertEqual(pid, 2053045)
            self.assertEqual(json.loads(path.read_text())['opencodePid'], 2053045)

    def test_missing_opencode_is_started_by_the_node(self):
        with tempfile.TemporaryDirectory() as folder:
            proc = fixture_proc(Path(folder) / 'proc')
            config, path = self.config(folder)
            binary = Path(folder) / 'opencode'
            binary.write_text('#!/bin/sh\nexit 0\n')
            binary.chmod(0o700)
            config['opencodeBin'] = str(binary)
            spawned = {}

            class Started:
                pid = 4242
                returncode = None

                def poll(self):
                    return None

            def spawn(argv, **kwargs):
                spawned['argv'] = argv
                fixture_proc(proc, processes=[(
                    4242, argv, ['OPENCODE_SERVER_PASSWORD=started'],
                )], listeners=[4097])
                return Started()

            with patch.object(bootstrap.subprocess, 'Popen', side_effect=spawn):
                pid, native = bootstrap.opencode_environment(config, path, proc_root=proc)
            self.assertEqual(pid, 4242)
            self.assertEqual(spawned['argv'][1:], ['serve', '--hostname', '127.0.0.1', '--port', '4097'])
            self.assertEqual(native['OPENCODE_SERVER_PASSWORD'], 'started')
            self.assertEqual(json.loads(path.read_text())['opencodePid'], 4242)

    def test_missing_opencode_without_a_binary_names_the_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            proc = fixture_proc(Path(folder) / 'proc')
            config, path = self.config(folder)
            config['opencodeBin'] = str(Path(folder) / 'absent')
            with self.assertRaises(SystemExit) as caught:
                bootstrap.opencode_environment(config, path, proc_root=proc)
            message = str(caught.exception)
            self.assertIn('could not start OpenCode', message)
            self.assertIn('4097', message)
            self.assertNotIn('Traceback', message)

    def test_check_mode_without_opencode_names_the_missing_port(self):
        with tempfile.TemporaryDirectory() as folder:
            proc = fixture_proc(Path(folder) / 'proc')
            config, path = self.config(folder)
            with self.assertRaises(SystemExit) as caught:
                bootstrap.opencode_environment(config, path, proc_root=proc, start=False)
            self.assertIn('no live OpenCode', str(caught.exception))

    def test_recorded_opencode_on_another_port_is_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            proc = fixture_proc(Path(folder) / 'proc', processes=[(
                2053045, ['/usr/local/bin/opencode', 'serve', '--port', '4096'], [],
            )], listeners=[4096])
            config, path = self.config(folder, opencodePid=2053045)
            with self.assertRaises(SystemExit) as caught:
                bootstrap.opencode_environment(config, path, proc_root=proc)
            self.assertIn('native OpenCode port changed', str(caught.exception))

    def test_a_gone_pid_is_never_read_as_a_missing_file(self):
        # The defect of the incident: reading /proc/<gone pid>/cmdline raised.
        with tempfile.TemporaryDirectory() as folder:
            proc = fixture_proc(Path(folder) / 'proc', processes=[(
                2053045, OPENCODE_CMDLINE, [],
            )], listeners=[4097])
            config, path = self.config(folder)
            self.assertFalse(bootstrap.process_alive(3688, proc))
            self.assertEqual(bootstrap.process_cmdline(3688, proc), [])
            pid, _native = bootstrap.opencode_environment(config, path, proc_root=proc)
            self.assertEqual(pid, 2053045)


if __name__ == '__main__':
    unittest.main()
