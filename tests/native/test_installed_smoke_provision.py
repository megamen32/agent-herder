import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[2] / 'deploy/fleet/provision-installed-smoke-runner.py'
SPEC = importlib.util.spec_from_file_location('installed_smoke_provision', SOURCE)
provision = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(provision)


class SafeRunnerArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.dest = self.root / 'runner'
        self.dest.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, members):
        path = self.root / 'runner.tar'
        with tarfile.open(path, 'w') as out:
            for name, kind, value in members:
                item = tarfile.TarInfo(name)
                item.type = kind
                item.mode = 0o755
                if kind == tarfile.REGTYPE:
                    raw = value.encode()
                    item.size = len(raw)
                    out.addfile(item, io.BytesIO(raw))
                else:
                    item.linkname = value
                    out.addfile(item)
        return path

    def extract(self, members):
        path = self.archive(members)
        with patch.object(provision, 'RUNNER_SHA256', hashlib.sha256(path.read_bytes()).hexdigest()):
            provision.extract_runner_archive(path, self.dest)

    def test_nested_symlink_keeps_parent_relative_target_on_old_data_filter(self):
        original = tarfile.data_filter

        def old_filter(member, destination):
            if member.issym():
                raise tarfile.LinkOutsideDestinationError(member, 'wrong root-relative anchor')
            return original(member, destination)

        with patch.object(tarfile, 'data_filter', old_filter):
            self.extract([
                ('externals/node20/lib/corepack.js', tarfile.REGTYPE, 'official payload'),
                ('externals/node20/bin/corepack', tarfile.SYMTYPE, '../lib/corepack.js'),
            ])
        link = self.dest / 'externals/node20/bin/corepack'
        self.assertEqual(link.readlink().as_posix(), '../lib/corepack.js')
        self.assertEqual(link.read_text(), 'official payload')
        member = tarfile.TarInfo('externals/node20/bin/corepack')
        member.type, member.linkname = tarfile.SYMTYPE, '../lib/corepack.js'
        member.uid, member.gid, member.uname, member.gname, member.mode = 123, 456, 'other', 'group', 0o4777
        filtered = provision.safe_runner_archive_filter(member, self.dest)
        self.assertEqual((filtered.uid, filtered.gid, filtered.uname, filtered.gname, filtered.mode), (None,) * 5)

    def test_relative_absolute_and_parent_directory_escapes_are_rejected(self):
        for link in ('../../escape', str(self.root / 'escape')):
            with self.subTest(link=link), self.assertRaises((ValueError, tarfile.FilterError)):
                self.extract([('bin/tool', tarfile.SYMTYPE, link)])
        with self.assertRaises((ValueError, tarfile.FilterError)):
            self.extract([('../escape', tarfile.REGTYPE, 'never outside')])
        self.assertFalse((self.root / 'escape').exists())

    def test_existing_destination_symlink_never_changes_new_link_anchor(self):
        (self.dest / 'bin').mkdir()
        deep = self.dest / 'deep/a/b/c'
        deep.mkdir(parents=True)
        (self.dest / 'bin/tool').symlink_to(deep)
        with self.assertRaises((ValueError, tarfile.FilterError)):
            self.extract([('bin/tool', tarfile.SYMTYPE, '../../escape')])
        self.assertEqual((self.dest / 'bin/tool').readlink(), deep)

    def test_existing_parent_symlink_cannot_redirect_extraction_outside(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (self.dest / 'pivot').symlink_to(outside, target_is_directory=True)
        with self.assertRaises((ValueError, tarfile.FilterError)):
            self.extract([('pivot/tool', tarfile.REGTYPE, 'never outside')])
        self.assertFalse((outside / 'tool').exists())

    def test_hardlink_guard_and_special_file_guard_remain_enabled(self):
        self.extract([('original', tarfile.REGTYPE, 'data'), ('copy', tarfile.LNKTYPE, 'original')])
        self.assertEqual((self.dest / 'copy').read_text(), 'data')
        for kind, target in [(tarfile.LNKTYPE, '../escape'), (tarfile.FIFOTYPE, '')]:
            with self.subTest(kind=kind), self.assertRaises((ValueError, tarfile.FilterError)):
                self.extract([('unsafe', kind, target)])

    def test_archive_digest_is_checked_before_any_extraction(self):
        path = self.archive([('new-file', tarfile.REGTYPE, 'data')])
        with self.assertRaisesRegex(ValueError, 'runner_download_digest_mismatch'):
            provision.extract_runner_archive(path, self.dest)
        self.assertEqual(list(self.dest.iterdir()), [])

    def test_service_entry_uses_the_packaged_bin_script_from_runner_root(self):
        self.extract([('bin/runsvc.sh', tarfile.REGTYPE, '#!/bin/bash\n./externals/node24/bin/node ./bin/RunnerService.js\n')])
        with patch.object(provision, 'RUNNER_ROOT', self.dest):
            unit = dict(line.split('=', 1) for line in provision.runner_service_unit().splitlines() if '=' in line)
        self.assertEqual(unit['WorkingDirectory'], str(self.dest))
        self.assertTrue(Path(unit['ExecStart']).is_file())
        self.assertEqual(Path(unit['ExecStart']).relative_to(self.dest).as_posix(), 'bin/runsvc.sh')


class OwnedResumeTests(unittest.TestCase):
    def test_existing_github_registration_refuses_resume_before_local_effects(self):
        args = SimpleNamespace(reviewed_source_sha='a' * 40, runtime_owner='roomhacker',
                               resume_plan='/review/plan.json', resume_plan_sha256='b' * 64,
                               collector='/review/collector', bindings='/review/bindings',
                               browser_manager='/review/manager', fixture='/review/fixture', node='/review/node')
        with patch.object(provision.os, 'geteuid', return_value=0), \
                patch.object(provision.os, 'uname', return_value=SimpleNamespace(machine='x86_64')), \
                patch.object(provision.pwd, 'getpwnam', return_value=SimpleNamespace(pw_dir='/owner')), \
                patch.object(Path, 'is_file', return_value=True), \
                patch.object(Path, 'is_symlink', return_value=False), \
                patch.object(provision, 'gh', return_value={'runners': [{'name': provision.RUNNER_NAME}]}), \
                patch.object(provision, 'execute') as effect, \
                patch.object(provision, 'prepare_owned_resume') as resume:
            with self.assertRaisesRegex(ValueError, 'existing_runner_name_refused'):
                provision.install(args)
            effect.assert_not_called()
            resume.assert_not_called()

    def binding(self):
        current = {'runner_user': {'name': provision.RUNNER_USER, 'uid': 988,
                                  'home': str(provision.RUNNER_HOME), 'shell': '/usr/sbin/nologin'},
                   'runner_tree_sha256': 'a' * 64, 'fixture_sha256': 'b' * 64,
                   'installed_files': {'bindings.cjs': 'c' * 64}, 'registration_markers': []}
        plan = {'version': 1, 'runner_uid': 988, 'partial_state': copy.deepcopy(current),
                'original_intent_sha256': 'd' * 64}
        failed = {'status': 'FAILED', 'exit_code': 1, 'timed_out': False, 'error_class': None,
                  'intent_sha256': 'd' * 64, 'reviewed_source_sha': 'e' * 40,
                  'install_manifest_exists': False}
        intent = {'action': 'provision_dedicated_installed_ci_runner', 'prior_install': 'ABSENT',
                  'shared_runtime_mutations': False, 'reviewed_source_sha': 'e' * 40}
        return plan, failed, intent, current

    def test_resume_requires_exact_recorded_owned_partial_and_failed_receipt(self):
        args = self.binding()
        provision.validate_resume_binding(*args)
        changes = [
            (1, 'status', 'UNKNOWN'), (1, 'exit_code', 0), (1, 'timed_out', True),
            (1, 'intent_sha256', 'f' * 64), (1, 'install_manifest_exists', True),
            (2, 'prior_install', 'PRESENT'), (2, 'shared_runtime_mutations', True),
            (3, 'runner_tree_sha256', 'f' * 64), (3, 'fixture_sha256', 'f' * 64),
            (3, 'registration_markers', ['.runner']),
            (3, 'runner_user', {'name': provision.RUNNER_USER, 'uid': 989, 'home': str(provision.RUNNER_HOME)}),
        ]
        for index, field, value in changes:
            with self.subTest(field=field):
                changed = copy.deepcopy(args)
                changed[index][field] = value
                with self.assertRaisesRegex(ValueError, 'owned_partial_resume_binding_mismatch'):
                    provision.validate_resume_binding(*changed)

    def test_even_matching_plan_cannot_authorize_registration_markers_or_root_user(self):
        for field, value in [('registration_markers', ['.credentials']),
                             ('runner_user', {'name': provision.RUNNER_USER, 'uid': 0, 'home': str(provision.RUNNER_HOME)})]:
            args = list(self.binding())
            args[3][field] = value
            args[0]['partial_state'][field] = value
            with self.assertRaises(ValueError):
                provision.validate_resume_binding(*args)

    def test_resume_intent_survives_unknown_and_is_never_dispatched_twice(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory).resolve()
            first = {'status': 'DISPATCH_INTENT', 'original_receipt_sha256': 'a' * 64}
            provision.claim_resume(directory, first)
            path = directory / 'resume-intent.json'
            before = path.read_bytes()
            with self.assertRaises(FileExistsError):
                provision.claim_resume(directory, {'status': 'RETRY'})
            self.assertEqual(path.read_bytes(), before)
            self.assertEqual(json.loads(before), first)

    def test_tree_digest_detects_content_mode_and_symlink_target_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            item = root / 'file'
            item.write_text('original')
            first = provision.runner_tree_digest(root)
            item.write_text('changed')
            self.assertNotEqual(provision.runner_tree_digest(root), first)
            before = provision.runner_tree_digest(root)
            item.chmod(0o700)
            self.assertNotEqual(provision.runner_tree_digest(root), before)
            link = root / 'link'
            link.symlink_to('file')
            before = provision.runner_tree_digest(root)
            link.unlink()
            link.symlink_to('missing')
            self.assertNotEqual(provision.runner_tree_digest(root), before)


if __name__ == '__main__':
    unittest.main()
