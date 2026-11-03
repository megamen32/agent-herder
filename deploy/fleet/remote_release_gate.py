"""Ephemeral release-gate RPC over one existing verified SSH process.

The real ReleaseGate, proof, ledger and Git repository stay on the authority.
The target keeps its own service lock and revision checks. No network listener,
persistent key, remote shell RPC, or target authority is created.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import time

from deployment_config import validate_node, verify_descriptor, descriptor_digest


def deployment_target(node):
    return dict(validate_node(node)["authorityTarget"])


def verify_target_identity(contract):
    node = verify_descriptor(contract["descriptor"], contract["descriptorDigest"])
    if (any(contract[key] != node[key] for key in ("hostId","fleetDir","unit"))
            or sys.platform != node["platform"] or os.getuid() != node["uid"]
            or str(Path.home()) != node["home"] or os.environ.get("HOME") != node["home"]):
        raise RuntimeError("release_target_identity_refused")


MAX_FRAME = 8192
RPC_TIMEOUT = 15
ROLLOUT_TIMEOUT = 600


class Frames:
    def __init__(self, reader, writer, timeout=RPC_TIMEOUT):
        self.reader, self.writer, self.timeout = reader, writer, timeout
        self.pending = b""
        os.set_blocking(reader, False)
        os.set_blocking(writer, False)

    def read(self, timeout=None):
        deadline = time.monotonic() + (self.timeout if timeout is None else timeout)
        while b"\n" not in self.pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.reader], [], [], remaining)[0]:
                raise RuntimeError("release_authority_channel_timeout")
            try:
                part = os.read(self.reader, 4096)
            except BlockingIOError:
                continue
            if not part:
                raise RuntimeError("release_authority_channel_closed")
            self.pending += part
            if len(self.pending) > MAX_FRAME:
                raise RuntimeError("release_authority_frame_too_large")
        line, self.pending = self.pending.split(b"\n", 1)
        try:
            value = json.loads(line)
        except (ValueError, UnicodeError):
            raise RuntimeError("release_authority_invalid_frame") from None
        if not isinstance(value, dict):
            raise RuntimeError("release_authority_invalid_frame")
        return value

    def write(self, value):
        data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        if len(data) > MAX_FRAME:
            raise RuntimeError("release_authority_frame_too_large")
        deadline = time.monotonic() + self.timeout
        while data:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([], [self.writer], [], remaining)[1]:
                raise RuntimeError("release_authority_channel_timeout")
            try:
                count = os.write(self.writer, data)
            except BlockingIOError:
                continue
            if count <= 0:
                raise RuntimeError("release_authority_channel_closed")
            data = data[count:]


class ProtocolError(RuntimeError):
    pass


class Authority:
    """Strict finite gate vocabulary, not a generic execution endpoint."""
    def __init__(self, gate, contract):
        descriptor = verify_descriptor(contract["descriptor"], contract["descriptorDigest"])
        if any(contract[key] != descriptor[key] for key in ("hostId","fleetDir","unit")):
            raise ProtocolError("release_authority_target_mismatch")
        self.gate, self.contract, self.sequence = gate, contract, 0
        self.started = False
        self.finished = False

    def handle(self, request):
        if (set(request) != {"sequence", "run", "method", "arguments"}
                or type(request["sequence"]) is not int
                or request["sequence"] != self.sequence + 1
                or request["run"] != self.contract["run"]
                or not isinstance(request["arguments"], dict)
                or self.finished):
            raise ProtocolError("release_authority_protocol_mismatch")
        method, args = request["method"], request["arguments"]
        expected = {k: self.contract[k] for k in
                    ("hostId", "fleetDir", "unit", "previousSha", "candidateSha", "descriptorDigest")}
        if not self.started:
            if method != "hello" or args != expected:
                raise ProtocolError("release_authority_target_mismatch")
            self.sequence = request["sequence"]
            self.gate.check()
            self.gate.candidate_descends_from(self.contract["previousSha"],
                                              self.contract["candidateSha"])
            self.started = True
        else:
            if method in ("check", "cleanup") and args == {}:
                action = lambda: self.gate.check(cleanup=method == "cleanup")
            elif method == "ancestry" and args == {
                    "previousSha": self.contract["previousSha"],
                    "candidateSha": self.contract["candidateSha"]}:
                action = lambda: self.gate.candidate_descends_from(args["previousSha"], args["candidateSha"])
            elif method == "finish" and set(args) == {"returncode"} and type(args["returncode"]) is int and args["returncode"] in (0, 1):
                action = lambda: self.gate.check(cleanup=args["returncode"] != 0)
            else:
                raise ProtocolError("release_authority_operation_refused")
            # A valid denied check consumes its sequence, so the existing
            # rollback can make a fresh cleanup request. Malformed traffic is fatal.
            self.sequence = request["sequence"]
            action()
            if method == "finish":
                self.finished = True
        return {"sequence": self.sequence, "run": self.contract["run"], "ok": True}


class RemoteReleaseGate:
    def __init__(self, contract, frames):
        self.contract, self.frames, self.sequence = contract, frames, 0
        self.fd = None
        self.config_path = Path(contract["fleetDir"]) / "node-config.json"

    def rpc(self, method, arguments=None):
        self.sequence += 1
        self.frames.write({"sequence": self.sequence, "run": self.contract["run"],
                           "method": method, "arguments": arguments or {}})
        answer = self.frames.read()
        if answer != {"sequence": self.sequence, "run": self.contract["run"], "ok": True}:
            raise RuntimeError("release_authority_refused")

    def __enter__(self):
        root = Path(self.contract["fleetDir"])
        if (not root.is_absolute() or root.resolve() != root
                or socket.gethostname() != self.contract["hostId"]):
            raise RuntimeError("release_authority_target_identity_mismatch")
        # One lock per actual unit, shared by remote runs from any authority.
        lock_root = Path(os.environ.get("AGENT_HERDER_RELEASE_LEASES",
                         str(Path.home() / ".local/state/agent-herder/project-release-leases.json"))).parent
        lock_root.mkdir(parents=True, exist_ok=True)
        key = hashlib.sha256(self.contract["unit"].encode()).hexdigest()
        self.fd = os.open(lock_root / ("deploy-unit-" + key + ".lock"),
                          os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            verify_target_identity(self.contract)
            if json.loads(self.config_path.read_text()).get("hostId") != self.contract["hostId"]:
                raise RuntimeError("release_authority_target_identity_mismatch")
            self.rpc("hello", {k: self.contract[k] for k in
                     ("hostId", "fleetDir", "unit", "previousSha", "candidateSha", "descriptorDigest")})
            self.compare_revision(self.config_path, self.contract["previousSha"])
        except BaseException:
            os.close(self.fd)
            self.fd = None
            raise
        return self

    def __exit__(self, *args):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def check(self, cleanup=False):
        self.rpc("cleanup" if cleanup else "check")

    def _config(self, config_path):
        if Path(config_path).resolve() != self.config_path.resolve():
            raise RuntimeError("release_authority_config_mismatch")
        return json.loads(Path(config_path).read_text()).get("sourceSha")

    def compare_revision(self, config_path, expected_sha):
        self.check()
        if expected_sha not in (self.contract["previousSha"], self.contract["candidateSha"]):
            raise RuntimeError("release_authority_revision_refused")
        if self._config(config_path) != expected_sha:
            raise RuntimeError("release_revision_changed_since_admission")

    def candidate_descends_from(self, previous_sha, candidate_sha):
        if (previous_sha, candidate_sha) != (self.contract["previousSha"], self.contract["candidateSha"]):
            raise RuntimeError("release_authority_ancestry_refused")
        self.rpc("ancestry", {"previousSha": previous_sha, "candidateSha": candidate_sha})

    def compare_cleanup_revision(self, config_path, allowed_shas):
        if set(allowed_shas) != {self.contract["previousSha"], self.contract["candidateSha"]}:
            raise RuntimeError("release_authority_cleanup_refused")
        self.check(cleanup=True)
        if self._config(config_path) not in allowed_shas:
            raise RuntimeError("release_cleanup_revision_changed")

    def finish(self, returncode):
        self.rpc("finish", {"returncode": returncode})


def remote_frames():
    # Reserve a descriptor for protocol; subprocess output must never become RPC.
    protocol_out = os.dup(sys.stdout.fileno())
    protocol_in = os.dup(sys.stdin.fileno())
    sys.stdout.flush()
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    null_in = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null_in, sys.stdin.fileno())
    os.close(null_in)
    return Frames(protocol_in, protocol_out)


def run_authorized_ssh(command, gate, contract):
    """The caller holds ReleaseGate until this exact child terminates."""
    authority = Authority(gate, contract)
    gate.check()
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    channel = Frames(process.stdout.fileno(), process.stdin.fileno())
    deadline = time.monotonic() + ROLLOUT_TIMEOUT
    try:
        while not authority.finished:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("release_remote_rollout_timeout")
            # Readiness may take longer than an RPC. The global operation is bounded.
            request = channel.read(timeout=remaining)
            try:
                answer = authority.handle(request)
            except ProtocolError:
                raise
            except (OSError, ValueError, RuntimeError):
                # A denied check is still delivered. Keep the channel available
                # for the existing narrowly fenced rollback path.
                answer = {"sequence": request.get("sequence"),
                          "run": contract["run"], "ok": False}
            channel.write(answer)
        remaining = max(0.1, deadline - time.monotonic())
        code = process.wait(timeout=remaining)
        if code != 0:
            return code
        return 0 if request["arguments"]["returncode"] == 0 else 1
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
        # Channel loss is UNKNOWN, never rerun or issue a speculative rollback.
        raise RuntimeError("release_remote_outcome_unconfirmed") from None
    finally:
        process.stdin.close()
        process.stdout.close()
        # Closing stdin makes a live target fail closed at its next check.
        # Keep the authority's OS lock until SSH exits; terminate only our SSH.
        if process.poll() is None:
            try:
                process.wait(timeout=RPC_TIMEOUT + 2)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
