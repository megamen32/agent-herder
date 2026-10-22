#!/usr/bin/env python3
"""Move the herder's own environment into herder.env - one editable file per product.

Today the live unit sources seven files: startup.env, opencode.env, herder.env,
minimax/env, /etc/omniroute.env, agent-resume/hermes.env (a drop-in) and
autopilot.env (a drop-in). After this transfer the unit sources exactly one:
herder.env.

The keys are moved, not copied into a second place of truth: the source files
stay untouched on disk and keep their own owners. The judge base URL is part of
the transfer because requiredEnv throws without it - a herder that starts
without it dies immediately.

Dry run is the default and prints key names, source files and the target, never
a value. --apply performs the transfer atomically and keeps a timestamped
backup of the previous herder.env.
"""
import argparse
import os
from pathlib import Path
import shutil
import sys
import time

TARGET = Path("~/.config/agent-herder/herder.env")

# The 13 keys herder reads itself. Nothing else is moved: a key herder does not
# read keeps its owner and its file.
KEYS = (
    "AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL",
    "AGENT_HERDER_AUTOPILOT_JUDGE_MODEL",
    "AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN_FILE",
    "AGENT_HERDER_UNFINISHED_JUDGE_PROTOCOL",
    "AGENT_HERDER_UNFINISHED_JUDGE_BASE_URL",
    "AGENT_HERDER_UNFINISHED_JUDGE_MODEL",
    "AGENT_HERDER_UNFINISHED_JUDGE_REASONING_EFFORT",
    "AGENT_HERDER_UNFINISHED_JUDGE_TOKEN_FILE",
    "OPENCODE_SERVER_PASSWORD",
    "MINIMAX_API_KEY",
    "OMNIROUTE_API_KEY",
    "AGENT_RESUME_HERMES_ENDPOINT",
    "AGENT_RESUME_HERMES_TOKEN",
)

SOURCES = (
    "~/.config/agent-herder/autopilot.env",
    "~/.config/agent-herder/opencode.env",
    "~/.config/openchamber/startup.env",
    "~/.config/minimax/env",
    "/etc/omniroute.env",
    "~/.config/agent-resume/hermes.env",
)


def read_env(path: Path) -> dict:
    values = {}
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            values[name.strip()] = value.strip()
    except OSError:
        return {}
    return values


def collect() -> dict:
    """key -> (source path, value); the first source that defines the key wins."""
    found = {}
    for source in SOURCES:
        path = Path(source).expanduser()
        for name, value in read_env(path).items():
            if name in KEYS and name not in found:
                found[name] = (path, value)
    return found


def token_files(found: dict) -> list:
    """The token files the transferred keys point at, without reading them."""
    result = []
    for name, (_, value) in sorted(found.items()):
        if not name.endswith("_TOKEN_FILE"):
            continue
        path = Path(value)
        readable = path.is_file() and os.access(path, os.R_OK)
        result.append((name, path, readable))
    return result


def apply_transfer(found: dict) -> int:
    target = TARGET.expanduser()
    lines = target.read_text().splitlines() if target.is_file() else []
    values = {}
    order = []
    for line in lines:
        if "=" in line and not line.strip().startswith("#"):
            name = line.split("=", 1)[0].strip()
            if name not in values:
                order.append(name)
    for name, (_, value) in found.items():
        if name not in order:
            order.append(name)

    backup = target.with_suffix(".env.bak-" + time.strftime("%Y%m%dT%H%M%S"))
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if target.is_file():
        shutil.copy2(target, backup)
        os.chmod(backup, 0o600)

    rendered = []
    for name in order:
        if name in found:
            rendered.append(f"{name}={found[name][1]}")
        else:
            for line in lines:
                if line.split("=", 1)[0].strip() == name and "=" in line:
                    rendered.append(line)
                    break
    temporary = target.with_name(target.name + ".tmp")
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write("\n".join(rendered) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, target)
    print(f"written: {target} (backup {backup})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="perform the transfer (default: dry run)")
    arguments = parser.parse_args()

    found = collect()
    target = TARGET.expanduser()
    current = read_env(target) if target.is_file() else {}
    missing = [name for name in KEYS if name not in found]

    print(f"target: {target}")
    print(f"keys  : {len(KEYS)}")
    for name in KEYS:
        source, _ = found.get(name, (None, None))
        if source is None:
            state = "MISSING"
        elif name in current and current[name] == found[name][1]:
            state = "already in herder.env"
        elif name in current:
            state = "update"
        else:
            state = "add"
        print(f"  {name:<45} {str(source):<50} {state}")
    for name, path, readable in token_files(found):
        print(f"  token file {name:<45} {str(path):<50} {'readable' if readable else 'NOT READABLE'}")

    if missing:
        print("refusing to continue, no source for: " + ", ".join(missing))
        return 1
    if not arguments.apply:
        print("dry run - nothing was written")
        return 0
    return apply_transfer(found)


if __name__ == "__main__":
    sys.exit(main())
