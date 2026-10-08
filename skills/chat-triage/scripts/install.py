#!/usr/bin/env python3
"""Install chat cleanup extensions without changing automation or databases."""
import argparse
import os
from pathlib import Path
import sys

def install(skill, home):
    skill = skill.resolve(strict=True)
    if not (skill / "SKILL.md").is_file():
        raise ValueError("skill source is missing")
    targets = [(home / ".codex/skills/chat-triage", skill)]
    command = home / ".zcode/commands/chat-triage.md"
    # Inspect both targets before any mutation, preserving unrelated extensions.
    for target, source in targets:
        if target.exists() or target.is_symlink():
            if not target.is_symlink() or target.resolve() != source:
                raise ValueError("existing Codex skill belongs to another source")
    marker = "<!-- agent-herder:chat-triage -->"
    text = (f"---\ndescription: Tidy current Codex and ZCode chats and pins with Agent Herder.\n---\n\n"
            f"{marker}\n"
            f"Read the Agent Herder skill at [{skill / 'SKILL.md'}]({skill / 'SKILL.md'}).\n"
            "Use its compact task registry and planner. Keep unfinished or unknown tasks visible.\n"
            "Apply only the user's authorized sidebar metadata changes after fresh native checks.\n"
            "Do not resume, stop, delete chats, start autopilot, or send work prompts during cleanup.\n")
    if command.exists() and marker not in command.read_text():
        raise ValueError("existing ZCode command belongs to another source")
    for target, source in targets:
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_symlink():
            target.symlink_to(source, target_is_directory=True)
    command.parent.mkdir(parents=True, exist_ok=True)
    temporary = command.with_name(command.name + f".{os.getpid()}.tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
        os.replace(temporary, command)
    finally:
        temporary.unlink(missing_ok=True)
    return [str(target) for target, _ in targets] + [str(command)]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--home", type=Path, default=Path.home())
    args = parser.parse_args()
    try:
        for target in install(Path(__file__).resolve().parents[1], args.home.resolve()):
            print(target)
    except (ValueError, OSError) as error:
        print(f"chat-triage install: {error}", file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    sys.exit(main())
