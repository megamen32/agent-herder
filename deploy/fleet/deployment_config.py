"""Private operator configuration, never bundled into a portable release."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess

MAX_CONFIG = 131072

def unique_object(pairs):
    result = {}
    for key,value in pairs:
        if key in result:
            fail()
        result[key] = value
    return result

COMMON = {"id","kind","hostId","address","sshPort","sshUser","unit","webPort",
          "platform","uid","home","pythonBin","pythonVersion","pythonExecutable",
          "authorityTarget"}
FLEET = COMMON | {"fleetDir","stateDir","launchdDomain","restartCmd","authorityGroup"}
OWNER = COMMON | {"catalog","stateDir","workingDirectory","dropIn","restartCmd",
                  "harnesses","nodeBin","codexSocket","codexBin"}

def fail():
    raise RuntimeError("release_deployment_config_refused")

def absolute(value):
    if (not isinstance(value,str) or not value.startswith("/") or value == "/"
            or str(Path(value)) != value or ".." in Path(value).parts
            or any(ord(c)<32 for c in value)):
        fail()
    return value

def word(value, pattern=r"[A-Za-z0-9][A-Za-z0-9_.-]{0,252}"):
    if not isinstance(value,str) or not re.fullmatch(pattern,value):
        fail()
    return value

def validate_node(raw):
    if not isinstance(raw,dict) or raw.get("kind") != "fleet":
        fail()
    node = json.loads(json.dumps(raw))
    allowed = FLEET if node["kind"] == "fleet" else OWNER
    required = COMMON | ({"fleetDir","stateDir"} if node["kind"] == "fleet"
                         else {"catalog","stateDir","workingDirectory","dropIn"})
    if set(node)-allowed or not required <= set(node):
        fail()
    for key in ("id","hostId","address","sshUser","unit"):
        word(node[key])
    if node["platform"] not in ("linux","darwin"):
        fail()
    for key in ("sshPort","webPort"):
        if type(node[key]) is not int or not 1 <= node[key] <= 65535:
            fail()
    if type(node["uid"]) is not int or node["uid"] < 0:
        fail()
    for key in ("home","pythonBin","pythonExecutable","fleetDir","stateDir",
                "catalog","workingDirectory","dropIn","nodeBin","codexSocket","codexBin"):
        if key in node:
            absolute(node[key])
    if not re.fullmatch(r"3\.(?:1[0-9]|[2-9][0-9])\.[0-9]+",str(node["pythonVersion"])):
        fail()
    authority = node["authorityTarget"]
    if (not isinstance(authority,dict) or set(authority) != {"fleetDir","unit"}
            or authority["unit"] != node["unit"]):
        fail()
    absolute(authority["fleetDir"])
    if node["platform"] == "darwin":
        if node["kind"] != "fleet" or node.get("launchdDomain") not in (
                "user/"+str(node["uid"]), "gui/"+str(node["uid"])):
            fail()
        expected = "launchctl kickstart -k "+node["launchdDomain"]+"/"+node["unit"]
    else:
        if "launchdDomain" in node or not node["unit"].endswith(".service"):
            fail()
        expected = "systemctl --user restart "+node["unit"]
    if "restartCmd" in node and node["restartCmd"] != expected:
        fail()
    node["restartCmd"] = expected
    if "authorityGroup" in node:
        word(node["authorityGroup"])
    if "harnesses" in node:
        if not isinstance(node["harnesses"],list) or any(not isinstance(x,str) or not re.fullmatch(r"[a-z0-9_-]+",x) for x in node["harnesses"]):
            fail()
    return node

def descriptor_digest(node):
    normalized = validate_node(node)
    return hashlib.sha256(json.dumps(normalized,sort_keys=True,separators=(",",":")).encode()).hexdigest()

def verify_descriptor(node, expected):
    normalized = validate_node(node)
    if not isinstance(expected,str) or not re.fullmatch(r"[a-f0-9]{64}",expected) or descriptor_digest(normalized) != expected:
        raise RuntimeError("release_descriptor_binding_mismatch")
    return normalized

def private_json(path, outside_git=False):
    path = Path(path)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        fail()
    if outside_git:
        # Inspect markers rather than accepting any Git error as "outside".
        # This also rejects linked worktrees and bare repositories.
        for parent in (path.parent, *path.parent.parents):
            marker = parent / ".git"
            if (marker.exists() or marker.is_symlink()
                    or ((parent/"HEAD").is_file() and (parent/"objects").is_dir()
                        and (parent/"config").is_file())):
                fail()
    fd = os.open(path,os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > MAX_CONFIG):
            fail()
        data = os.read(fd,MAX_CONFIG+1)
        after = os.fstat(fd)
        identity = lambda x: (x.st_dev,x.st_ino,x.st_size,x.st_mtime_ns,x.st_ctime_ns,x.st_mode,x.st_uid)
        if len(data)>MAX_CONFIG or len(data) != info.st_size or identity(after) != identity(info):
            fail()
        return json.loads(data, object_pairs_hook=unique_object)
    finally:
        os.close(fd)

def load_config(path=None):
    selected = path or os.environ.get("AGENT_HERDER_DEPLOYMENT_CONFIG")
    if not selected:
        raise RuntimeError("release_deployment_config_required")
    value = private_json(Path(selected).expanduser().absolute(),outside_git=True)
    if not isinstance(value,dict) or set(value) != {"version","nodes"} or type(value["version"]) is not int or value["version"] != 1 or not isinstance(value["nodes"],list) or not value["nodes"]:
        fail()
    nodes = [validate_node(n) for n in value["nodes"]]
    for key in ("id","hostId","address"):
        if len({n[key] for n in nodes}) != len(nodes):
            fail()
    targets = {}
    groups = {}
    for node in nodes:
        authority_path = Path(node["authorityTarget"]["fleetDir"])
        if authority_path.resolve() != authority_path:
            fail()
        target = (str(authority_path),node["authorityTarget"]["unit"])
        group = node.get("authorityGroup")
        if group and group in groups and groups[group] != target:
            fail()
        if group:
            groups[group] = target
        if target in targets and (not group or targets[target] != group):
            fail()
        targets[target] = group
    return {"version":1,"nodes":nodes}

def load_remote_descriptor(path, expected):
    canonical = Path(path).resolve(strict=True)
    if canonical.name != "descriptor.json" or not re.fullmatch(r"/(?:private/)?tmp/herder-release\.[A-Za-z0-9]{8}", str(canonical.parent)):
        fail()
    info = canonical.parent.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        fail()
    value = private_json(canonical)
    return verify_descriptor(value,expected)
