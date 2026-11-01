"""Owner acceptance must belong to the restarted release, never a stale HTTP server."""
import importlib.util
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

FLEET = pathlib.Path(__file__).resolve().parents[1] / "deploy/fleet"
sys.path.insert(0, str(FLEET))
spec = importlib.util.spec_from_file_location("owner_readiness_rollout", FLEET / "rollout-candidate.py")
rollout = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rollout)

class OwnerReadiness(unittest.TestCase):
    def setUp(self):
        self.release = pathlib.Path("/isolated/releases/" + "a" * 40)
        self.old = (41, "100", ("/usr/bin/node", "/old/dist/index.js"))
        self.new = (42, "200", ("/usr/bin/node", str(self.release / "dist/index.js")))
    def ready(self, identity, previous=None, listens=True):
        with patch.object(rollout, "owner_process_identity", return_value=identity), \
             patch.object(rollout, "owner_listens", return_value=listens), \
             patch.object(rollout.time, "sleep"), \
             patch("urllib.request.urlopen") as http:
            result = rollout.wait_owner_ready("test.service", self.release, 9999,
                                              previous or self.old, attempts=1)
            return result, http.called
    def test_new_generation_owning_port_accepted(self):
        self.assertEqual(self.ready(self.new), (True, True))
    def test_old_pid_rejected_even_with_candidate_argv(self):
        stale=(self.old[0], self.old[1], self.new[2])
        self.assertEqual(self.ready(stale), (False, False))
    def test_new_pid_old_entrypoint_rejected(self):
        self.assertEqual(self.ready((42, "200", self.old[2])), (False, False))
    def test_unrelated_http_listener_rejected(self):
        self.assertEqual(self.ready(self.new, listens=False), (False, False))
    def test_missing_process_rejected(self):
        self.assertEqual(self.ready(None), (False, False))
    def test_process_changed_during_http_rejected(self):
        with patch.object(rollout, "owner_process_identity", side_effect=[self.new, self.old]), \
             patch.object(rollout, "owner_listens", return_value=True), \
             patch.object(rollout.time, "sleep"), patch("urllib.request.urlopen"):
            self.assertFalse(rollout.wait_owner_ready("test.service", self.release, 9999, self.old, attempts=1))
    def test_reload_failure_never_restarts_or_accepts(self):
        with patch.object(rollout, "owner_process_identity", return_value=self.old), \
             patch.object(rollout.subprocess, "run", return_value=SimpleNamespace(returncode=1)) as run, \
             patch.object(rollout, "wait_owner_ready") as ready:
            self.assertFalse(rollout.restart_owner_release("test.service", self.release, 9999))
            self.assertEqual(run.call_count, 1)
            ready.assert_not_called()
    def test_restart_failure_never_accepts_old_http(self):
        with patch.object(rollout, "owner_process_identity", return_value=self.old), \
             patch.object(rollout.subprocess, "run", side_effect=[SimpleNamespace(returncode=0),SimpleNamespace(returncode=1)]), \
             patch.object(rollout, "wait_owner_ready") as ready:
            self.assertFalse(rollout.restart_owner_release("test.service", self.release, 9999))
            ready.assert_not_called()
    def test_restart_checks_captured_generation(self):
        with patch.object(rollout, "owner_process_identity", return_value=self.old), \
             patch.object(rollout.subprocess, "run", return_value=SimpleNamespace(returncode=0)), \
             patch.object(rollout, "wait_owner_ready", return_value=True) as ready:
            self.assertTrue(rollout.restart_owner_release("test.service", self.release, 9999))
            ready.assert_called_once_with("test.service", self.release, 9999, self.old)

if __name__ == "__main__":
    unittest.main()
