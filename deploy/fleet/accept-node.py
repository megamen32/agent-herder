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
  * the release carries the full set of the build of the manifest - the set of
    the manifest is the truth, the store of the node is its own state - and not
    one byte of it was copied;
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
import platform
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
    portable_entries = release_rules.payload_entries(release, exclude=("build-manifest.json",))
    portable = release_rules.payload_fingerprint(portable_entries)
    # the fingerprint of the whole bundle is the property of the node that
    # carries the package farm; the build payload is the property of the build
    # and is the same on every node
    whole_ok = manifest.get("bundleFingerprint") == fingerprint
    manifest_portable = manifest.get("payloadFingerprint")
    payload_ok = (manifest_portable == portable) if manifest_portable else whole_ok
    return {
        "ok": manifest.get("sourceSha") == sha and payload_ok,
        "source_sha": manifest.get("sourceSha"),
        "source_sha_ok": manifest.get("sourceSha") == sha,
        "manifest_fingerprint": manifest.get("bundleFingerprint"),
        "recomputed_fingerprint": fingerprint,
        "whole_ok": whole_ok,
        "manifest_payload_fingerprint": manifest_portable,
        "recomputed_payload_fingerprint": portable,
        "payload_ok": payload_ok,
        "payload_files": len(portable_entries),
        "files": len(entries),
        "built_at": manifest.get("builtAt"),
    }


IMPORT_PROBE = r"""
const {createRequire} = require("module");
const fs = require("fs");
const path = require("path");

// The probe lives in /tmp: a resolution made from the probe itself would
// resolve relative to the script in /tmp. Every resolution is made from the
// file that makes the import, with a createRequire bound to that file: that
// is where the runtime of the release resolves it.
const releaseArgument = process.argv[2];
const shared = process.argv[3] || "";
const release = (() => {
  try { return fs.realpathSync(releaseArgument); }
  catch { return path.resolve(releaseArgument); }
})();
const entry = path.join(release, "dist", "index.js");
const requireFromRelease = createRequire(entry);

const pattern = /(?:^|[\s;{(])(?:import|export)[^'"`]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
const builtins = new Set(require("module").builtinModules);

// The bounds of the walk. A bound that was reached is named in the report:
// a walk that stopped early has not seen everything, and the acceptance
// must not be green on a walk that did not finish.
const MAX_FILES = 20000;
const MAX_PACKAGES = 800;
const MAX_RESOLUTIONS = 60000;

const visited = new Set();
const resolutions = new Set();
const resolved = [];
const outside = [];
const unresolved = [];
const bareSpecs = new Set();
const walkedPackages = new Set();
const pendingPackages = [];
let filesRead = 0;
let builtinCount = 0;
let truncated = false;

function isBuiltin(spec) { return builtins.has(spec) || spec.startsWith("node:"); }

function kindOf(target) {
  if (target === release || target.startsWith(release + path.sep)) return "release";
  if (!shared) return "outside";
  const root = path.resolve(shared);
  if (target === root || target.startsWith(root + path.sep)) return "shared";
  return "outside";
}

// Where a file lives: the release, the store of the area, or neither. The
// imports of the release must resolve; an import of a package of the store
// may name an optional dependency that is not installed anywhere, and that
// is a fact of the package, not a fault of the area.
function scopeOf(importer) {
  if (importer === release || importer.startsWith(release + path.sep)) return "release";
  if (shared) {
    const root = path.resolve(shared);
    if (importer === root || importer.startsWith(root + path.sep)) return "store";
  }
  return "other";
}

function packageDirectory(spec, importer) {
  // The directory of the package of an import, found the way the resolver of
  // Node finds it: up the parents of the importer.
  const parts = spec.split("/");
  const depth = (spec.startsWith("@") && parts.length > 1) ? 2 : 1;
  let dir = path.dirname(importer);
  for (let step = 0; step < 32; step++) {
    const candidate = path.join(dir, "node_modules", ...parts.slice(0, depth));
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function entryOf(directory) {
  const meta = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  const exportsField = meta.exports && meta.exports["."];
  let entry = null;
  if (typeof exportsField === "string") entry = exportsField;
  else if (exportsField && typeof exportsField === "object") {
    entry = exportsField.import || exportsField.default || exportsField.require;
  }
  if (!entry && exportsField && typeof exportsField === "object") entry = exportsField.import;
  entry = entry || meta.module || meta.main || "index.js";
  return path.join(directory, String(entry).replace(/^\.\//, ""));
}

// The resolution of one import, made from the file that makes it.
function resolveSpec(spec, importer, via) {
  const key = path.dirname(importer) + "\0" + spec;
  if (resolutions.has(key)) return null;
  resolutions.add(key);
  if (resolutions.size > MAX_RESOLUTIONS) { truncated = true; return null; }
  let target = null;
  try { target = fs.realpathSync(createRequire(importer).resolve(spec)); }
  catch (error) {
    // An esm only package: the commonjs resolver refuses it, the runtime
    // imports it as a module. The package must still live in the release or
    // in the verified store.
    via = "package.json";
    try {
      const directory = packageDirectory(spec, importer);
      if (!directory) throw error;
      const candidate = path.resolve(entryOf(directory));
      if (!fs.existsSync(candidate)) throw error;
      // The real path of the file: the area may offer the store under a
      // link, and the comparison is made against the store it names.
      target = fs.realpathSync(candidate);
    } catch (inner) {
      unresolved.push({spec, from: importer, via, scope: scopeOf(importer),
                       error: String(inner.message).slice(0, 140)});
      return null;
    }
  }
  const kind = kindOf(target);
  resolved.push({spec, kind, target, via});
  if (kind === "outside") {
    outside.push({spec, target, via, from: importer, scope: scopeOf(importer)});
  }
  return {target, kind};
}

function packageDirectoryUnder(root, target) {
  if (!root) return null;
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith("..")) return null;
  const parts = relative.split(path.sep);
  const depth = (parts[0].startsWith("@") && parts.length > 1) ? 2 : 1;
  return path.join(path.resolve(root), ...parts.slice(0, depth));
}

function queuePackage(target) {
  const directory = packageDirectoryUnder(shared, target);
  if (!directory) return;
  if (walkedPackages.has(directory)) return;
  walkedPackages.add(directory);
  pendingPackages.push(directory);
}

function walkFile(file) {
  // A file of the release or of the store: its imports are resolved from it.
  let real;
  try { real = fs.realpathSync(file); } catch { return; }
  if (visited.has(real)) return;
  visited.add(real);
  filesRead += 1;
  if (filesRead > MAX_FILES) { truncated = true; return; }
  let source;
  try { source = fs.readFileSync(real, "utf8"); } catch { return; }
  for (const match of source.matchAll(pattern)) {
    const spec = match[1] || match[2] || match[3];
    if (!spec) continue;
    if (spec.startsWith(".") || spec.startsWith("/")) {
      walkFile(path.resolve(path.dirname(real), spec));
      continue;
    }
    if (isBuiltin(spec)) { builtinCount += 1; continue; }
    bareSpecs.add(spec);
    const result = resolveSpec(spec, real, "require");
    if (result) queuePackage(result.target);
  }
}

function walkPackage(directory) {
  // Every file of a package of the store: the imports a package makes of its
  // siblings are resolved from the package that makes them, and that is the
  // place the legacy root store of the area would be found instead of the
  // verified store.
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, {withFileTypes: true}); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      walkFile(full);
      if (truncated) return;
    }
  }
}

// The bundle of the release.
const error = fs.existsSync(entry) ? "" : `the entry of the release is absent: ${entry}`;
if (!error) {
  walkFile(entry);
  // The resolution the runtime makes from the entry of the release.
  for (const spec of new Set(bareSpecs)) {
    const result = resolveSpec(spec, entry, "require");
    if (result) queuePackage(result.target);
  }
  // The packages of the store the runtime reaches.
  while (pendingPackages.length) {
    if (walkedPackages.size > MAX_PACKAGES) { truncated = true; break; }
    walkPackage(pendingPackages.shift());
    if (truncated) break;
  }
}
console.log(JSON.stringify({
  error,
  modules: filesRead,
  imports: bareSpecs.size,
  resolved: resolved.length,
  from_release: resolved.filter((item) => item.kind === "release").length,
  from_store: resolved.filter((item) => item.kind === "shared").length,
  builtins: builtinCount,
  outside,
  unresolved,
  unresolved_release: unresolved.filter((item) => item.scope !== "store").length,
  unresolved_store: unresolved.filter((item) => item.scope === "store").length,
  store_packages: walkedPackages.size,
  resolutions: resolutions.size,
  truncated,
}));
"""


def release_shared_store(release: Path) -> str:
    """The shared store of a release, when its packages live in one.

    A release whose packages are a farm of links resolves its third party
    packages inside the shared store of its own lock file: the store is
    named by the hash of that lock file, and the acceptance verifies the
    store before it accepts an import from it.

    A release that still carries its own packages has no shared store: every
    import of it must resolve inside the release, as before.
    """
    if not release_rules.is_package_farm(release / "node_modules"):
        return ""
    identity = release_rules.dependency_identity(release)
    store_dir = release_rules.shared_store_dir(release_rules.fleet_root_of(release), identity)
    try:
        release_rules.verify_shared_store(store_dir, identity)
    except (RuntimeError, OSError, ValueError) as error:
        return ""
    return str(store_dir)


def import_check(release: Path, node_bin: str) -> dict:
    """Every import of the runtime must resolve from the release.

    An import that resolves inside the shared store of the lock file of the
    release is an import of the release: the store holds exactly the runtime
    set of that lock file, and the store is verified before it is used.
    """
    probe = Path("/tmp/acceptance-import-probe.cjs")
    probe.write_text(IMPORT_PROBE, encoding="utf-8")
    shared = release_shared_store(release)
    try:
        result = subprocess.run([node_bin, str(probe), str(release), shared],
                                capture_output=True, text=True, check=False, timeout=120)
        data = json.loads(result.stdout.strip().splitlines()[-1])
    except Exception as error:
        return {"ok": False, "error": str(error)[:200]}
    if data.get("error"):
        return {"ok": False, "error": str(data["error"])[:200]}
    area = {}
    area_ok = True
    store_root = {}
    if shared:
        area = release_rules.area_package_root_state(
            release_rules.fleet_root_of(release), Path(shared))
        # The store offers its own packages under the name the resolver of
        # Node looks for: the resolver of a package of the store stays inside
        # the store it was verified against.
        store_root = release_rules.store_package_root_state(Path(shared))
        # The area must offer the store of the packages under the name the
        # resolver of Node looks for. A legacy root store of the area offers
        # its own packages there instead, and the store of the release would
        # not be the source of the resolution: the acceptance has to see that.
        area_ok = area.get("state") == "link" and bool(area.get("points_at_store"))
    # An import of the release must resolve. An import of a package of the
    # store may name an optional dependency that is installed nowhere: that
    # is a fact of the package and not a fault of the area, so it is named
    # and counted, not refused.
    unresolved = data["unresolved"]
    unresolved_release = [item for item in unresolved if item.get("scope") != "store"]
    unresolved_store = [item for item in unresolved if item.get("scope") == "store"]
    return {
        # A walk that stopped at its bound has not seen every import: the
        # acceptance is not green on a walk that did not finish.
        "ok": (not data["outside"] and not unresolved_release
               and area_ok and not data.get("truncated")),
        "modules": data["modules"],
        "imports": data["imports"],
        "from_release": data["from_release"],
        "from_store": data.get("from_store", 0),
        "builtins": data["builtins"],
        "outside": data["outside"],
        "unresolved": unresolved,
        "unresolved_release": len(unresolved_release),
        "unresolved_store": len(unresolved_store),
        "store_packages": data.get("store_packages", 0),
        "resolutions": data.get("resolutions", 0),
        "truncated": bool(data.get("truncated")),
        "shared_store": shared,
        "area_package_root": area,
        "area_package_root_ok": area_ok,
        "store_package_root": store_root,
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


def platform_tags() -> tuple:
    """The os and the cpu of this node, in the names the lock file uses."""
    os_names = {"linux": "linux", "darwin": "darwin", "win32": "win32"}
    machine = platform.machine().lower()
    cpu_names = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}
    return os_names.get(sys.platform, sys.platform), cpu_names.get(machine, machine)


def libc_family() -> str:
    """The libc of this node: glibc, musl, or unknown."""
    try:
        name = (platform.libc_ver() or ("", ""))[0].lower()
    except Exception:  # noqa: BLE001 - the platform must not break the measurement
        return "unknown"
    if "glibc" in name or "gnu" in name:
        return "glibc"
    if "musl" in name:
        return "musl"
    return "unknown"


def manifest_package_set(release: Path) -> dict:
    """The set of packages the release must carry, taken from the build manifest.

    The manifest of the build pins the package lock of the build, and the rule
    it names is the runtime set of that lock for this platform, without the dev
    packages. That set is the truth of the comparison: the store of the node is
    the state of the node, and the release of a fleet node carries the packages
    of the farm of that node. The store of the node is never the basis.

    A package that the lock marks optional is named, but it is not required:
    the runtime must not depend on it, so its absence is not a trimming. A
    package of another platform is not required either.
    """
    manifest_path = release / "build-manifest.json"
    if not manifest_path.is_file():
        return {"ok": False, "error": "the build manifest of the release is missing"}
    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError as error:
        return {"ok": False, "error": f"the build manifest is not readable: {error}"}
    lock_path = release / "package-lock.json"
    if not lock_path.is_file():
        return {"ok": False, "error": "the package lock of the release is missing"}
    lock_sha = release_rules.sha256_file(lock_path)
    pinned = (manifest.get("artifacts") or {}).get("package-lock.json")
    if pinned and pinned != lock_sha:
        return {"ok": False,
                "error": "the package lock of the release is not the one of the build",
                "manifest_lock_sha256": pinned,
                "release_lock_sha256": lock_sha}
    os_name, cpu = platform_tags()
    family = libc_family()
    lock = json.loads(lock_path.read_text())
    required = set()
    optional = set()
    foreign = set()
    dev = set()
    for path, meta in (lock.get("packages") or {}).items():
        if not path.startswith("node_modules/"):
            continue
        name = path[len("node_modules/"):]
        if "/node_modules/" in name:
            continue  # a nested package, not a package of the farm
        if name == release_rules.WORKSPACE_PACKAGE or meta.get("link"):
            continue  # the workspace package is a link into the release, checked apart
        if meta.get("inBundle"):
            continue
        if meta.get("dev"):
            dev.add(name)
            continue
        if meta.get("os") and os_name not in meta["os"]:
            foreign.add(name)
            continue
        if meta.get("cpu") and cpu not in meta["cpu"]:
            foreign.add(name)
            continue
        if meta.get("libc"):
            if family == "unknown":
                optional.add(name)  # the platform is unknown: named, but not required
                continue
            if family not in meta["libc"]:
                foreign.add(name)
                continue
        if meta.get("optional"):
            optional.add(name)
            continue
        required.add(name)
    return {
        "ok": True,
        "required": sorted(required),
        "optional": sorted(optional),
        "foreign": len(foreign),
        "dev": len(dev),
        "os": os_name,
        "cpu": cpu,
        "libc": family,
        "lock_sha256": lock_sha,
        "manifest_lock_sha256": pinned or "not pinned",
        "rule": "the runtime set of the package lock of the build for this platform, without the dev packages",
        "source": f"build-manifest.json -> package-lock.json sha256 {lock_sha[:12]}",
    }


def node_store_modules(arguments, release: Path) -> tuple:
    """The store of the node: named by the caller, or named by the layout.

    The store of the node is its own state. It is not the basis of the
    comparison of the packages of the release, but it is the place the
    workspace package must not come from, so it is named: by the caller, or by
    the layout of the fleet (the farm of the node is the node_modules of the
    fleet directory, the releases live inside it).
    """
    if arguments.store_node_modules:
        path = Path(arguments.store_node_modules).expanduser()
        return path, "named by the caller"
    if release.parent.name == "releases":
        candidate = release.parent.parent / "node_modules"
        if candidate.is_dir():
            return candidate, "the farm of the fleet directory of the node"
    return None, "not named"


def dependency_check(release: Path, store_modules) -> dict:
    """The release carries the full set of the build, and not one copied byte.

    The set of the comparison is the set of the build manifest, not the store
    of the node. The store of the node is named here as an observation: it is
    the state of the node, and a divergence between it and the release of a
    fleet node is normal.
    """
    packages = release / "node_modules"
    release_set = release_rules.store_contents(packages)
    source = manifest_package_set(release)
    required = set(source.get("required") or [])
    missing = sorted(required - set(release_set))
    extra = sorted(set(release_set) - required)
    optional = set(source.get("optional") or [])
    copied, offenders = release_rules.copied_bytes(packages)
    linked_cache = sorted(name for name in offenders
                          if name.split("/")[0] not in release_rules.MUTABLE_ENTRIES)
    shared_cache = release_rules.shared_cache_files(packages)
    resume = packages / release_rules.WORKSPACE_PACKAGE
    store_set = release_rules.store_contents(store_modules) if store_modules else []
    return {
        "ok": (source.get("ok", False) and not missing and not linked_cache
               and not shared_cache and resume.is_symlink()
               and os.readlink(resume) == "../packages/agent-resume"),
        "source_ok": source.get("ok", False),
        "source": source.get("source"),
        "rule": source.get("rule"),
        "error": source.get("error"),
        "lock_sha256": source.get("lock_sha256"),
        "required_packages": len(required),
        "release_packages": len(release_set),
        "missing": missing[:5],
        "missing_count": len(missing),
        "extra": extra[:5],
        "extra_count": len(extra),
        "optional_packages": len(optional),
        "optional_missing": sorted(optional - set(release_set))[:5],
        "optional_missing_count": len(optional - set(release_set)),
        "foreign_packages": source.get("foreign"),
        "dev_packages": source.get("dev"),
        "store_packages": len(store_set) if store_modules else None,
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


def mcp_call(port: int, tool: str, arguments: dict, timeout: float = 30.0) -> dict:
    """One tool call of the node itself, over its own MCP."""
    base = f"http://127.0.0.1:{port}/mcp"

    def post(payload):
        request = urllib.request.Request(base, data=json.dumps(payload).encode(), method="POST",
                                         headers={"Content-Type": "application/json",
                                                  "Accept": "application/json, text/event-stream"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read(200000).decode(errors="replace")
        for line in body.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:].strip())
        return json.loads(body) if body.strip() else {}

    post({"jsonrpc": "2.0", "id": 1, "method": "initialize",
          "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                     "clientInfo": {"name": "acceptance", "version": "1"}}})
    try:
        post({"jsonrpc": "2.0", "method": "notifications/initialized"})
    except Exception:
        pass
    answer = post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                   "params": {"name": tool, "arguments": arguments}})
    return answer


def mesh_peer_hosts(answer: dict) -> list:
    """The host ids the mesh of this node sees."""
    hosts = set()

    def collect(data):
        if not isinstance(data, dict):
            return
        for entry in data.get("sessions", []) or []:
            host = (entry.get("address") or {}).get("hostId") if isinstance(entry, dict) else None
            if host:
                hosts.add(host)
        for entry in data.get("hosts", []) or []:
            host = entry.get("hostId") if isinstance(entry, dict) else entry
            if host:
                hosts.add(host)

    result = answer.get("result", {}) if isinstance(answer, dict) else {}
    collect(result.get("structuredContent"))
    for item in result.get("content", []) or []:
        if isinstance(item, dict) and item.get("type") == "text":
            try:
                collect(json.loads(item.get("text", "")))
            except Exception:
                continue
    return sorted(hosts)


def peer_reachability(port: int, peer_host: str) -> dict:
    """From this node to the second node: the calls the guard does not touch.

    The name of the local node is not a proof that the peer is reached. The
    peer must have answered: either the mesh of this node lists it, or the
    ledger of the fleet names it with the time of its answer.
    """
    result = {"tools": {}, "peer_answers": False, "guard_blocked": False,
              "mesh_peers": [], "peer_confirmed_at": None, "peer_status": None}
    for tool, arguments in (("fleet_node_info", {}), ("fleet_session_page", {"limit": 5}),
                            ("mesh_discover", {"limit": 12})):
        try:
            answer = mcp_call(port, tool, arguments)
        except Exception as error:
            result["tools"][tool] = {"error": str(error)[:160]}
            continue
        text = json.dumps(answer, ensure_ascii=False)
        blocked = "codex_quota_guard" in text
        result["tools"][tool] = {
            "answered": "result" in answer,
            "error": (answer.get("error") or {}).get("message", "")[:160] if answer.get("error") else "",
            "guard_blocked": blocked,
        }
        if blocked:
            result["guard_blocked"] = True
        if tool == "mesh_discover":
            result["mesh_peers"] = mesh_peer_hosts(answer)
    confirmation = fleet_confirmation(port)
    nodes = confirmation.get("nodes") if isinstance(confirmation, dict) else None
    if isinstance(nodes, list):
        for node in nodes:
            if node.get("hostId") == peer_host:
                result["peer_confirmed_at"] = node.get("confirmedAt")
                result["peer_status"] = node.get("status")
    if peer_host:
        result["peer_answers"] = (peer_host in result["mesh_peers"]) or bool(result["peer_confirmed_at"])
    return result


def fleet_confirmation(port: int) -> dict:
    """The confirmation of the fleet: who holds the wanted revision, and when."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/settings/fleet-confirmation",
                                    timeout=30) as response:
            return json.loads(response.read(400000).decode())
    except urllib.error.HTTPError as error:
        return {"error": f"HTTP {error.code}"}
    except Exception as error:
        return {"error": str(error)[:160]}


def guard_policy(release: Path, node_bin: str = "/usr/local/bin/node", state_dir=None) -> dict:
    """The shipped guard: what it does to a session creation without a harness.

    The module of the release is asked, not the source of the repository: the
    verdict is proved on the code that runs. The verdict follows the policy of
    the node: while the protection of the owner is on, the guard must refuse a
    creation without a harness; while the owner has switched the protection
    off, the guard must let the creation pass. The probe reads the policy of
    the state directory of the node - the same file the service of the node
    reads - and names it in the result.
    """
    module = release / "dist" / "codex-quota-guard.js"
    if not module.is_file():
        return {"ok": False, "error": f"the release carries no guard: {module}"}
    # the specifier of an import must be a literal, so the module of the
    # release is loaded by a dynamic import; no top-level await, so the same
    # probe runs on the node 12 of a fleet node
    script = r"""
(async () => {
  const module = await import(process.argv[2]);
  const assertRemoteCodexAdmission = module.assertRemoteCodexAdmission;
  const reader = async () => ({});
  const out = {};
  try {
    const loaded = await module.loadCodexQuotaPolicy();
    out.policy = { path: module.codexQuotaPolicyPath(), enabled: loaded.policy.enabled, onUnknown: loaded.policy.onUnknown, minRemainingPercent: loaded.policy.minRemainingPercent, revision: loaded.revision };
  } catch (error) {
    out.policy = { error: String(error && error.message || error).slice(0, 200) };
  }
  for (const [name, args] of [["without harness", {}], ["harness opencode", { harness: "opencode" }], ["harness codex", { harness: "codex" }]]) {
    try {
      await assertRemoteCodexAdmission("fleet_create_session", args, reader);
      out[name] = { allowed: true };
    } catch (error) {
      out[name] = { allowed: false, code: error.code, message: String(error.message).slice(0, 200), decision: error.decision ? { allowed: error.decision.allowed, reason: error.decision.reason } : undefined };
    }
  }
  console.log(JSON.stringify(out));
})().catch((error) => { console.log(JSON.stringify({ error: String(error && error.message || error).slice(0, 200) })); });
"""
    path = Path("/tmp/acceptance-guard-probe.mjs")
    path.write_text(script, encoding="utf-8")
    environment = dict(os.environ)
    if state_dir is not None:
        environment["AGENT_HERDER_AUTOPILOT_STATE_DIR"] = str(state_dir)
    try:
        result = subprocess.run([node_bin, str(path), str(module)],
                                capture_output=True, text=True, check=False, timeout=30,
                                env=environment)
        data = json.loads(result.stdout.strip().splitlines()[-1])
    except Exception as error:
        return {"ok": False, "error": str(error)[:200]}
    policy = data.get("policy") or {}
    without = data.get("without harness", {})
    with_opencode = data.get("harness opencode", {})
    if policy.get("error"):
        ok = False
        expectation = f"the policy of the node is not readable: {policy.get('error')}"
    elif policy.get("enabled") is False:
        ok = without.get("allowed") is True and with_opencode.get("allowed") is True
        expectation = "the protection of the owner is off: the guard must let the creation pass"
    else:
        ok = (without.get("allowed") is False and without.get("code") == "codex_quota_guard"
              and with_opencode.get("allowed") is True)
        expectation = "the protection of the owner is on: the guard must refuse"
    return {
        "ok": ok,
        "expectation": expectation,
        "policy": policy,
        "without_harness": without,
        "with_opencode": with_opencode,
        "with_codex": data.get("harness codex", {}),
        "guard_module": str(module),
    }

def panel_session_creation(release: Path) -> dict:
    """Does the panel of this release create sessions, and with which harness?"""
    web = release / "dist" / "web"
    hits = []
    for path in sorted(web.rglob("*.js")):
        try:
            text = path.read_text(errors="replace")
        except OSError:
            continue
        for needle in ("new_or_resume", "create_session", "send_message"):
            if needle in text:
                hits.append(f"{path.relative_to(web).as_posix()}:{needle}")
    return {"panel_creates_sessions": bool(hits), "hits": hits[:10]}


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
    parser.add_argument("--store-node-modules", default="",
                        help="the store of this node: an observation, and the place the workspace "
                             "package must not come from; it is not the basis of the comparison "
                             "of the packages of the release")
    parser.add_argument("--releases-root", default="")
    parser.add_argument("--rollback-root", default="")
    parser.add_argument("--expect-host", default="", help="the host id this node must answer to")
    parser.add_argument("--peer-host", default="",
                        help="the host id of the second node: the one this node must reach")
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
    store_modules, store_origin = node_store_modules(arguments, release)

    process = find_running_process(release)
    properties = unit_properties(arguments.unit)
    payload = payload_check(release)
    bundle = bundle_check(release, arguments.sha)
    imports = import_check(release, arguments.node_bin)
    workspace = import_check_workspace(release, store_modules, arguments.node_bin)
    dependencies = dependency_check(release, store_modules)
    management = management_check(arguments.port, arguments.kind)
    reachability = peer_reachability(arguments.port, arguments.peer_host) if arguments.peer_host else {}
    confirmation = fleet_confirmation(arguments.port)
    guard = guard_policy(release, arguments.node_bin, state_dir)
    panel = panel_session_creation(release)
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
        ("the build payload of the release is the same on this node as on the builder",
         bundle.get("payload_ok", False),
         f"manifest={bundle.get('manifest_payload_fingerprint')} "
         f"recomputed={bundle.get('recomputed_payload_fingerprint')} files={bundle.get('payload_files')}"),
        ("the whole bundle of the node carries the fingerprint of the manifest",
         bundle.get("whole_ok", False) if arguments.kind == "owner" else True,
         f"manifest={bundle.get('manifest_fingerprint')} recomputed={bundle.get('recomputed_fingerprint')} "
         f"files={bundle.get('files')}"
         + ("" if arguments.kind == "owner"
            else " (the package farm of a fleet node is its own: the whole bundle is the property of the node)")),
        ("the manifest is the one of this head", bundle.get("source_sha_ok", False),
         f"{bundle.get('source_sha')} vs {arguments.sha}"),
        ("every import of the runtime resolves from the release", imports.get("ok", False),
         f"modules={imports.get('modules')} imports={imports.get('imports')} from_release={imports.get('from_release')} "
         f"from_store={imports.get('from_store')} builtins={imports.get('builtins')} "
         f"outside={len(imports.get('outside', []))} "
         f"unresolved={len(imports.get('unresolved', []))} "
         f"(release={imports.get('unresolved_release')}, store={imports.get('unresolved_store')}) "
         f"store_packages={imports.get('store_packages')} resolutions={imports.get('resolutions')} "
         f"truncated={imports.get('truncated')}"
         + (f" error={imports.get('error')}" if imports.get("error") else "")),
        ("the area offers the packages of the store to the resolver of Node",
         imports.get("area_package_root_ok", True),
         (f"state={(imports.get('area_package_root') or {}).get('state')} "
          f"points_at_store={(imports.get('area_package_root') or {}).get('points_at_store')}; "
          f"the store offers its packages: "
          f"state={(imports.get('store_package_root') or {}).get('state')}")
         if imports.get("area_package_root")
         else "the release carries no shared store: the root of the area is not its source"),
        ("the workspace package is imported from the release", workspace.get("ok", False),
         f"{workspace.get('imported_package')} inside={workspace.get('inside_release')} "
         f"from_store={workspace.get('imports_store_package')} "
         f"tree_ok={workspace.get('imported_tree_sha256') == workspace.get('release_tree_sha256')}"
         + (f" error={workspace.get('error')}" if workspace.get("error") else "")),
        ("the tool caches of the release are its own bytes (nlink=1)",
         dependencies.get("cache_owns_its_bytes", False),
         f"shared with the store: {dependencies.get('shared_cache_files', []) or 'none'}"),
        ("the release carries the full set of the build of the manifest, nothing copied",
         dependencies.get("ok", False),
         f"node={identity['hostname']} truth={dependencies.get('source')} "
         f"({dependencies.get('rule')}) "
         f"required={dependencies.get('required_packages')} "
         f"release={dependencies.get('release_packages')} "
         f"missing={dependencies.get('missing_count')} extra={dependencies.get('extra_count')} "
         f"copied={dependencies.get('copied_bytes')} B (only the tool caches of the store) "
         f"the store of the node="
         f"{dependencies.get('store_packages') if dependencies.get('store_packages') is not None else 'not named'} "
         f"({store_origin}, not the basis of the comparison)"
         + (f" error={dependencies.get('error')}" if dependencies.get("error") else "")),
        ("the management answers", all(value == 200 for value in management.values()),
         " ".join(f"{name}={value}" for name, value in management.items())),
        ("the automation prohibition is armed, by state, scope and mechanism",
         lever.get("ok", False),
         f"state={lever.get('state')} scope={lever.get('scope')} mechanism={lever.get('mechanism')} "
         f"changedBy={lever.get('changed_by')} live={lever.get('live_decision')}"
         + (f" error={lever.get('error')}" if lever.get("error") else "")),
        ("from this node the second node is reachable (the calls the guard does not touch)",
         bool(reachability) and all(tool.get("answered") for tool in reachability.get("tools", {}).values())
         and not reachability.get("guard_blocked")
         and (not arguments.peer_host or reachability.get("peer_answers")),
         f"peer={arguments.peer_host or 'any'} tools="
         + " ".join(f"{name}:{'ok' if tool.get('answered') else tool.get('error', 'no')}"
                    for name, tool in reachability.get("tools", {}).items())
         + f" guard_blocked={reachability.get('guard_blocked')}"
         + f" peer_answered={reachability.get('peer_answers')}"
         + f" peer_confirmed_at={reachability.get('peer_confirmed_at')}"
         + f" mesh_peers={reachability.get('mesh_peers')}"),
        ("the fleet names the nodes that hold the wanted revision",
         not confirmation.get("error") and bool(confirmation.get("nodes")),
         f"desiredRevision={confirmation.get('desiredRevision')} state={confirmation.get('state')} "
         f"confirmed={confirmation.get('confirmed')}/{confirmation.get('total')} "
         f"nodes=" + " ".join(f"{node.get('hostId')}:{node.get('status')}@{(node.get('confirmedAt') or 'нет')}"
                              for node in (confirmation.get("nodes") or []))
         + (f" error={confirmation.get('error')}" if confirmation.get("error") else "")),
        ("the guard of the release answers a session creation without a harness by the policy of the node",
         guard.get("ok", False),
         f"policy enabled={guard.get('policy', {}).get('enabled')} "
         f"at {guard.get('policy', {}).get('path')}; {guard.get('expectation')}; "
         f"without harness={guard.get('without_harness', {}).get('code')} "
         f"reason={(guard.get('without_harness', {}).get('decision') or {}).get('reason')} "
         f"with opencode allowed={guard.get('with_opencode', {}).get('allowed')}"),
        ("the release budget holds", budget.get("ok", False),
         f"directories={budget.get('directories')}/{MAX_RELEASES} "
         f"unique={budget.get('unique_mib')} MiB/{BUDGET_MIB} MiB (disk increment) "
         f"apparent={budget.get('apparent_mib')} MiB (the store counted again) "
         f"releases={budget.get('releases')} rollback={len(budget.get('rollback', []))} entries"),
    ]

    warnings = []
    if dependencies.get("extra_count"):
        warnings.append(
            f"node={identity['hostname']} the release carries {dependencies['extra_count']} packages beyond "
            f"the set of the build ({dependencies.get('source')}): {dependencies.get('extra')}; "
            f"the set of the build is the truth, the packages beyond it are named, not a refusal")
    if dependencies.get("optional_missing_count"):
        warnings.append(
            f"node={identity['hostname']} the release does not carry "
            f"{dependencies['optional_missing_count']} optional packages of this platform "
            f"({dependencies.get('optional_missing')}); an optional dependency is not part of the "
            f"guaranteed runtime set")
    if dependencies.get("store_packages") is None:
        warnings.append(
            f"node={identity['hostname']} the store of the node is not named; the workspace package "
            f"cannot be compared against it")

    failed = 0
    for name, ok, detail in checks:
        print(f"[{'OK ' if ok else 'FAIL'}] {name}: {detail}")
        failed += 0 if ok else 1
    for warning in warnings:
        print(f"[WARN] {warning}")
    summary = {
        "host": identity,
        "sha": arguments.sha,
        "kind": arguments.kind,
        "release": str(release),
        "release_size": release_size,
        "dependencies": dependencies,
        "store_origin": store_origin,
        "peer_reachability": reachability,
        "fleet_confirmation": confirmation,
        "guard_policy": guard,
        "panel_session_creation": panel,
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
