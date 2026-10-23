"""Fast regression for a transient Darwin mutable observer scheduling deadline.
No native runtime, daemon, external service or credential operation is performed.
"""
import importlib.util
from pathlib import Path
import os
import tempfile
import unittest
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('watchdog_retry',ROOT/'deploy/fleet/mac-node-watchdog.py')
w=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(w)

class MutableRetry(unittest.TestCase):
    def run_census(self,cases,limit=64*w.MIB,change_root=False):
        now=[0.0];probes=[];attempts=[]
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'fleet-node';root.mkdir()
            class Probe:
                def __init__(self,code,delay):
                    self.stdout=tempfile.TemporaryFile();self.stdout.write(b'BYTES 3\n');self.stdout.seek(0)
                    self.returncode=code;self.delay=delay;self.done=False
                def poll(self):return self.returncode
                def kill(self):self.returncode=-9
                def wait(self,timeout=None):
                    if not self.done:now[0]+=self.delay;self.done=True
                    return self.returncode
            def spawn(argv,**kwargs):
                self.assertEqual(Path.cwd().stat().st_ino,root.stat().st_ino)
                self.assertEqual(argv[-6],'--mutable');self.assertEqual(argv[-5],str(limit))
                index=len(attempts);attempts.append(argv);p=Probe(*cases[index]);probes.append(p);return p
            try:
                with patch.object(w.sys,'platform','darwin'),patch.object(w.time,'monotonic',side_effect=lambda:now[0]),patch.object(w.subprocess,'Popen',side_effect=spawn):
                    result=w.storage_bytes(root,limit)
                return result,len(attempts),now[0]
            finally:
                self.assertTrue(all(p.stdout.closed for p in probes))

    def test_one_deadline_at_actual_3_529s_then_fresh_healthy_probe_uses_original_four_second_window(self):
        self.assertEqual(self.run_census([(70,3.529),(0,.012)]),(3,2,3.541))

    def test_sustained_deadline_is_not_treated_as_healthy_or_retried_forever(self):
        with self.assertRaisesRegex(w.Refused,'storage_observation_limit') as caught:self.run_census([(70,1),(70,1)])
        self.assertIn('"attempt":2',str(caught.exception))

    def test_fresh_retry_does_not_hide_actual_byte_overage(self):
        with self.assertRaisesRegex(w.Refused,'storage_budget_exceeded'):self.run_census([(70,1),(68,.01)])

    def test_hard_byte_failure_is_not_retried(self):
        with self.assertRaisesRegex(w.Refused,'storage_budget_exceeded'):self.run_census([(68,.01)])

    def test_root_identity_failure_is_not_retried(self):
        with self.assertRaisesRegex(w.Refused,'storage_root_unverified'):self.run_census([(69,.01)])

if __name__=='__main__':unittest.main()
