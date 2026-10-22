#!/usr/bin/env python3
"""Move the herder's own environment into herder.env - one editable file per product.

Today the live unit sources seven files: startup.env, opencode.env, herder.env,
minimax/env, /etc/omniroute.env, agent-resume/hermes.env (a drop-in) and
autopilot.env (a drop-in). After this transfer the unit sources exactly one:
herder.env. The keys are moved, not copied into a second place of truth: the
source files stay untouched on disk and keep their own owners.

The judge base URL is part of the transfer because requiredEnv throws without
it - a herder that starts without it dies immediately.

Dry run is the default and prints key names, source files and the target, never
a value. --apply performs the transfer atomically and keeps a timestamped
backup of the previous herder.env.

Three rules the owner set:
  F1  every foreign env reference of the unit is retired, hermes.env included -
      otherwise the unit keeps a second source for keys herder.env now owns;
  F2  the dry run prints a second list: the keys that are present in the source
      files but are not transferred (names only, they keep their owner);
  F3  a value that differs in herder.env is NOT overwritten: the script reports
      the key and stops. Only an explicit --force overwrites.
"""
import argparse
import os
from pathlib import Path
import shutil
import sys
import time

TARGET = Path("~/.config/agent-herder/herder.env")
UNIT = Path("~/.config/systemd/user/agent-herder.service")
DROP_INS = Path("~/.config/systemd/user/agent-herder.service.d")

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

# Where the keys come from, and the env files the unit must stop sourcing.
SOURCES = (
    "~/.config/agent-herder/autopilot.env",
    "~/.config/agent-herder/opencode.env",
    "~/.config/openchamber/startup.env",
    "~/.config/minimax/env",
    "/etc/omniroute.env",
    "~/.config/agent-resume/hermes.env",
)
FOREIGN_FILES = (
    "~/.config/openchamber/startup.env",
    "~/.config/agent-herder/opencode.env",
    "~/.config/minimax/env",
    "/etc/omniroute.env",
    "~/.config/agent-resume/hermes.env",
    "~/.config/agent-herder/autopilot.env",
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


def collect() -> tuple:
    """(transferred values, keys present in the sources but not transferred)."""
    found = {}
    present = {}
    for source in SOURCES:
        path = Path(source).expanduser()
        for name, value in read_env(path).items():
            if name in KEYS:
                if name not in found:
                    found[name] = (path, value)
            else:
                present.setdefault(name, path)
    return found, present


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


def foreign_references() -> list:
    """Every foreign env reference of the unit and of its drop-ins."""
    references = []
    unit = UNIT.expanduser()
    if unit.is_file():
        for line in unit.read_text().splitlines():
            if line.startswith("EnvironmentFile=") and "agent-herder/herder.env" not in line:
                references.append((unit, line.split("=", 1)[1].strip()))
    directory = DROP_INS.expanduser()
    if directory.is_dir():
        for path in sorted(directory.glob("*.conf")):
            for line in path.read_text().splitlines():
                if line.startswith("EnvironmentFile="):
                    references.append((path, line.split("=", 1)[1].strip()))
    return references


def apply_transfer(found: dict, force: bool) -> int:
    target = TARGET.expanduser()
    current = read_env(target) if target.is_file() else {}
    conflicts = [name for name, (_, value) in found.items()
                  if name in current and current[name] != value]
    if conflicts and not force:
        print("refusing to overwrite, the value differs in herder.env: " + ", ".join(sorted(conflicts)))
        print("re-run with --force to overwrite exactly these keys")
        return 1
    if conflicts:
        print("forced overwrite of: " + ", ".join(sorted(conflicts)))

    lines = target.read_text().splitlines() if target.is_file() else []
    order = []
    for line in lines:
        if "=" in line and not line.strip().startswith("#"):
            name = line.split("=", 1)[0].strip()
            if name not in order:
                order.append(name)
    for name in found:
        if name not in order:
            order.append(name)

    backup = target.with_name(target.name + ".bak-" + time.strftime("%Y%m%dT%H%M%S"))
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if target.is_file():
        shutil.copy2(target, backup)
        os.chmod(backup, 0o600)

    rendered = []
    for name in order:
        if name in found:
            rendered.append(f"{name}={found[name][1]}")
            continue
        for line in lines:
            if "=" in line and line.split("=", 1)[0].strip() == name:
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


def retire_foreign_references() -> int:
    """F1: the unit must source herder.env only."""
    stamp = time.strftime("%Y%m%dT%H%M%S")
    unit = UNIT.expanduser()
    if unit.is_file():
        kept, dropped = [], []
        for line in unit.read_text().splitlines():
            if line.startswith("EnvironmentFile=") and "agent-herder/herder.env" not in line:
                dropped.append(line)
                continue
            kept.append(line)
        if dropped:
            backup = unit.with_name(unit.name + ".bak-" + stamp)
            shutil.copy2(unit, backup)
            os.chmod(backup, 0o600)
            unit.write_text("\n".join(kept) + "\n")
            print(f"unit: dropped {len(dropped)} foreign EnvironmentFile line(s), backup {backup}")
    directory = DROP_INS.expanduser()
    if directory.is_dir():
        for path in sorted(directory.glob("*.conf")):
            lines = path.read_text().splitlines()
            kept = [line for line in lines
                    if not (line.startswith("EnvironmentFile=") and "agent-herder/herder.env" not in line)]
            if len(kept) == len(lines):
                continue
            backup = path.with_name(path.name + ".bak-" + stamp)
            shutil.copy2(path, backup)
            os.chmod(backup, 0o600)
            if kept and any(line.strip() and not line.startswith("[") for line in kept):
                path.write_text("\n".join(kept) + "\n")
                print(f"drop-in: trimmed {path.name}, backup {backup}")
            else:
                path.unlink()
                print(f"drop-in: retired {path.name} -> {backup}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="perform the transfer (default: dry run)")
    parser.add_argument("--force", action="store_true", help="overwrite a differing value in herder.env")
    arguments = parser.parse_args()

    found, present = collect()
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
            state = "differs (not overwritten without --force)"
        else:
            state = "add"
        print(f"  {name:<45} {str(source):<50} {state}")
    for name, path, readable in token_files(found):
        print(f"  token file {name:<45} {str(path):<50} {'readable' if readable else 'NOT READABLE'}")

    print("present in the source files, not transferred (their owner keeps them):")
    for name in sorted(present):
        print(f"  {name:<45} {present[name]}")
    print("foreign env references of the unit that will be retired:")
    for path, reference in foreign_references():
        print(f"  {reference:<50} {path}")

    if missing:
        print("refusing to continue, no source for: " + ", ".join(missing))
        return 1
    if not arguments.apply:
        print("dry run - nothing was written")
        return 0
    status = apply_transfer(found, arguments.force)
    if status != 0:
        return status
    retire_foreign_references()
    return 0


if __name__ == "__main__":
    sys.exit(main())
