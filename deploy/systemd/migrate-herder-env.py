#!/usr/bin/env python3
"""Move the values the herder needs into the file of the herder product.

The herder reads one file of its own: ~/.config/agent-herder/herder.env. The
values it needs that today live in the files of other products are COPIED
into that file; the files of the other products are never written and never
removed. The unit of the herder stops sourcing them, so the isolation of the
products holds and the function of the herder does not break.

The script is idempotent: a second run changes nothing and reports the keys
as already transferred. With -n it writes nothing at all and only reports
what it would do.

The script never prints a value. It prints the NAMES of the keys it moves.
"""
from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

# The file of the product. Every value the herder needs ends up here.
DEFAULT_ENV_FILE = Path.home() / ".config" / "agent-herder" / "herder.env"

# The unit of the herder. It sources only the file of the product.
DEFAULT_UNIT_FILE = Path.home() / ".config" / "systemd" / "user" / "agent-herder.service"

# The keys the herder reads, and the file each of them lives in today. The
# keys of the other products that the herder does not read are not here and
# are not moved.
SOURCES: tuple[tuple[Path, tuple[str, ...]], ...] = (
    (
        Path.home() / ".config" / "agent-herder" / "opencode.env",
        ("OPENCODE_SERVER_PASSWORD",),
    ),
    (
        Path.home() / ".config" / "agent-herder" / "autopilot.env",
        (
            "AGENT_HERDER_AUTOPILOT_JUDGE_BASE_URL",
            "AGENT_HERDER_AUTOPILOT_JUDGE_MODEL",
            "AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN_FILE",
            "AGENT_HERDER_UNFINISHED_JUDGE_BASE_URL",
            "AGENT_HERDER_UNFINISHED_JUDGE_MODEL",
            "AGENT_HERDER_UNFINISHED_JUDGE_PROTOCOL",
            "AGENT_HERDER_UNFINISHED_JUDGE_REASONING_EFFORT",
            "AGENT_HERDER_UNFINISHED_JUDGE_TOKEN_FILE",
        ),
    ),
    (
        Path.home() / ".config" / "minimax" / "env",
        ("MINIMAX_API_KEY",),
    ),
    (
        Path("/etc/omniroute.env"),
        ("OMNIROUTE_API_KEY",),
    ),
    (
        Path.home() / ".config" / "agent-resume" / "hermes.env",
        ("AGENT_RESUME_HERMES_ENDPOINT", "AGENT_RESUME_HERMES_TOKEN"),
    ),
)

# The keys the code reads, but that are optional and have no value today.
#
# If one of them ever gets a value in a file of another product, the transfer
# becomes mandatory: the value would be lost in silence. The dry-run reports
# every such key by name, so that nothing is swallowed silently.
OPTIONAL_NOT_TRANSFERRED = (
    "AGENT_HERDER_AUTOPILOT_JUDGE_TOKEN",
    "AGENT_HERDER_UNFINISHED_JUDGE_TOKEN",
    "AGENT_HERDER_UNFINISHED_JUDGE_ANTHROPIC_BASE_URL",
    "AGENT_HERDER_UNFINISHED_JUDGE_ENABLED",
    "AGENT_HERDER_UNFINISHED_JUDGEMENTS_PER_CYCLE",
)

# The lines of the unit that would compete with the file of the product. The
# value of the model of the judge must live in one place, and that place is
# herder.env: the unit says a different value, and the file of the product
# would win silently.
CONFLICTING_UNIT_LINES = ("Environment=AGENT_HERDER_UNFINISHED_JUDGE_MODEL=",)

# The files the unit of the herder must not source any more: they belong to
# the other products of the contour, or they are a second file of the herder.
FOREIGN_ENV_FILES = (
    "%h/.config/openchamber/startup.env",
    "%h/.config/agent-herder/opencode.env",
    "%h/.config/agent-herder/autopilot.env",
    "%h/.config/agent-herder/noticeplace.env",
    "%h/.config/agent-resume/hermes.env",
    "%h/.config/minimax/env",
    "/etc/omniroute.env",
    "/etc/notification-center.env",
)

# The one file of the product the unit sources.
PRODUCT_ENV_FILE = "%h/.config/agent-herder/herder.env"


def parse_env_file(text: str) -> dict[str, str]:
    """The values of an environment file, by the name of the key."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].lstrip()
        separator = stripped.find("=")
        if separator <= 0:
            continue
        key = stripped[:separator].strip()
        value = stripped[separator + 1 :].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def quote_env_value(value: str) -> str:
    """The value of a key as it is written into an environment file."""
    if value and all(character.isalnum() or character in "_@%+=:,./-" for character in value):
        return value
    escaped = value.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$")
    return f'"{escaped}"'


def render_env_file(values: dict[str, str]) -> str:
    """The environment file of the product, with one key per line."""
    return "".join(f"{key}={quote_env_value(value)}\n" for key, value in values.items())


def write_file_atomically(path: Path, text: str, mode: int) -> None:
    """Write a file through a temporary file of the same directory."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(text)
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def collect_moves(env_file: Path) -> tuple[dict[str, str], list[str], list[str]]:
    """The values to move, the names moved and the names already in place."""
    current = parse_env_file(env_file.read_text(encoding="utf-8")) if env_file.exists() else {}
    moved: dict[str, str] = {}
    names: list[str] = []
    already: list[str] = []
    for source, keys in SOURCES:
        if not source.exists():
            continue
        values = parse_env_file(source.read_text(encoding="utf-8"))
        for key in keys:
            if key not in values:
                continue
            value = values[key]
            if not value:
                continue
            if current.get(key) == value:
                already.append(key)
                continue
            moved[key] = value
            names.append(key)
    return moved, names, already


def collect_optional_present() -> list[str]:
    """The optional keys that have a value in a file of another product.

    The names only: the values of the other products are never printed.
    """
    present: list[str] = []
    for source, _keys in SOURCES:
        if not source.exists():
            continue
        values = parse_env_file(source.read_text(encoding="utf-8"))
        for key in OPTIONAL_NOT_TRANSFERRED:
            if values.get(key) and key not in present:
                present.append(key)
    return present


def clean_unit(text: str) -> tuple[str, list[str]]:
    """The unit without the references to the files of the other products."""
    kept: list[str] = []
    removed: list[str] = []
    has_product_file = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(CONFLICTING_UNIT_LINES):
            removed.append(stripped.rsplit("=", 1)[0] + "=...")
            continue
        if stripped.startswith("EnvironmentFile="):
            path = stripped.split("=", 1)[1].lstrip("-")
            if path in FOREIGN_ENV_FILES:
                removed.append(path)
                continue
            if path == PRODUCT_ENV_FILE:
                if has_product_file:
                    continue
                has_product_file = True
        kept.append(line)
    if not has_product_file:
        anchor = next(
            (index for index, line in enumerate(kept) if line.startswith("Environment=OPENCODE_URL=")),
            len(kept),
        )
        kept.insert(anchor, f"EnvironmentFile=-{PRODUCT_ENV_FILE}")
    return "\n".join(kept) + "\n", removed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-n", "--dry-run", action="store_true", help="only report what would be done")
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE, help="the file of the product")
    parser.add_argument("--unit-file", type=Path, default=DEFAULT_UNIT_FILE, help="the unit of the herder")
    parser.add_argument(
        "--unit-dropin-dir",
        type=Path,
        default=None,
        help="the directory of the drop-ins of the unit (default: next to the unit)",
    )
    arguments = parser.parse_args()

    env_file = arguments.env_file
    unit_file = arguments.unit_file
    dropin_dir = arguments.unit_dropin_dir or unit_file.with_name(f"{unit_file.name}.d")

    moved, names, already = collect_moves(env_file)
    removed: list[tuple[str, str]] = []

    # The unit of the herder and its drop-ins: the files of the other products
    # are sourced from both places, and the product must source only its own
    # file from both.
    targets: list[Path] = [unit_file]
    if dropin_dir.exists():
        targets.extend(sorted(path for path in dropin_dir.glob("*.conf") if path.is_file()))

    if arguments.dry_run:
        print("Сухой запуск: ничего не записано.")
        for path in targets:
            if not path.exists():
                continue
            _, entries = clean_unit(path.read_text(encoding="utf-8"))
            removed.extend((path.name, entry) for entry in entries)
    else:
        if moved:
            current = parse_env_file(env_file.read_text(encoding="utf-8")) if env_file.exists() else {}
            current.update(moved)
            write_file_atomically(env_file, render_env_file(current), 0o600)
        for path in targets:
            if not path.exists():
                continue
            original = path.read_text(encoding="utf-8")
            cleaned, entries = clean_unit(original)
            removed.extend((path.name, entry) for entry in entries)
            if cleaned != original:
                backup = path.with_name(f"{path.name}.bak-isolation-{time.strftime('%Y%m%dT%H%M%S')}")
                shutil.copy2(path, backup)
                write_file_atomically(path, cleaned, path.stat().st_mode & 0o777)

    print("Перенесённые ключи:")
    for key in names:
        print(f"  {key}")
    optional_present = collect_optional_present()
    if optional_present:
        print("Присутствуют, но не переносятся (значение в файле другого продукта — перенос обязателен):")
        for key in optional_present:
            print(f"  {key}")
    if already:
        print("Уже были в файле продукта:")
        for key in already:
            print(f"  {key}")
    if removed:
        print("Убраны ссылки юнита на файлы чужих продуктов:")
        for name, entry in removed:
            print(f"  {name}: {entry}")
    print(f"Файл продукта: {env_file}")
    print(f"Юнит: {unit_file}")
    print("Осталось за рантайм-владельцем: daemon-reload и рестарт сервиса.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
