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
import select
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
        self._bridge = None
        self._bridge_buffer = b""
        self._canonical = None
        self._legacy_admitted = False

    @staticmethod
    def _contains_lease(value):
        if isinstance(value, dict):
            return "lease" in value or any(ReleaseGate._contains_lease(nested) for nested in value.values())
        if isinstance(value, list):
            return any(ReleaseGate._contains_lease(nested) for nested in value)
        return False

    @staticmethod
    def _canonical_authority(state):
        if state.get("version", 1) == 1:
            if "canonical" in state:
                raise RuntimeError("release_canonical_seal_invalid")
            return None
        marker = state.get("canonical")
        projects = state.get("projects")
        if (state.get("version") != 2 or not isinstance(marker, dict)
                or marker.get("version") != 1
                or not all(isinstance(marker.get(k), str) and Path(marker[k]).is_absolute()
                           for k in ("config", "bridge"))
                or not isinstance(marker.get("seal_id"), str) or not marker["seal_id"]
                or not isinstance(projects, dict)
                or any(not isinstance(v, dict) for v in projects.values())
                or ReleaseGate._contains_lease(state)):
            raise RuntimeError("release_canonical_seal_invalid")
        return marker

    def _request(self, action, **extra):
        request = {"action": action, "project": self.proof["project"],
                   "owner": self.proof["owner"], "fence": self.proof["fence"],
                   "token": self.proof["token"], **extra}
        if self.target is not None:
            request["deploymentTarget"] = self.target
        return request

    def _start_bridge(self, marker):
        self._canonical = marker
        self._bridge_buffer = b""
        try:
            # Capabilities never appear in argv, process listings or stderr.
            self._bridge = subprocess.Popen(
                [marker["bridge"], "--config", marker["config"]],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except OSError:
            raise RuntimeError("release_canonical_bridge_unavailable") from None

    def _exchange(self, request):
        if self._bridge is None:
            raise RuntimeError("release_canonical_guard_missing")
        try:
            self._bridge.stdin.write((json.dumps(request) + "\n").encode())
            self._bridge.stdin.flush()
        except (OSError, BrokenPipeError):
            raise RuntimeError("release_canonical_bridge_closed") from None
        deadline = time.monotonic() + 10
        while b"\n" not in self._bridge_buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self._bridge.stdout], [], [], remaining)[0]:
                raise RuntimeError("release_canonical_bridge_timeout")
            part = os.read(self._bridge.stdout.fileno(), 65536)
            if not part:
                raise RuntimeError("release_canonical_bridge_closed")
            self._bridge_buffer += part
            if len(self._bridge_buffer) > 1024 * 1024:
                raise RuntimeError("release_canonical_bridge_invalid_response")
        line, self._bridge_buffer = self._bridge_buffer.split(b"\n", 1)
        try:
            response = json.loads(line)
        except (ValueError, UnicodeError):
            raise RuntimeError("release_canonical_bridge_invalid_response") from None
        if not isinstance(response, dict) or response.get("ok") is not True:
            error = response.get("error") if isinstance(response, dict) else None
            raise RuntimeError(error if isinstance(error, str) and re.fullmatch(r"[a-z0-9_.:-]{1,160}", error)
                               else "release_canonical_bridge_rejected")
        if "result" not in response:
            raise RuntimeError("release_canonical_bridge_invalid_response")
        return response["result"]

    def _close_bridge(self):
        bridge, self._bridge = self._bridge, None
        if bridge is None:
            return
        try:
            bridge.stdin.close()
            try:
                bridge.wait(timeout=2)
            except subprocess.TimeoutExpired:
                bridge.terminate()
                try:
                    bridge.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    bridge.kill()
                    bridge.wait(timeout=2)
        finally:
            bridge.stdout.close()

    def check(self, cleanup=False):
        state = json.loads(self.state_path.read_text())
        marker = self._canonical_authority(state)
        if marker is not None:
            if self._legacy_admitted:
                raise RuntimeError("release_authority_changed_retry")
            if self._bridge is not None:
                if marker != self._canonical:
                    raise RuntimeError("release_authority_changed_retry")
                return self._exchange({"action": "check", "cleanup": cleanup})
            if cleanup:
                raise RuntimeError("release_canonical_cleanup_requires_guard")
            self._start_bridge(marker)
            try:
                return self._exchange(self._request("check"))
            finally:
                self._close_bridge()
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
        marker = self._canonical_authority(json.loads(self.state_path.read_text()))
        if marker is not None:
            self._start_bridge(marker)
            try:
                result = self._exchange(self._request("guard"))
                if not isinstance(result, dict) or result.get("guarded") is not True:
                    raise RuntimeError("release_canonical_guard_not_acquired")
            except BaseException:
                self._close_bridge()
                raise
            return self
        # OS-released on process death. Serializes the full rollout including
        # readiness and rollback; status/renew still work through the MCP store.
        key = hashlib.sha256(self.proof["project"].encode()).hexdigest()
        path = self.state_path.parent / ("deploy-" + key + ".lock")
        self.fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
        self._legacy_admitted = True
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
        if self._bridge is not None:
            try:
                # Only a completed effect declares terminal evidence. On an
                # exception or interrupted channel the Rust guard retains UNKNOWN.
                if not args or args[0] is None:
                    self._exchange({"action": "finished"})
            finally:
                self._close_bridge()
            return
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
