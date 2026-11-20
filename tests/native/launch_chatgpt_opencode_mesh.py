#!/usr/bin/env python3
"""Run the ChatGPT/OpenCode pair in a private Linux network and filesystem."""
import argparse
from contextlib import nullcontext
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


REPO = Path(__file__).resolve().parents[2]
STAND = "/repo/tests/native/chatgpt_opencode_mesh_stand.py"
SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"


def native_binary(value):
    path = Path(value).resolve()
    if path.is_file() and os.access(path, os.X_OK):
        with path.open("rb") as binary:
            if binary.read(4) == b"\x7fELF":
                return path
    raise argparse.ArgumentTypeError("expected an executable Linux ELF binary")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--core", required=True, type=native_binary, help="herder_native_stdio binary")
    parser.add_argument("--bootstrap", required=True, type=native_binary, help="ahap-owner-bootstrap binary")
    parser.add_argument("--opencode", required=True, type=native_binary, help="standalone OpenCode binary")
    parser.add_argument("--node", type=native_binary, default=shutil.which("node") or "/usr/bin/node")
    parser.add_argument("--playwright-core", required=True, type=Path,
                        help="Playwright Core package directory containing index.mjs")
    parser.add_argument("--router-dist", type=Path, default=REPO / "dist")
    parser.add_argument("--resume-dist", type=Path, default=REPO / "packages/agent-resume/dist")
    parser.add_argument("--output-parent", type=Path, default=Path(tempfile.gettempdir()),
                        help="existing parent for a new private run directory (default: system temp)")
    parser.add_argument("--check", action="store_true", help="open the sandbox and show the stand CLI only")
    args = parser.parse_args()

    mounts = []
    for path in ("/usr", "/bin", "/lib", "/opt/google/chrome", "/etc/fonts", "/etc/ld.so.cache",
                 "/etc/ssl/openssl.cnf", "/etc/hosts", "/etc/nsswitch.conf"):
        mounts.append((path, path))
    if Path("/lib64").exists():
        mounts.append(("/lib64", "/lib64"))
    for name in ("tests/native", "tests/helpers", "acceptance/native",
                 "package.json", "packages/agent-resume/package.json"):
        mounts.append((REPO / name, "/repo/" + name))
    for source, target, marker in (
        (REPO / "node_modules", "/repo/node_modules", "@modelcontextprotocol/server/package.json"),
        (args.router_dist, "/repo/dist", "mesh/fleet-direct-transport.js"),
        (args.resume_dist, "/repo/packages/agent-resume/dist", "index.js"),
        (args.playwright_core, "/playwright", "index.mjs"),
    ):
        if not (source / marker).is_file():
            parser.error(f"missing {source / marker}")
        mounts.append((source.resolve(), target))
    mounts.extend([(args.node, "/runtime/node"), (args.opencode, "/runtime/opencode"),
                   (args.core, "/runtime/herder_native_stdio"),
                   (args.bootstrap, "/runtime/ahap-owner-bootstrap")])

    os.umask(0o077)
    location = dict(prefix="chatgpt-opencode-", dir=args.output_parent.resolve())
    if args.check:
        directory = tempfile.TemporaryDirectory(**location)
    else:
        directory = nullcontext(tempfile.mkdtemp(**location))
    with directory as root:
        run = Path(root)
        (run / "scratch").mkdir()
        (run / "evidence").mkdir()
        (run / "passwd").write_text("root:x:0:0:fixture:/pair:/bin/sh\n")
        mounts.append((run / "passwd", "/etc/passwd"))

        # CAP_SYS_ADMIN is needed for the two nested UTS nodes, inside the mapped user namespace.
        cmd = ["unshare", "--user", "--map-root-user", "--net", "--",
               "/bin/sh", "-ec", 'ip link set lo up\nexec "$@"', "pair-net",
               "bwrap", "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc",
               "--unshare-uts", "--hostname", "pair-coordinator", "--cap-add", "CAP_SYS_ADMIN",
               "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/run"]
        for source, target in mounts:
            cmd.extend(["--ro-bind", source, target])
        cmd.extend(["--bind", run / "evidence", "/records", "--bind", run / "scratch", "/pair",
                    "--chdir", "/pair", "--clearenv", "--setenv", "HOME", "/pair",
                    "--setenv", "PATH", SYSTEM_PATH, "--setenv", "LANG", "C.UTF-8",
                    "--setenv", "PYTHONDONTWRITEBYTECODE", "1", "--"])
        if args.check:
            cmd.extend(["unshare", "--uts", "--", "/usr/bin/python3", STAND, "--help"])
        else:
            print(f"Receipt: {run / 'evidence/proof/receipt.json'}", flush=True)
            cmd.extend(["/usr/bin/python3", "-u", STAND, "--scratch", "/pair", "--output", "/records/proof",
                        "--node", "/runtime/node", "--opencode", "/runtime/opencode",
                        "--core", "/runtime/herder_native_stdio",
                        "--bootstrap", "/runtime/ahap-owner-bootstrap", "--playwright", "/playwright/index.mjs"])
        return subprocess.run(cmd, stdin=subprocess.DEVNULL, env={"PATH": SYSTEM_PATH}).returncode


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OSError as error:
        sys.exit(str(error))
