from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import threading
import time
from contextvars import ContextVar
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parents[3]
_CURRENT_SESSION: ContextVar[str] = ContextVar("agent_herder_autopilot_session", default="")
_TURN = 0
_CTX: Any = None
_SOURCE_BY_SESSION: dict[str, dict[str, Any]] = {}
_GATEWAY_BY_SESSION: dict[str, tuple[Any, Any, Any]] = {}
_ENABLED: set[str] = set()


def _invoke(payload: dict[str, Any]) -> dict[str, Any]:
    command = ["bash", str(_ROOT / "scripts" / "autopilot-command-launcher.sh"), json.dumps(payload, separators=(",", ":"))]
    env = {**os.environ, "PLUGIN_ROOT": str(_ROOT)}
    result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=45, check=True)
    return json.loads(result.stdout)


def _command(raw_args: str) -> str:
    action = (raw_args.strip().split() or ["on"])[0].lower()
    if action not in {"on", "status", "off"}:
        return "Использование: /autopilot [on|status|off]"
    session_id = _CURRENT_SESSION.get()
    if not session_id:
        return "Hermes ещё не передал ID текущей сессии; отправьте обычное сообщение и повторите /autopilot."
    result = _invoke({"command": action, "harness": "hermes", "sessionId": session_id, "cwd": os.getcwd()})
    if action == "on":
        _ENABLED.add(session_id)
    elif action == "off":
        _ENABLED.discard(session_id)
    return f"Autopilot {'включён' if result.get('enabled') else 'выключен'} для текущей Hermes-сессии ({session_id})."


def _on_session_start(session_id: str = "", **_: Any) -> None:
    _CURRENT_SESSION.set(str(session_id or ""))


def _on_pre_gateway_dispatch(event: Any = None, gateway: Any = None, **_: Any) -> None:
    if event is None or gateway is None:
        return
    source = getattr(event, "source", None)
    if source is None:
        return
    session_id = str(gateway._session_key_for_source(source))
    _CURRENT_SESSION.set(session_id)
    raw = source.to_dict()
    _SOURCE_BY_SESSION[session_id] = {
        "schema": "hermes.locator.v2",
        "session_key": session_id,
        "platform": raw.get("platform"),
        "chat_id": raw.get("chat_id"),
        "chat_type": raw.get("chat_type", "dm"),
        **{key: raw[key] for key in ("thread_id", "user_id", "user_id_alt", "scope_id", "prospective_thread_id", "profile") if raw.get(key)},
    }
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    _GATEWAY_BY_SESSION[session_id] = (gateway, source, loop)


def _after_turn(
    session_id: str = "",
    turn_id: str = "",
    user_message: str | None = None,
    assistant_response: str | None = None,
    **kwargs: Any,
) -> None:
    global _TURN
    current_session = str(session_id or _CURRENT_SESSION.get())
    if not current_session:
        return
    if current_session not in _ENABLED:
        try:
            status = _invoke({"command": "status", "harness": "hermes", "sessionId": current_session, "cwd": os.getcwd()})
        except Exception:
            return
        if not status.get("enabled"):
            return
        _ENABLED.add(current_session)
    _TURN += 1
    try:
        history = _session_history(current_session)
        last_user = user_message or next((str(item.get("content") or "") for item in reversed(history) if item.get("role") == "user"), None)
        last_assistant = assistant_response or next((str(item.get("content") or "") for item in reversed(history) if item.get("role") == "assistant"), None)
        result = _invoke({
            "command": "stop",
            "harness": "hermes",
            "sessionId": current_session,
            "turnId": str(turn_id or f"turn-{_TURN}"),
            "cwd": os.getcwd(),
            "lastUserMessage": last_user,
            "lastAssistantMessage": last_assistant,
        })
        if result.get("decision") == "continue" and result.get("next_goal"):
            next_goal = str(result["next_goal"])
            _deliver_goal(current_session, next_goal)
        elif result.get("decision") == "choice" and result.get("request_id"):
            threading.Thread(target=_await_choice, args=(current_session, str(result["request_id"])), daemon=True).start()
    except Exception:
        return


def _deliver_goal(session_id: str, next_goal: str) -> None:
    gateway_binding = _GATEWAY_BY_SESSION.get(session_id)
    if gateway_binding:
        gateway, source, loop = gateway_binding
        from gateway.platforms.base import MessageEvent, MessageType
        def enqueue() -> None:
            adapter = gateway._adapter_for_source(source)
            gateway._enqueue_fifo(
                session_id,
                MessageEvent(text=next_goal, message_type=MessageType.TEXT, source=source, internal=True),
                adapter,
            )
        if loop is not None and loop.is_running():
            loop.call_soon_threadsafe(enqueue)
        else:
            enqueue()
    elif _CTX is None or not _CTX.inject_message(next_goal, role="user"):
        _resume_cli_session(session_id, next_goal)


def _await_choice(session_id: str, request_id: str) -> None:
    choices_path = Path(os.getenv("AGENT_HERDER_AUTOPILOT_STATE_DIR", str(Path.home() / ".local/state/agent-herder/autopilot-live"))) / "choices.json"
    deadline = time.monotonic() + 7 * 24 * 60 * 60
    while time.monotonic() < deadline:
        try:
            data = json.loads(choices_path.read_text())
            record = next((item for item in data.get("requests", []) if item.get("requestId") == request_id), None)
            if record and record.get("status") == "resumed" and record.get("nextGoal"):
                _deliver_goal(session_id, str(record["nextGoal"]))
                return
            if record and record.get("status") in {"failed", "expired-needs-human"}:
                return
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass
        time.sleep(1)


def _session_history(session_id: str) -> list[dict[str, Any]]:
    try:
        from hermes_state import SessionDB
        db = SessionDB()
        value = db.get_messages_as_conversation(session_id)
        return value if isinstance(value, list) else []
    except Exception:
        return []


def _resume_cli_session(session_id: str, next_goal: str) -> bool:
    hermes = shutil.which("hermes")
    if not hermes:
        return False
    subprocess.Popen(
        [hermes, "chat", "--resume", session_id, "-q", next_goal],
        cwd=os.getcwd(), env=os.environ.copy(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return True


def register(ctx: Any) -> None:
    global _CTX
    _CTX = ctx
    ctx.register_command("autopilot", handler=_command, description="Включить Agent Herder autopilot для текущей сессии.", args_hint="[on|status|off]")
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_gateway_dispatch", _on_pre_gateway_dispatch)
    ctx.register_hook("post_llm_call", _after_turn)
