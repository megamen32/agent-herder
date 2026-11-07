import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('rollout_native_preflight', ROOT / 'deploy/fleet/rollout-candidate.py')
rollout = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rollout)


def archive():
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as tar:
        data = b'# test fixture\n'
        entry = tarfile.TarInfo('tests/native/candidate_release_gate.py')
        entry.size = len(data)
        tar.addfile(entry, io.BytesIO(data))
    return stream.getvalue()


class NativeRolloutPreflightTests(unittest.TestCase):
    def test_owner_rejects_archive_other_than_tested_candidate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            candidate = root / 'releases' / ('a' * 40)
            (candidate / 'dist').mkdir(parents=True)
            (candidate / 'dist/index.js').write_text('tested')
            archive_path = root / 'unrelated.tar'
            archive_path.write_bytes(b'other bytes')
            args = SimpleNamespace(authority_stdio=False, kind='owner', catalog=tmp,
                                   release_proof='/fixture-proof', unit='fixture.service',
                                   sha='a' * 40, archive=str(archive_path), drop_in='/fixture/dropin')
            lease = Mock()
            lease.__enter__ = Mock(return_value=Mock())
            lease.__exit__ = Mock(return_value=False)
            with (patch.object(rollout, 'ReleaseGate', return_value=lease),
                  patch.object(rollout, 'run_native_candidate_preflight'),
                  patch.object(rollout, '_leased_node_side_owner') as mutate):
                with self.assertRaisesRegex(RuntimeError, 'archive differs'):
                    rollout.node_side(args)
                mutate.assert_not_called()

    def test_owner_rollout_does_not_mutate_after_preflight_failure(self):
        gate = Mock()
        lease = Mock()
        lease.__enter__ = Mock(return_value=gate)
        lease.__exit__ = Mock(return_value=False)
        args = SimpleNamespace(authority_stdio=False, kind='owner', catalog='/fixture',
                               release_proof='/fixture-proof', unit='fixture.service',
                               sha='a' * 40, archive='/fixture/archive', drop_in='/fixture/dropin')
        with (patch.object(rollout, 'ReleaseGate', return_value=lease),
              patch.object(Path, 'read_bytes', return_value=b'{}'),
              patch.object(rollout, 'run_native_candidate_preflight', side_effect=RuntimeError('candidate preflight failed')),
              patch.object(rollout, '_leased_node_side_owner', return_value=0) as mutate):
            with self.assertRaisesRegex(RuntimeError, 'candidate preflight'):
                rollout.node_side(args)
            mutate.assert_not_called()

    def test_direct_fleet_rollout_is_refused_without_controller(self):
        gate = Mock()
        lease = Mock()
        lease.__enter__ = Mock(return_value=gate)
        lease.__exit__ = Mock(return_value=False)
        args = SimpleNamespace(authority_stdio=False, kind='fleet', fleet_dir='/fixture',
                               release_proof='/fixture-proof', unit='fixture.service',
                               sha='a' * 40, archive='/fixture/archive')
        with (patch.object(rollout, 'ReleaseGate', return_value=lease),
              patch.object(rollout, 'run_native_candidate_preflight', side_effect=RuntimeError('candidate preflight failed')),
              patch.object(rollout, '_leased_node_side_fleet') as mutate):
            with self.assertRaisesRegex(RuntimeError, 'candidate preflight'):
                rollout.node_side(args)
            mutate.assert_not_called()

    def test_controller_does_not_stage_remote_after_failed_preflight(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalog = Path(tmp)
            release = catalog / 'releases' / ('a' * 40)
            release.mkdir(parents=True)
            (release / 'build-manifest.json').write_text(json.dumps({'sourceSha': 'a' * 40, 'bundleFingerprint': 'bundle'}))
            node = {'id': 'server-44', 'kind': 'fleet', 'address': 'example', 'restartCmd': 'restart',
                    'sshUser': 'fixture', 'fleetDir': '/fixture', 'unit': 'fixture.service', 'hostId': 'server-44'}
            gate = Mock()
            lease = Mock()
            lease.__enter__ = Mock(return_value=gate)
            lease.__exit__ = Mock(return_value=False)
            def pack(_, path):
                path.write_bytes(b'fixture')
                return path
            argv = ['rollout', '--sha', 'a' * 40, '--catalog', str(catalog), '--node', 'server-44',
                    '--deployment-config', '/unused', '--release-proof', '/unused']
            with (patch.object(sys, 'argv', argv), patch.object(rollout, 'load_nodes', return_value={}),
                  patch.object(rollout, 'node_spec', return_value=node), patch.object(rollout, 'validate_node', return_value=node),
                  patch.object(rollout, 'descriptor_digest', return_value='descriptor'),
                  patch.object(rollout.release_rules, 'bundle_entries', return_value={}),
                  patch.object(rollout.release_rules, 'bundle_fingerprint', return_value='bundle'),
                  patch.object(rollout, 'remote_live_sha', return_value='b' * 40),
                  patch.object(rollout, 'pack_release', side_effect=pack),
                  patch.object(rollout, 'verify_descriptor', return_value=node),
                  patch.object(rollout, 'deployment_target', return_value={}),
                  patch.object(rollout, 'ReleaseGate', return_value=lease),
                  patch.object(rollout, 'run_native_candidate_preflight', side_effect=RuntimeError('failed')),
                  patch.object(rollout, 'verify_remote_python') as remote):
                with self.assertRaisesRegex(RuntimeError, 'failed'):
                    rollout.main()
                remote.assert_not_called()

    def test_expired_lease_prevents_starting_any_candidate_runner(self):
        gate = Mock()
        gate.check.side_effect = RuntimeError('lease expired')
        with tempfile.TemporaryDirectory() as tmp, patch.object(rollout.subprocess, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'lease expired'):
                rollout.run_native_candidate_preflight(Path(tmp), 'a' * 40, Path(tmp), gate)
            run.assert_not_called()

    def test_failed_candidate_runner_never_accepts_receipt(self):
        gate = Mock()
        results = [subprocess.CompletedProcess([], 0, stdout=archive(), stderr=b''),
                   subprocess.CompletedProcess([], 1, stdout=b'', stderr=b'fixture failed')]
        with (tempfile.TemporaryDirectory() as tmp,
              patch.object(rollout.subprocess, 'run', side_effect=results) as run,
              patch.object(rollout.shutil, 'which', return_value='/fixture/codex'),
              patch.object(Path, 'is_file', return_value=True)):
            with self.assertRaisesRegex(RuntimeError, 'native candidate'):
                rollout.run_native_candidate_preflight(Path(tmp), 'a' * 40, Path(tmp), gate)
            self.assertEqual(run.call_count, 2, 'the candidate runner must actually be invoked')
        self.assertEqual(gate.check.call_count, 1)


if __name__ == '__main__': unittest.main()
