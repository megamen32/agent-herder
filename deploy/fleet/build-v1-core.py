#!/usr/bin/env python3
"""Package prebuilt V1 core/bootstrap and four TS runners; never install/switch.

From the checkout root:
  python3 deploy/fleet/build-v1-core.py --output /absolute/new/candidate \
      --source-sha COMMIT --node /absolute/pinned/node

The caller builds Rust and compiles TS before this command. A source commit is
provenance supplied by the caller, not proof of how prebuilt inputs were built.
Every shipped component is independently pinned by SHA256. On failure, preserve
the partial output for inspection; a manifest exists only for a completed build.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
RUNNERS = ("opencode", "zcode", "browser", "codex")
BUNDLE = r'''
import { rolldown } from 'rolldown';
const [compiled, output] = process.argv.slice(1);
for (const name of ['opencode', 'zcode', 'browser', 'codex']) {
  const bundle = await rolldown({
    input: `${compiled}/ahap-${name}-runner.js`, platform: 'node',
    onLog(level, log, handler) {
      if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
      handler(level, log);
    },
  });
  try {
    await bundle.write({file: `${output}/ahap-${name}-runner.mjs`, format: 'esm',
      inlineDynamicImports: true, sourcemap: false,
      banner: 'import { createRequire as __ahapCreateRequire } from "node:module";\nconst require = __ahapCreateRequire(import.meta.url);',
    });
  } finally { await bundle.close(); }
}
'''


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def executable(path):
    path = path.resolve(strict=True)
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError(f"Not an executable regular file: {path}")
    return path


def build(args):
    output = args.output
    if not output.is_absolute():
        raise ValueError("--output must be absolute")
    if os.path.lexists(output):
        raise FileExistsError(f"Output already exists; refusing to modify it: {output}")
    if output.parent.resolve(strict=True) != output.parent:
        raise ValueError("--output parent must be canonical, without symlinks")
    sha = subprocess.check_output(
        ["git", "rev-parse", "--verify", "--end-of-options", args.source_sha + "^{commit}"],
        cwd=ROOT, text=True).strip()
    core, bootstrap, node = map(executable, (args.core, args.bootstrap, args.node))
    compat = executable(args.compat) if args.compat else None
    compiled = args.compiled_dir.resolve(strict=True)
    entries = {name: compiled / f"ahap-{name}-runner.js" for name in RUNNERS}
    entry_hashes = {name: digest(path) for name, path in entries.items()}
    inputs = {"core": core, "bootstrap": bootstrap, "node": node}
    if compat is not None:
        inputs["compat"] = compat
    input_hashes = {name: digest(path) for name, path in inputs.items()}
    output.mkdir(mode=0o700)  # exclusive; also rejects races and dangling links
    fixture = output / "fixture"
    fixture.mkdir(mode=0o700)
    names = {"core": "herder_native_stdio", "bootstrap": "ahap-owner-bootstrap",
             "node": "node", "compat": "herder-compat"}
    shipped = {}
    for name, source in inputs.items():
        target = fixture / names[name]
        shutil.copyfile(source, target)
        target.chmod(0o500)
        if digest(target) != input_hashes[name] or digest(source) != input_hashes[name]:
            raise RuntimeError(f"Input changed while copying: {name}")
        shipped[name] = target
    subprocess.run([str(node), "--input-type=module", "--eval", BUNDLE,
                    str(compiled), str(fixture)], cwd=ROOT, check=True,
                   env={"PATH": os.defpath}, timeout=180)
    if entry_hashes != {name: digest(path) for name, path in entries.items()}:
        raise RuntimeError("Compiled entrypoint changed while bundling")
    adapters = {name: fixture / f"ahap-{name}-runner.mjs" for name in RUNNERS}
    if set(fixture.iterdir()) != set(shipped.values()) | set(adapters.values()):
        raise RuntimeError("Bundler emitted unexpected files; refusing an unpinned component")
    # The browser entrypoint is shared; harness identity remains explicit at launch.
    adapters.update(chatgpt=adapters["browser"], zai=adapters["browser"])
    hashes = {name: digest(path) for name, path in shipped.items()}
    hashes["adapter"] = digest(adapters["opencode"])
    hashes["adapters"] = {name: digest(path) for name, path in adapters.items()}
    for path in set(adapters.values()):
        subprocess.run([str(shipped["node"]), "--check", str(path)],
                       check=True, env={"PATH": os.defpath}, timeout=30)
        path.chmod(0o400)
    manifest = {
        "artifact_root": str(output), "source_commit": sha, "source_sha": sha,
        **{name: str(path) for name, path in shipped.items()},
        "adapter": str(adapters["opencode"]),
        "adapters": {name: str(path) for name, path in adapters.items()},
        "sha256": hashes,
        "build_inputs": {"compiled_entrypoint_sha256": entry_hashes,
                         "binary_sha256": input_hashes,
                         "source_commit_role": "caller-supplied provenance for prebuilt inputs"},
        "launch": [str(shipped["core"]), "--trusted-owner-profile", "{protected_owner_profile}"],
    }
    if compat is not None:
        # The translator owns exactly one trusted profile per process and only
        # forwards launcher-controlled arguments to the pinned native core.
        manifest["launch_compat"] = {
            "argv": [str(shipped["compat"]), "--trusted-owner-profile", "{protected_owner_profile}"],
            "env": {"HERDER_NATIVE_COMMAND": str(shipped["core"])},
        }
    with (output / "manifest.json").open("x") as stream:
        json.dump(manifest, stream, indent=2)
        stream.write("\n")
    (output / "manifest.json").chmod(0o400)
    fixture.chmod(0o500)
    output.chmod(0o500)
    return {"manifest": str(output / "manifest.json"),
            "manifest_sha256": digest(output / "manifest.json"), "source_commit": sha}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--node", type=Path, required=True)
    parser.add_argument("--core", type=Path, default=ROOT / "crates/herder/target/debug/herder_native_stdio")
    parser.add_argument("--bootstrap", type=Path, default=ROOT / "crates/herder/target/debug/ahap-owner-bootstrap")
    parser.add_argument("--compiled-dir", type=Path, default=ROOT / ".tmp/v1-dist")
    parser.add_argument("--compat", type=Path, default=None,
                        help="optional herder-compat translator binary to pin in the manifest")
    args = parser.parse_args()
    if not args.node.is_absolute():
        parser.error("--node must explicitly select an absolute executable path")
    try:
        print(json.dumps(build(args)))
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Candidate build failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
