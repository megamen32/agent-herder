#!/usr/bin/env python3
"""Accept a release on one node, by facts.

One command, read only: it never changes the node, never starts an executor
and never touches the emergency pause.

    python3 deploy/fleet/accept-node.py --sha <sha> --kind owner \
        --release-dir <dir> --port 18787 --unit agent-herder.service \
        --state-dir <dir> --working-directory <dir> --drop-in <path> \
        --expect-host roomhacker-server-100

The first thing the command prints is the host it runs on: a measurement is
only a fact about the machine it was taken on.

The checks are the acceptance of the owner:
  * the running process comes from this release - the process, not the file;
  * the bundle is the bundle of the manifest: the payload of the build and the
    fingerprint of the bundle are recomputed on the node;
  * every import of the runtime resolves from the release, never from the
    working directory and never from the store;
  * the workspace package is imported from the release and not from the store;
  * the release carries the full set of the store, and not one byte of it was
    copied;
  * the management answers: sessions, launch policy, MCP, and on the owner node
    the settings API;
  * the automation prohibition is named by state, scope and mechanism - not by
    a token and not by an absent file;
  * the release budget: at most two release directories, and the budget of the
    bytes is measured by the unique blocks of the release; the apparent size
    is printed as well, named as what it is;
  * the working directory and the entrypoint are the ones of this node.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.request

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import release_rules  # noqa: E402

BUDGET_MIB = 512
MAX_RELEASES = 2


def sha256_file(path: Path) -> str:
    return release_rules.sha256_file(path)


def http_status(url: str, timeout: float = 20.0) -> int:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            response.read(256)
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return 0


def mcp_status(port: int, timeout: float = 20.0) -> int:
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                       "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                                  "clientInfo": {"name": "acceptance", "version": "1"}}}).encode()
    request = urllib.request.Request(f"http://127.0.0.1:{port}/mcp", data=body, method="POST",
                                     headers={"Content-Type": "application/json",
                                              "Accept": "application/json, text/event-stream"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response.read(256)
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except Exception:
        return 0


def host_identity() -> dict:
    name = subprocess.run(["hostname", "-f"], capture_output=True, text=True, check=False).stdout.strip()
    short = subprocess.run(["hostname"], capture_output=True, text=True, check=False).stdout.strip()
    return {"hostname": name or short, "short": short}


def find_running_process(release: Path) -> dict:
    """The process that runs this release, by the facts of /proc."""
    found = {"pid": "", "cmdline": "", "cwd": ""}
    target = str(release.resolve())
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            raw = (entry / "cmdline").read_bytes()
        except OSError:
            continue
        if b"dist/index.js" not in raw:
            continue
        cmdline = raw.replace(b"\0", b" ").decode(errors="replace").strip()
        if target not in cmdline:
            continue
        try:
            cwd = os.readlink(entry / "cwd")
        except OSError:
            cwd = ""
        found = {"pid": entry.name, "cmdline": cmdline, "cwd": cwd}
        break
    return found


def unit_properties(unit: str) -> dict:
    result = subprocess.run(["systemctl", "--user", "show", unit,
                             "-p", "ActiveState", "-p", "WorkingDirectory",
                             "-p", "ExecStart", "-p", "MainPID"],
                            capture_output=True, text=True, check=False)
    properties = {}
    for line in result.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            properties[key] = value
    return properties


def payload_check(release: Path) -> dict:
    manifest_path = release / "dist" / "fleet-deployment-manifest.json"
    if not manifest_path.is_file():
        return {"ok": False, "error": "the build manifest of the release is missing"}
    manifest = json.loads(manifest_path.read_text())
    payload = manifest["payload"]
    actual = {}
    for path in sorted((release / "dist").rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        name = path.relative_to(release / "dist").as_posix()
        if name == "fleet-deployment-manifest.json":
            continue
        actual[name] = sha256_file(path)
    missing = sorted(set(payload) - set(actual))
    extra = sorted(set(actual) - set(payload))
    mismatched = sorted(name for name in set(payload) & set(actual) if payload[name] != actual[name])
    index_actual = actual.get("index.js")
    return {
        "ok": not missing and not extra and not mismatched and index_actual == payload.get("index.js"),
        "source_sha": manifest.get("source_sha"),
        "payload_files": len(payload),
        "actual_files": len(actual),
        "missing": missing[:5],
        "extra": extra[:5],
        "mismatched": mismatched[:5],
        "index_sha256": index_actual,
        "index_ok": index_actual == payload.get("index.js"),
    }


def bundle_check(release: Path, sha: str) -> dict:
    manifest_path = release / "build-manifest.json"
    if not manifest_path.is_file():
        return {"ok": False, "error": "the bundle manifest is missing"}
    manifest = json.loads(manifest_path.read_text())
    entries = release_rules.bundle_entries(release, exclude=("build-manifest.json",))
    fingerprint = release_rules.bundle_fingerprint(entries)
    return {
        "ok": manifest.get("sourceSha") == sha and manifest.get("bundleFingerprint") == fingerprint,
        "source_sha": manifest.get("sourceSha"),
        "source_sha_ok": manifest.get("sourceSha") == sha,
        "manifest_fingerprint": manifest.get("bundleFingerprint"),
        "recomputed_fingerprint": fingerprint,
        "files": len(entries),
        "built_at": manifest.get("builtAt"),
    }


IMPORT_PROBE = r"""
const {createRequire} = require("module");
const fs = require("fs");
const path = require("path");
const release = process.argv[2];
const entry = path.join(release, "dist", "index.js");
const requireFromRelease = createRequire(entry);

const visited = new Set();
const bare = new Map();
const pattern = /(?:^|[\s;{(])(?:import|export)[^'"`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

function walk(file) {
  let real;
  try { real = fs.realpathSync(file); } catch { return; }
  if (visited.has(real)) return;
  visited.add(real);
  let source;
  try { source = fs.readFileSync(real, "utf8"); } catch { return; }
  for (const match of source.matchAll(pattern)) {
    const spec = match[1] || match[2] || match[3];
    if (!spec) continue;
    if (spec.startsWith(".") || spec.startsWith("/")) {
      walk(path.resolve(path.dirname(real), spec));
      continue;
    }
    if (spec.startsWith("node:")) continue;
    if (!bare.has(spec)) bare.set(spec, real);
  }
}

// A package of the release, whether it is a commonjs one or an esm only one.
function packageDirectory(spec) {
  const parts = spec.split("/");
  const depth = (spec.startsWith("@") && parts.length > 1) ? 2 : 1;
  return path.join(release, "node_modules", ...parts.slice(0, depth));
}

function entryOf(directory) {
  const meta = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  const exportsField = meta.exports && meta.exports["."];
  let entry = null;
  if (typeof exportsField === "string") entry = exportsField;
  else if (exportsField && typeof exportsField === "object") entry = exportsField.import || exportsField.default || exportsField.require;
  if (!entry && exportsField && typeof exportsField === "object") entry = exportsField.import;
  entry = entry || meta.module || meta.main || "index.js";
  return path.join(directory, String(entry).replace(/^\.\//, ""));
}

walk(entry);
const builtins = new Set(require("module").builtinModules);
const resolved = [];
const outside = [];
const unresolved = [];
for (const [spec, from] of bare) {
  if (builtins.has(spec)) { resolved.push({spec, kind: "builtin"}); continue; }
  let target = null;
  let via = "require";
  try { target = fs.realpathSync(requireFromRelease.resolve(spec)); }
  catch (error) {
    // An esm only package: the commonjs resolver refuses it, the runtime
    // imports it as a module. The package must still live in the release.
    via = "package.json";
    try {
      const directory = packageDirectory(spec);
      if (!fs.existsSync(path.join(directory, "package.json"))) throw error;
      target = path.resolve(entryOf(directory));
      if (!fs.existsSync(target)) throw error;
    } catch (inner) {
      unresolved.push({spec, from, error: String(inner.message).slice(0, 140)});
      continue;
    }
  }
  const inside = target.startsWith(path.resolve(release) + path.sep);
  resolved.push({spec, kind: inside ? "release" : "outside", target, via});
  if (!inside) outside.push({spec, target, via});
}
console.log(JSON.stringify({
  modules: visited.size,
  imports: bare.size,
  resolved: resolved.length,
  from_release: resolved.filter((item) => item.kind === "release").length,
  builtins: resolved.filter((item) => item.kind === "builtin").length,
  outside,
  unresolved,
}));
"""


def import_check(release: Path, node_bin: str) -> dict:
    """Every import of the runtime must resolve from the release."""
    probe = Path("/tmp/acceptance-import-probe.cjs")
    probe.write_text(IMPORT_PROBE, encoding="utf-8")
    try:
        result = subprocess.run([node_bin, str(probe), str(release)],
                                capture_output=True, text=True, check=False, timeout=120)
        data = json.loads(result.stdout.strip().splitlines()[-1])
    except Exception as error:
        return {"ok": False, "error": str(error)[:200]}
    return {
        "ok": not data["outside"] and not data["unresolved"],
        "modules": data["modules"],
        "imports": data["imports"],
        "from_release": data["from_release"],
        "builtins": data["builtins"],
        "outside": data["outside"],
        "unresolved": data["unresolved"],
    }


def import_check_workspace(release: Path, store_modules: Path, node_bin: str) -> dict:
    """The workspace package must be imported from the release."""
    resolver = ('const {createRequire}=require("module");'
                'const fs=require("fs");'
                'const entry=process.argv[1];'
                'console.log(fs.realpathSync(createRequire(entry).resolve("agent-resume-mcp")))')
    try:
        result = subprocess.run([node_bin, "-e", resolver,
                                 str(release / "dist" / "index.js")],
                                capture_output=True, text=True, check=True, timeout=30)
        imported = Path(result.stdout.strip()).resolve(strict=True)
    except (OSError, subprocess.SubprocessError) as error:
        return {"ok": False, "error": str(error)[:200]}
    package = imported.parent.parent
    release_root = release.resolve()
    inside = os.path.commonpath([str(package), str(release_root)]) == str(release_root)
    try:
        expected = (release / "packages" / "agent-resume").resolve(strict=True)
    except OSError:
        expected = release / "packages" / "agent-resume"
    imported_digest = release_rules.bundle_fingerprint(release_rules.bundle_entries(package))
    expected_digest = release_rules.bundle_fingerprint(
        release_rules.bundle_entries(release / "packages" / "agent-resume"))
    store_package = ""
    if store_modules:
        candidate = Path(store_modules).expanduser() / "agent-resume-mcp"
        if candidate.exists() or candidate.is_symlink():
            store_package = str(Path(os.path.realpath(candidate)))
    return {
        "ok": inside and package == expected and imported_digest == expected_digest
              and store_package != str(imported),
        "imported_entry": str(imported),
        "imported_package": str(package),
        "inside_release": inside,
        "is_release_package": package == expected,
        "imported_tree_sha256": imported_digest,
        "release_tree_sha256": expected_digest,
        "store_package": store_package or "absent",
        "imports_store_package": bool(store_package) and store_package == str(imported),
    }


def dependency_check(release: Path, store_modules: Path) -> dict:
    """The release carries the full set of the store, and not one copied byte."""
    packages = release / "node_modules"
    release_set = release_rules.store_contents(packages)
    store_set = release_rules.store_contents(store_modules) if store_modules else []
    difference = release_rules.diff(store_set, release_set) if store_set else {
        "expected": 0, "actual": len(release_set), "missing": [], "extra": []}
    copied, offenders = release_rules.copied_bytes(packages)
    linked_cache = sorted(name for name in offenders
                          if name.split("/")[0] not in release_rules.MUTABLE_ENTRIES)
    shared_cache = release_rules.shared_cache_files(packages)
    resume = packages / "agent-resume-mcp"
    return {
        "ok": (not difference["missing"] and not difference["extra"] and not linked_cache
               and not shared_cache and resume.is_symlink()
               and os.readlink(resume) == "../packages/agent-resume"),
        "store_packages": difference["expected"],
        "release_packages": difference["actual"],
        "missing": difference["missing"][:5],
        "extra": difference["extra"][:5],
        "copied_bytes": copied,
        "copied_files": len(offenders),
        "copied_only_tool_caches": not linked_cache,
        "linked_cache_files": linked_cache[:5],
        "shared_cache_files": shared_cache[:5],
        "cache_owns_its_bytes": not shared_cache,
        "workspace_link": os.readlink(resume) if resume.is_symlink() else "absent",
    }


def lever_probe(state_dir: Path, release: Path, node_bin: str) -> dict:
    """The mechanism of the prohibition, exercised against the real state.

    The guard of the release decides with the real lever file of the node. The
    same guard is then asked about a runtime whose lever is off, through the
    same store class and with a lever file of the same shape: the refusal
    path is named, so the mechanism is proven and not merely present.
    """
    script = r"""
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const stateDir = process.argv[2];
const release = process.argv[3];
const off = fs.mkdtempSync(path.join(os.tmpdir(), "lever-off-"));
fs.writeFileSync(path.join(off, "automation-disarm.json"), JSON.stringify({
  version: 1, disarmed: true, changedBy: "acceptance", changedAt: new Date().toISOString(),
  blockedWorkKeys: [],
}));
(async () => {
  const state = await import(pathToFileURL(path.join(release, "dist/automation-disarm/state.js")).href);
  const guard = await import(pathToFileURL(path.join(release, "dist/automation-disarm/guard.js")).href);
  const live = await guard.automationDisarmDecision(state.AutomationDisarmStore.at(stateDir), [], "automation");
  const human = await guard.automationDisarmDecision(state.AutomationDisarmStore.at(stateDir), [], "human");
  const refused = await guard.automationDisarmDecision(state.AutomationDisarmStore.at(off), [], "automation");
  console.log(JSON.stringify({
    live_automation: live,
    live_human: human,
    with_lever_off: refused,
    refusal_code: guard.AUTOMATION_FORBIDDEN_CODE,
  }));
})();
"""
    path = Path("/tmp/acceptance-lever-probe.mjs")
    path.write_text(script, encoding="utf-8")
    try:
        result = subprocess.run([node_bin, str(path), str(state_dir), str(release)],
                                capture_output=True, text=True, check=False, timeout=30)
        return json.loads(result.stdout.strip().splitlines()[-1])
    except Exception as error:
        return {"error": str(error)[:200]}


def lever_check(state_dir: Path, release: Path, node_bin: str) -> dict:
    """State, scope and mechanism of the automation prohibition."""
    path = state_dir / "automation-disarm.json"
    if not path.is_file():
        return {"ok": False, "error": f"the lever file is missing: {path}",
                "state": "unknown", "scope": "unknown", "mechanism": "unknown"}
    document = json.loads(path.read_text())
    records = [item for item in (document.get("records") or []) if isinstance(item, dict)]
    forbidden = sorted(str(item.get("scope")) for item in records if item.get("forbidden"))
    probe = lever_probe(state_dir, release, node_bin)
    live = probe.get("live_automation", {})
    off = probe.get("with_lever_off", {})
    guard = release / "dist" / "automation-disarm" / "guard.js"
    armed = document.get("disarmed") is False
    return {
        "ok": armed and not forbidden and not (document.get("blockedWorkKeys") or [])
              and live.get("allowed") is True and off.get("allowed") is False
              and guard.is_file(),
        "state": f"armed (disarmed={document.get('disarmed')})",
        "lever_file": str(path),
        "lever_sha256": sha256_file(path)[:16],
        "changed_by": document.get("changedBy"),
        "changed_at": document.get("changedAt"),
        "scope": f"forbidden scopes: {forbidden or 'none'}",
        "blocked_work_keys": len(document.get("blockedWorkKeys") or []),
        "mechanism": f"{guard} refuses only source=automation with code {probe.get('refusal_code')}",
        "guard_present": guard.is_file(),
        "live_decision": live,
        "decision_with_lever_off": off,
        "human_decision": probe.get("live_human"),
    }


def budget_check(releases_root: Path, rollback_root: Path) -> dict:
    """The budget of the release directories.

    The budget is measured by the UNIQUE blocks: the bytes the releases own.
    The apparent size counts the store again for every link to it, so it is
    printed as well, named as what it is.
    """
    releases = sorted(item.name for item in releases_root.iterdir() if item.is_dir()) if releases_root.is_dir() else []
    size = release_rules.size_report(releases_root) if releases_root.is_dir() else release_rules.size_report(Path("/nonexistent"))
    rollback = sorted(item.name for item in rollback_root.iterdir()) if rollback_root.is_dir() else []
    return {
        "ok": len(releases) <= MAX_RELEASES and size["unique_mib"] <= BUDGET_MIB,
        "releases": releases,
        "directories": len(releases),
        "unique_bytes": size["unique_bytes"],
        "unique_mib": size["unique_mib"],
        "apparent_mib": size["apparent_mib"],
        "shared_mib": round(size["shared_bytes"] / 1024 / 1024, 1),
        "budget_mib": BUDGET_MIB,
        "rollback": rollback,
        "rollback_present": rollback_root.is_dir(),
    }


def management_check(port: int, kind: str) -> dict:
    base = f"http://127.0.0.1:{port}"
    result = {
        "sessions": http_status(f"{base}/api/sessions?quick=1&limit=1"),
        "launch_policy": http_status(f"{base}/api/automation/launch-policy"),
        "mcp": mcp_status(port),
    }
    if kind == "owner":
        result["settings"] = http_status(f"{base}/api/settings")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--kind", choices=["owner", "fleet"], required=True)
    parser.add_argument("--release-dir", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--unit", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--working-directory", default="")
    parser.add_argument("--drop-in", default="")
    parser.add_argument("--store-node-modules", default="")
    parser.add_argument("--releases-root", default="")
    parser.add_argument("--rollback-root", default="")
    parser.add_argument("--expect-host", default="", help="the host id this node must answer to")
    parser.add_argument("--node-bin", default="/usr/local/bin/node",
                        help="the node binary of this node; the probes run with it")
    parser.add_argument("--json", action="store_true", help="print the summary as JSON")
    arguments = parser.parse_args()

    identity = host_identity()
    print(f"== acceptance on {identity['hostname']} (short {identity['short']}) ==")
    if arguments.expect_host:
        match = arguments.expect_host == identity["hostname"] or arguments.expect_host == identity["short"]
        print(f"expected host: {arguments.expect_host} -> {'MATCH' if match else 'MISMATCH'}")

    release = Path(arguments.release_dir).expanduser()
    state_dir = Path(arguments.state_dir).expanduser()
    working_directory = Path(arguments.working_directory).expanduser() if arguments.working_directory else None
    drop_in = Path(arguments.drop_in).expanduser() if arguments.drop_in else None
    releases_root = Path(arguments.releases_root).expanduser() if arguments.releases_root else release.parent
    rollback_root = Path(arguments.rollback_root).expanduser() if arguments.rollback_root else releases_root.parent / "rollback"
    store_modules = Path(arguments.store_node_modules).expanduser() if arguments.store_node_modules else Path("")

    process = find_running_process(release)
    properties = unit_properties(arguments.unit)
    payload = payload_check(release)
    bundle = bundle_check(release, arguments.sha)
    imports = import_check(release, arguments.node_bin)
    workspace = import_check_workspace(release, store_modules, arguments.node_bin)
    dependencies = dependency_check(release, store_modules)
    management = management_check(arguments.port, arguments.kind)
    lever = lever_check(state_dir, release, arguments.node_bin)
    budget = budget_check(releases_root, rollback_root)
    release_size = release_rules.size_report(release)

    if arguments.kind == "owner":
        entrypoint_ok = arguments.sha in properties.get("ExecStart", "")
        entrypoint_detail = properties.get("ExecStart", "")[:160]
    else:
        entrypoint_ok = "bootstrap.py" in properties.get("ExecStart", "")
        entrypoint_detail = f"{properties.get('ExecStart', '')[:120]} (the bootstrap of the node runs the release)"
    if arguments.kind == "owner":
        working_ok = (working_directory is not None
                      and properties.get("WorkingDirectory", "").rstrip("/") == str(working_directory).rstrip("/"))
        drop_in_ok = bool(drop_in and drop_in.is_file() and str(release.resolve()) in drop_in.read_text())
        working_detail = f"{properties.get('WorkingDirectory', '')} (must stay {working_directory})"
    else:
        working_ok = bool(process["cwd"]) and os.path.commonpath(
            [process["cwd"], str(release.resolve())]) == str(release.resolve())
        drop_in_ok = True
        working_detail = f"cwd={process['cwd']} (inside the release)"

    checks = [
        ("the measurement is taken on the expected host",
         (not arguments.expect_host) or arguments.expect_host in (identity["hostname"], identity["short"]),
         f"{identity['hostname']} vs expected {arguments.expect_host or 'any'}"),
        ("the running process comes from this release",
         bool(process["pid"]) and arguments.sha in process["cmdline"],
         f"pid={process['pid'] or 'none'} cmdline={process['cmdline'][:120] or 'none'}"),
        ("the unit is active", properties.get("ActiveState") == "active",
         f"{arguments.unit}={properties.get('ActiveState', 'unknown')}"),
        ("the entrypoint is the release", entrypoint_ok, entrypoint_detail),
        ("the working directory is the one of this node", working_ok, working_detail),
        ("the drop-in of the owner node points at the release", drop_in_ok,
         str(drop_in) if drop_in else "not applicable"),
        ("the payload of the build is recomputed on the node", payload.get("ok", False),
         f"payload={payload.get('payload_files')} actual={payload.get('actual_files')} "
         f"missing={len(payload.get('missing', []))} extra={len(payload.get('extra', []))} "
         f"mismatched={len(payload.get('mismatched', []))} index_ok={payload.get('index_ok')}"),
        ("the bundle fingerprint of the manifest holds on the node",
         bundle.get("ok", False),
         f"manifest={bundle.get('manifest_fingerprint')} recomputed={bundle.get('recomputed_fingerprint')} "
         f"files={bundle.get('files')}"),
        ("the manifest is the one of this head", bundle.get("source_sha_ok", False),
         f"{bundle.get('source_sha')} vs {arguments.sha}"),
        ("every import of the runtime resolves from the release", imports.get("ok", False),
         f"modules={imports.get('modules')} imports={imports.get('imports')} from_release={imports.get('from_release')} "
         f"builtins={imports.get('builtins')} outside={len(imports.get('outside', []))} "
         f"unresolved={len(imports.get('unresolved', []))}"
         + (f" error={imports.get('error')}" if imports.get("error") else "")),
        ("the workspace package is imported from the release", workspace.get("ok", False),
         f"{workspace.get('imported_package')} inside={workspace.get('inside_release')} "
         f"from_store={workspace.get('imports_store_package')} "
         f"tree_ok={workspace.get('imported_tree_sha256') == workspace.get('release_tree_sha256')}"
         + (f" error={workspace.get('error')}" if workspace.get("error") else "")),
        ("the tool caches of the release are its own bytes (nlink=1)",
         dependencies.get("cache_owns_its_bytes", False),
         f"shared with the store: {dependencies.get('shared_cache_files', []) or 'none'}"),
        ("the release carries the full set of the store, nothing copied",
         dependencies.get("ok", False),
         f"store={dependencies.get('store_packages')} release={dependencies.get('release_packages')} "
         f"missing={len(dependencies.get('missing', []))} extra={len(dependencies.get('extra', []))} "
         f"copied={dependencies.get('copied_bytes')} B (only the tool caches of the store)"),
        ("the management answers", all(value == 200 for value in management.values()),
         " ".join(f"{name}={value}" for name, value in management.items())),
        ("the automation prohibition is armed, by state, scope and mechanism",
         lever.get("ok", False),
         f"state={lever.get('state')} scope={lever.get('scope')} mechanism={lever.get('mechanism')} "
         f"changedBy={lever.get('changed_by')} live={lever.get('live_decision')}"
         + (f" error={lever.get('error')}" if lever.get("error") else "")),
        ("the release budget holds", budget.get("ok", False),
         f"directories={budget.get('directories')}/{MAX_RELEASES} "
         f"unique={budget.get('unique_mib')} MiB/{BUDGET_MIB} MiB (disk increment) "
         f"apparent={budget.get('apparent_mib')} MiB (the store counted again) "
         f"releases={budget.get('releases')} rollback={len(budget.get('rollback', []))} entries"),
    ]

    failed = 0
    for name, ok, detail in checks:
        print(f"[{'OK ' if ok else 'FAIL'}] {name}: {detail}")
        failed += 0 if ok else 1
    summary = {
        "host": identity,
        "sha": arguments.sha,
        "kind": arguments.kind,
        "release": str(release),
        "release_size": release_size,
        "passed": len(checks) - failed,
        "total": len(checks),
        "verdict": "ACCEPTED" if not failed else "REFUSED",
        "checks": [{"name": name, "ok": bool(ok), "detail": detail} for name, ok, detail in checks],
    }
    print(f"release bytes : unique {release_size['unique_mib']} MiB (this release owns them), "
          f"apparent {release_size['apparent_mib']} MiB (the store counted again)")
    if arguments.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"== {summary['passed']}/{summary['total']} checks passed: {summary['verdict']} ==")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
