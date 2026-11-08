#!/usr/bin/env python3
"""Offline contract checks for the installed V1 launcher; no native harness."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

LAUNCHER = Path(__file__).with_name('launch-v1-core.py')

class LaunchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='herder-launch-test-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.marker = self.root / 'executed.json'
        self.paths = {}
        for name in ('core','compat','node','bootstrap','codex','chatgpt'):
            path = self.root / name
            if name == 'compat':
                path.write_text('#!/usr/bin/python3\nimport json,os,sys\nwith open(os.environ["TEST_MARKER"],"w") as f: json.dump({"argv":sys.argv,"core":os.environ.get("HERDER_NATIVE_COMMAND")},f)\n')
                path.chmod(0o700)
            else:
                path.write_text('fixture-'+name)
            self.paths[name] = str(path)
        self.manifest = {'core': self.paths['core'], 'compat': self.paths['compat'], 'node': self.paths['node'], 'bootstrap': self.paths['bootstrap'], 'adapters': {k:self.paths[k] for k in ('codex','chatgpt')}, 'source_commit':'fixture', 'sha256':{}}
        for k in ('core','compat','node','bootstrap'): self.manifest['sha256'][k] = self.hash(self.paths[k])
        self.manifest['sha256']['adapters'] = {k:self.hash(self.paths[k]) for k in ('codex','chatgpt')}
        self.manifest_path = self.root/'manifest.json'
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.profiles = []
        for kind in ('codex','chatgpt'):
            p = self.root / ('profile '+kind+'.json')
            self.write_private(p, {'owner':{'kind':kind,'executable':self.paths['node'],'ahap_script':self.paths[kind]}})
            self.profiles.append(str(p))
        self.selector = self.root/'selector.json'
        self.write_selector()
    def hash(self, path):
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    def write_private(self,path,data):
        path.write_text(json.dumps(data));path.chmod(0o600)
    def write_selector(self, profiles=None):
        self.write_private(self.selector, {'manifest':str(self.manifest_path),'manifest_sha256':self.hash(self.manifest_path),'profiles':self.profiles if profiles is None else profiles})
    def run_launcher(self, *args, selector=None):
        env = dict(os.environ, HERDER_V1_ENTRY=str(selector or self.selector), TEST_MARKER=str(self.marker))
        return subprocess.run([sys.executable, str(LAUNCHER), *args], capture_output=True, text=True, env=env, timeout=10)
    def rejected(self, *args):
        result=self.run_launcher(*args)
        self.assertNotEqual(result.returncode,0, result.stdout)
        self.assertFalse(self.marker.exists(), 'rejected selector must not execute compat')
        self.assertNotIn('fixture-',result.stderr)
        return result
    def test_check_is_read_only_and_reports_exact_multi_profile_argv(self):
        result=self.run_launcher('--check')
        self.assertEqual(result.returncode,0,result.stderr)
        data=json.loads(result.stdout)
        self.assertEqual(data['argv'],[self.paths['compat'],'--trusted-owner-profile',self.profiles[0],'--trusted-owner-profile',self.profiles[1]])
        self.assertEqual(data['manifest_sha256'],self.hash(self.manifest_path))
        self.assertFalse(self.marker.exists())
    def test_real_exec_passes_exact_argv_and_core_to_fake_compat(self):
        result=self.run_launcher()
        self.assertEqual(result.returncode,0,result.stderr)
        data=json.loads(self.marker.read_text())
        self.assertEqual(data['argv'],[self.paths['compat'],'--trusted-owner-profile',self.profiles[0],'--trusted-owner-profile',self.profiles[1]])
        self.assertEqual(data['core'],self.paths['core'])
    def test_selector_must_be_private_regular_canonical_single_link(self):
        self.selector.chmod(0o644);self.rejected()
        self.selector.chmod(0o600)
        link=self.root/'selector-symlink';link.symlink_to(self.selector)
        self.assertNotEqual(self.run_launcher(selector=link).returncode,0)
        hard=self.root/'selector-hardlink';os.link(self.selector,hard)
        self.rejected();hard.unlink()
        relative=os.path.relpath(self.selector,Path.cwd())
        self.assertNotEqual(self.run_launcher(selector=relative).returncode,0)
        self.assertFalse(self.marker.exists())
    def test_manifest_tamper_rejected_before_exec(self):
        self.manifest_path.write_text(self.manifest_path.read_text()+' ')
        self.rejected()
    def test_each_component_tamper_rejected_before_exec(self):
        for key in ('core','compat','node','bootstrap','codex','chatgpt'):
            with self.subTest(component=key):
                path=Path(self.paths[key]);old=path.read_bytes()
                try:
                    path.write_bytes(old+b'tamper');self.rejected()
                finally:path.write_bytes(old)
    def test_profile_mismatch_or_duplicate_rejected_before_exec(self):
        for field,value in [('executable',self.paths['core']),('ahap_script',self.paths['chatgpt']),('kind','unknown')]:
            with self.subTest(field=field):
                p=Path(self.profiles[0]);original=p.read_text();v=json.loads(original);v['owner'][field]=value
                try:self.write_private(p,v);self.rejected()
                finally:p.write_text(original);p.chmod(0o600)
        self.write_selector([self.profiles[0],self.profiles[0]]);self.rejected()
        self.write_selector([]);self.rejected()
    def test_profile_permissions_and_unknown_cli_rejected(self):
        p=Path(self.profiles[0]);p.chmod(0o644);self.rejected();p.chmod(0o600)
        self.rejected('--unexpected')

if __name__ == '__main__': unittest.main()
