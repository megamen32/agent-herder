import importlib.util
import io
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
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
    def test_preflight_runs_and_validates_receipt_under_real_lease(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sha = 'a' * 40
            proof = {'project': 'test-project', 'fence': 1, 'owner': 'test', 'token': 'test-token'}
            proof_path = root / 'proof.json'
            proof_path.write_text(json.dumps(proof))
            state_path = root / 'leases.json'
            lease_state = {'fence': 1, 'owner': 'test', 'tokenHash': hashlib.sha256(b'test-token').hexdigest(),
                           'expiresAt': int(time.time() * 1000) + 60000}
            state_path.write_text(json.dumps({'projects': {'test-project': {'lease': lease_state}}}))
            def run(command, **kwargs):
                if command[0] == 'git':
                    return subprocess.CompletedProcess(command, 0, stdout=archive(), stderr=b'')
                receipt = Path(command[-1])
                receipt.parent.mkdir(parents=True, exist_ok=True)
                receipt.write_text(json.dumps({'cli_candidate': 'PASS', 'zcode_candidate': 'PASS',
                                              'release': 'INCOMPLETE',
                                              'report': {'candidate_bundle': {'source_sha': sha}}}))
                return subprocess.CompletedProcess(command, 0, stdout=b'', stderr=b'')
            with (rollout.ReleaseGate(str(proof_path), state_path=str(state_path)) as gate,
                  patch.object(rollout.subprocess, 'run', side_effect=run) as call,
                  patch.object(rollout.shutil, 'which', return_value='/fixture/codex'),
                  patch.object(Path, 'is_file', return_value=True)):
                rollout.run_native_candidate_preflight(root / 'release', sha, root, gate)
                self.assertEqual(call.call_count, 2)
                self.assertEqual(json.loads((root / 'ci-receipts' / f'{sha}-rollout.json').read_text())['release'], 'INCOMPLETE')

    def test_owner_matching_archive_and_passed_preflight_reaches_rollout(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sha = 'a' * 40
            candidate = root / 'releases' / sha
            (candidate / 'dist').mkdir(parents=True)
            (candidate / 'dist/index.js').write_text('tested')
            archive_path = root / 'release.tar'
            rollout.pack_release(candidate, archive_path)
            (root / 'node-config.json').write_text('{}')
            args = SimpleNamespace(authority_stdio=False, kind='owner', catalog=tmp,
                                   release_proof='/fixture-proof', unit='fixture.service',
                                   sha=sha, archive=str(archive_path), drop_in=str(root / 'dropin'))
            gate = Mock()
            lease = Mock()
            lease.__enter__ = Mock(return_value=gate)
            lease.__exit__ = Mock(return_value=False)
            with (patch.object(rollout, 'ReleaseGate', return_value=lease),
                  patch.object(rollout, 'run_native_candidate_preflight') as preflight,
                  patch.object(rollout, '_leased_node_side_owner', return_value=0) as mutate):
                self.assertEqual(rollout.node_side(args), 0)
                preflight.assert_called_once_with(candidate, sha, root, gate)
                mutate.assert_called_once_with(args, gate)
                gate.check.assert_called()

    def test_controller_passed_preflight_reaches_authorized_remote(self):
        with tempfile.TemporaryDirectory() as tmp:
            catalog = Path(tmp)
            sha = 'a' * 40
            release = catalog / 'releases' / sha
            release.mkdir(parents=True)
            (release / 'build-manifest.json').write_text(json.dumps({'sourceSha': sha, 'bundleFingerprint': 'bundle'}))
            node = {'id': 'server-44', 'kind': 'fleet', 'address': 'example', 'restartCmd': 'restart',
                    'sshUser': 'fixture', 'fleetDir': '/fixture', 'unit': 'fixture.service', 'hostId': 'server-44',
                    'pythonBin': 'python3', 'webPort': 1234, 'stateDir': '/fixture/state'}
            gate = Mock()
            lease = Mock()
            lease.__enter__ = Mock(return_value=gate)
            lease.__exit__ = Mock(return_value=False)
            def pack(_, path):
                path.write_bytes(b'fixture')
                return path
            def run(command, **kwargs):
                if command[0] == 'ssh':
                    return subprocess.CompletedProcess(command, 0, stdout='/tmp/herder-release.ABC12345\n')
                return subprocess.CompletedProcess(command, 0)
            argv = ['rollout', '--sha', sha, '--catalog', str(catalog), '--node', 'server-44',
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
                  patch.object(rollout, 'run_native_candidate_preflight') as preflight,
                  patch.object(rollout, 'verify_remote_python'),
                  patch.object(rollout.subprocess, 'run', side_effect=run),
                  patch.object(rollout, 'finish_staged_rollout', return_value=0) as finish):
                self.assertEqual(rollout.main(), 0)
                preflight.assert_called_once_with(release, sha, catalog, gate)
                command = finish.call_args.args[0]
                self.assertIn('--authority-stdio', command[-1])
                self.assertIs(finish.call_args.args[1], gate)

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
                   subprocess.CompletedProcess([], 1, stdout=b'', stderr=b'fixture failed secret-test-value')]
        with (tempfile.TemporaryDirectory() as tmp,
              patch.object(rollout.subprocess, 'run', side_effect=results) as run,
              patch.object(rollout.shutil, 'which', return_value='/fixture/codex'),
              patch.object(Path, 'is_file', return_value=True)):
            with self.assertRaisesRegex(RuntimeError, 'deterministic model fixture') as error:
                rollout.run_native_candidate_preflight(Path(tmp), 'a' * 40, Path(tmp), gate)
            self.assertNotIn('secret-test-value', str(error.exception))
            self.assertEqual(run.call_count, 2, 'the candidate runner must actually be invoked')
        self.assertEqual(gate.check.call_count, 1)


if __name__ == '__main__': unittest.main()
