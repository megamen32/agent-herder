"""Fast Agent native hooks for Agent Herder coordination."""
from __future__ import annotations

import asyncio
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


def _api(path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    base = os.getenv("AGENT_HERDER_URL", "http://127.0.0.1:18787").rstrip("/")
    if payload is None:
        request = urllib.request.Request(f"{base}{path}")
    else:
        request = urllib.request.Request(
            f"{base}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
    with urllib.request.urlopen(request, timeout=1.2) as response:
        return json.loads(response.read().decode("utf-8"))


def _identity(ctx: Any) -> tuple[str, str] | None:
    manager = getattr(getattr(ctx, "context", None), "session_manager", None)
    current = getattr(manager, "current_session", None)
    info = getattr(current, "info", None)
    session_id = str(getattr(info, "name", "") or "")
    cwd = str(getattr(manager, "workspace_dir", "") or Path.cwd())
    return (session_id, cwd) if session_id else None


def _is_write_activity(tool: str, args: Any) -> bool:
    name = str(tool or "").lower()
    if re.search(r"(?:write|edit|patch|apply_patch|create_file|delete_file|move_file|rename_file)", name):
        return True
    if not re.search(r"(?:bash|shell|terminal|exec|command|execute)", name):
        return False
    command = args if isinstance(args, str) else str((args or {}).get("command") or (args or {}).get("cmd") or (args or {}).get("script") or "") if isinstance(args, dict) else ""
    patterns = (
        r"(?:^|[;&|\s])sed\s+-[^\n;]*\bi[^\n;]*",
        r"(?:^|[;&|\s])perl\s+-[^\n;]*\bi[^\n;]*",
        r"(?:^|[;&|\s])(?:tee|cp|mv|rm|touch|mkdir|truncate|install)(?:\s|$)",
        r"(?:^|[;&|\s])git\s+(?:checkout|restore|apply|mv|rm)(?:\s|$)",
        r"(?:^|[^<])>{1,2}\s*[^&]",
    )
    return any(re.search(pattern, command) for pattern in patterns)


def _paths(value: Any, found: set[str] | None = None) -> set[str]:
    found = found if found is not None else set()
    if isinstance(value, str):
        for match in re.finditer(r"\*\*\* (?:Update|Add|Delete) File:\s*([^\n]+)", value):
            found.add(match.group(1).strip())
        return found
    if isinstance(value, list):
        for item in value:
            _paths(item, found)
        return found
    if isinstance(value, dict):
        for key, item in value.items():
            if key.lower() in {"path", "file", "file_path", "filepath", "filename"} and isinstance(item, str):
                found.add(item)
            elif key.lower() in {"paths", "files"} and isinstance(item, list):
                found.update(path for path in item if isinstance(path, str))
            _paths(item, found)
    return found


def _tool_calls(ctx: Any) -> list[tuple[str, Any]]:
    calls = getattr(getattr(ctx, "message", None), "tool_calls", None) or {}
    result: list[tuple[str, Any]] = []
    for call in calls.values():
        params = getattr(call, "params", None)
        result.append((str(getattr(params, "name", "") or ""), getattr(params, "arguments", None)))
    return result


async def before_llm_call(ctx: Any) -> None:
    identity = _identity(ctx)
    if not identity:
        return
    session_id, cwd = identity
    try:
        query = urllib.parse.urlencode({"harness": "fast-agent", "sessionId": session_id, "cwd": cwd, "touch": "1"})
        data = await asyncio.to_thread(_api, f"/api/coordination/context?{query}")
        context = data.get("context")
        message = getattr(ctx, "message", None)
        if context and message is not None and context not in str(getattr(message, "all_text", lambda: "")()):
            message.add_text(str(context))
    except Exception:
        return


async def _tool_activity(ctx: Any) -> None:
    identity = _identity(ctx)
    if not identity:
        return
    session_id, cwd = identity
    found: set[str] = set()
    for tool, args in _tool_calls(ctx):
        if _is_write_activity(tool, args):
            found.update(_paths(args))
    clean = [path.removeprefix("./") for path in found if path and not path.startswith("../")][:32]
    try:
        await asyncio.to_thread(
            _api,
            "/api/coordination/activity",
            {"harness": "fast-agent", "sessionId": session_id, "cwd": cwd, "paths": clean},
        )
    except Exception:
        return


async def before_tool_call(ctx: Any) -> None:
    await _tool_activity(ctx)


async def after_tool_call(ctx: Any) -> None:
    await _tool_activity(ctx)
