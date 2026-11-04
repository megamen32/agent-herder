"""Release lease enforcement for the existing rollout path. Never prints capabilities.

One designated authority host owns the lease file. The rollout runs there.
This is coordination under existing OS/MCP access, not a security sandbox.
"""
import fcntl
import hashlib
import json
import os
import time
import subprocess
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main_guard  # noqa: E402


class ReleaseGate:
    def __init__(self, proof_path, state_path=None, now=None, target=None):
        self.proof = json.loads(Path(proof_path).read_text())
        self.state_path = Path(state_path or os.environ.get(
            "AGENT_HERDER_RELEASE_LEASES",
            str(Path.home() / ".local/state/agent-herder/project-release-leases.json")))
        self.now = now or (lambda: time.time() * 1000)
        self.fd = None
        self.target_fd = None
        self.target = target

    def check(self, cleanup=False):
        state = json.loads(self.state_path.read_text())
        p = self.proof
        lease = state.get("projects", {}).get(p["project"], {}).get("lease")
        if (not lease or (lease["expiresAt"] <= self.now() and not cleanup)
                or lease["fence"] != p["fence"]
                or lease["owner"] != p["owner"]
                or lease["tokenHash"] != hashlib.sha256(p["token"].encode()).hexdigest()):
            raise RuntimeError("release_lease_not_owned_or_expired")
        if self.target is not None and lease.get("deploymentTarget") != self.target:
            raise RuntimeError("release_lease_target_mismatch")
        return lease

    def __enter__(self):
        # OS-released on process death. Serializes the full rollout including
        # readiness and rollback; status/renew still work through the MCP store.
        key = hashlib.sha256(self.proof["project"].encode()).hexdigest()
        path = self.state_path.parent / ("deploy-" + key + ".lock")
        self.fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.target is not None:
                # Different project aliases must still serialize the actual service.
                target_key = hashlib.sha256(self.target["unit"].encode()).hexdigest()
                target_path = self.state_path.parent / ("deploy-unit-" + target_key + ".lock")
                self.target_fd = os.open(target_path, os.O_CREAT | os.O_RDWR, 0o600)
                fcntl.flock(self.target_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # A ledger writer may have probed the OS lock just before we took
            # it. Wait for that atomic transaction to finish before admission.
            deadline = time.monotonic() + 35
            while Path(str(self.state_path) + ".lock").exists():
                if time.monotonic() >= deadline:
                    raise RuntimeError("release_ledger_transaction_busy")
                time.sleep(0.01)
            self.check()
        except BaseException:
            if self.target_fd is not None:
                os.close(self.target_fd)
                self.target_fd = None
            os.close(self.fd)
            self.fd = None
            raise
        return self

    def __exit__(self, *args):
        if self.target_fd is not None:
            os.close(self.target_fd)
            self.target_fd = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def compare_revision(self, config_path, expected_sha):
        self.check()
        actual = json.loads(Path(config_path).read_text()).get("sourceSha")
        if actual != expected_sha:
            raise RuntimeError(main_guard.revision_mismatch_message(actual, expected_sha))

    def candidate_descends_from(self, previous_sha, candidate_sha):
        """Candidate must be in origin/main and descend from the live revision."""
        self.check()
        main_guard.check_deployable(["git", "--git-dir", self.proof["project"]], previous_sha, candidate_sha)

    def compare_cleanup_revision(self, config_path, allowed_shas):
        # Cleanup can outlive TTL but never ownership/fence or observed generation.
        self.check(cleanup=True)
        actual = json.loads(Path(config_path).read_text()).get("sourceSha")
        if actual not in allowed_shas:
            raise RuntimeError("release_cleanup_revision_changed")
