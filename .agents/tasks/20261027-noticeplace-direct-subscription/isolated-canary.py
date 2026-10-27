#!/usr/bin/env python3
"""One non-replayable, isolated Notice Place -> native Herder business canary.

The source is a loopback HTTP service backed by a disposable marker. Notice
storage, credentials, callbacks, Herder state and the verifier are isolated.
Only the official existing OpenCode transport/provider is shared. No message
or call adapter is constructed. An existing run.json prohibits another run.
"""
import concurrent.futures
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
TASK = ROOT / ".tmp/notice-direct-20261027"
CONTROL = TASK / "isolated-control"
FIXTURE = TASK / "fixture"
PROJECT = "noticeplace-qa-direct-20261027"
MODEL = "minimax-coding-plan/MiniMax-M3.1-Flash"
SOURCE = "notice-direct-loopback-service"


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    path.chmod(0o600)


def main():
    CONTROL.mkdir(parents=True, exist_ok=True)
    CONTROL.chmod(0o700)
    guard = CONTROL / "run.json"
    resume = "--resume-pre-admission" in sys.argv
    if guard.exists() and not resume:
        raise SystemExit("Existing canary receipt: read it; accepted/UNKNOWN input must not be replayed")
    run = json.loads(guard.read_text()) if resume else {"phase": "preparing", "project": PROJECT, "source_id": SOURCE, "started_at": time.time()}
    if resume:
        attempts = json.loads((CONTROL / "qa-attempts.json").read_text())
        recorded = [a for project in attempts["projects"].values() for group in project.values() for a in group]
        if not recorded or any(a.get("outcome") != "pre_admission_rejected" or a.get("delivery") != "not_attempted" or a.get("created") is not False for a in recorded):
            raise SystemExit("Resume requires durable rejection before admission; accepted/UNKNOWN input must not replay")
        if (CONTROL / "qa-attempts-auth-fixed.json").exists():
            raise SystemExit("Post-repair admission already attempted; inspect receipt without replay")
    save(guard, run)
    FIXTURE.mkdir(parents=True, exist_ok=True)
    marker = FIXTURE / "state.txt"
    if not resume:
        marker.write_text("degraded\n")
    source_sha = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT.parent / "noticeplace", text=True).strip()
    runtime = CONTROL / "notice-runtime"
    runtime.mkdir(exist_ok=resume)
    archive = subprocess.Popen(["git", "archive", source_sha, "notification_center", "mcp"], cwd=ROOT.parent / "noticeplace", stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", str(runtime)], stdin=archive.stdout, check=True)
    archive.stdout.close()
    if archive.wait() != 0:
        raise RuntimeError("Notice Place immutable QA package failed")
    sys.path.insert(0, str(runtime))
    from notification_center.core import NotificationCenter
    from notification_center.http_api import DeliveryWorker, build_handler
    from notification_center.gptadmin_agent import _agent_job_event
    from notification_center.agent_job_helper import run_profile

    class SourceHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            healthy = marker.read_text().strip() == "healthy"
            self.send_response(200 if healthy else 503)
            self.end_headers()
            self.wfile.write(("healthy" if healthy else "degraded").encode())

        def log_message(self, *_args):
            pass

    source_port = int(run["source_url"].split(":")[2].split("/")[0]) if resume else 0
    source = http.server.ThreadingHTTPServer(("127.0.0.1", source_port), SourceHandler)
    threading.Thread(target=source.serve_forever, daemon=True).start()
    source_url = f"http://127.0.0.1:{source.server_port}/health"
    fingerprint = hashlib.sha256((SOURCE + source_url).encode()).hexdigest()
    (FIXTURE / "README.md").write_text(
        "# Разрешённый изолированный QA-ремонт\n\n"
        "Это отдельный тестовый сервис; пользователь разрешил исправить только его. "
        "Сервис читает state.txt в этой папке: degraded даёт HTTP 503, healthy даёт HTTP 200. "
        f"Его текущий адрес: {source_url}.\n"
        "Восстановление: запиши healthy с переводом строки в state.txt и проверь HTTP. "
        "Не меняй другие файлы, процессы, проекты, токены или глобальные настройки. "
        "Вопрос человеку не нужен. О завершении сообщи по-русски в этой же сессии; "
        "независимый verifier сам проверит HTTP и закроет изолированный инцидент.\n"
    )
    producer = json.loads((CONTROL / "callback.json").read_text())["tokens"][PROJECT] if resume else secrets.token_urlsafe(32)
    launch = json.loads((CONTROL / "bootstrap.json").read_text())["launchToken"] if resume else secrets.token_urlsafe(32)
    center = NotificationCenter(CONTROL / "notice.sqlite3", {producer: {
        "project": PROJECT, "max_severity": "critical", "agent_jobs": ["health-diagnosis"],
        "automatic_health_diagnosis": True,
    }}, default_quiet_hours=[])
    api_port = int(run["qa_notice_url"].rsplit(":", 1)[1]) if resume else 0
    api = http.server.ThreadingHTTPServer(("127.0.0.1", api_port), build_handler(center, secrets.token_urlsafe(32), secrets.token_urlsafe(32)))
    threading.Thread(target=api.serve_forever, daemon=True).start()
    api_url = f"http://127.0.0.1:{api.server_port}"
    save(CONTROL / "callback.json", {"url": api_url, "tokens": {PROJECT: producer}})
    save(CONTROL / "bootstrap.json", {"launchToken": launch, **({"attemptLog": "qa-attempts-auth-fixed.json"} if resume else {})})
    policy = json.loads((TASK / "policy-proposed.json").read_text())
    policy.update(allowedHarnesses=["opencode"], preferredHarness="opencode", models={"opencode": MODEL}, fallbackModels={})
    policy["projectRoutes"] = {str(FIXTURE): {"harnesses": ["opencode"], "models": {"opencode": MODEL}, "allowedModels": [MODEL], "aliases": [PROJECT]}}
    save(CONTROL / "qa-policy.json", policy)
    pid = subprocess.check_output(["systemctl", "--user", "show", "agent-herder.service", "-p", "MainPID", "--value"], text=True).strip()
    live_env = dict(entry.split("=", 1) for entry in Path("/proc", pid, "environ").read_bytes().decode().split("\0") if "=" in entry)
    env = os.environ.copy()
    for key in ("OPENCODE_URL", "OPENCODE_SERVER_PASSWORD", "MINIMAX_API_KEY"):
        if key in live_env:
            env[key] = live_env[key]
    argv = Path("/proc", pid, "cmdline").read_bytes().decode().split("\0")
    release = Path(argv[1]).parent.parent
    env["GPTADMIN_HEALTH_CALLBACK_FILE"] = str(CONTROL / "callback.json")
    log = (CONTROL / "herder.log").open("w")
    (CONTROL / "qa-herder-ready.json").unlink(missing_ok=True)
    qa = subprocess.Popen(["/usr/local/bin/node", str(Path(__file__).with_name("qa-herder.mjs")), str(CONTROL), str(release)], cwd=CONTROL, env=env, stdout=log, stderr=subprocess.STDOUT)
    native_receipt = {}
    try:
        for _ in range(40):
            if (CONTROL / "qa-herder-ready.json").exists():
                break
            if qa.poll() is not None:
                raise RuntimeError("isolated Herder exited before readiness")
            time.sleep(1)
        ready = json.loads((CONTROL / "qa-herder-ready.json").read_text())
        herder_url = f"http://127.0.0.1:{ready['port']}"
        os.environ["NOTIFY_HEALTH_REMEDIATION_URL"] = herder_url + "/api/sessions/new-or-resume"
        os.environ["GPTADMIN_HEALTH_CALLBACK_FILE"] = str(CONTROL / "callback.json")

        def request(path, body=None, key="", base=api_url):
            data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
            req = urllib.request.Request(base + path, data=data, headers={"Authorization": "Bearer " + producer, "Content-Type": "application/json", "Idempotency-Key": key})
            with urllib.request.urlopen(req, timeout=20) as response:
                return json.load(response)

        profile = {"url": herder_url + "/api/sessions/new-or-resume", "harness": "opencode", "name": "notice-direct-isolated-qa", "cwd": str(FIXTURE), "mode": "queue", "instruction": "Repair only the isolated original source.", "model": MODEL, "health_launch_token": launch, "callback_file": str(CONTROL / "callback.json"), "diagnosis_timeout_seconds": "180", "poll_seconds": "1"}

        class LocalProductHelper:
            def send_with_progress(self, payload, key, progress_callback=None):
                event = _agent_job_event("health-diagnosis", payload)

                def started(receipt):
                    native_receipt.update(receipt)
                    save(CONTROL / "native-admission.json", receipt)
                    if progress_callback:
                        progress_callback({"status": "running", "agent_receipt": receipt, "job_id": key})

                result = run_profile("health-diagnosis", event, CONTROL / "unused.json", profile_override=profile, session_callback=started)
                native_receipt.update(result)
                save(CONTROL / "native-result.json", result)
                return {"status": result.get("status", "completed"), "agent_receipt": result, "job_id": key}

        worker = DeliveryWorker(center, None, agent_jobs={"health-diagnosis": LocalProductHelper()})
        event = {"schema": "notify.event.v1", "kind": "incident", "event_type": "health.degraded", "project": PROJECT, "recipient": "isolated-qa", "severity": "important", "title": "Изолированный QA-сервис отвечает HTTP 503", "body": f"Тестовый сервис {source_url} отвечает degraded. В разрешённой папке {FIXTURE} есть README.md с минимальным исправлением state.txt. Ремонтировать только этот изолированный сервис. Независимый verifier закроет инцидент после HTTP 200.", "dedup_key": "notice-direct-isolated-20261027", "source_id": SOURCE, "host_id": "isolated-loopback", "signal_type": "qa-http", "source_fingerprint": fingerprint, "correlation_id": "notice-direct-isolated-20261027", "evidence_refs": [source_url, str(FIXTURE / "README.md")]}
        created = None if resume else request("/v1/events", event, "notice-direct-isolated-intake-20261027")
        incident_id = run["incident_id"] if resume else created["incident_id"]
        run.update(phase="incident-created", incident_id=incident_id, notice_source_sha=source_sha, herder_release=release.name, source_url=source_url, qa_herder_url=herder_url, qa_notice_url=api_url)
        save(guard, run)
        claimed = worker.claim_due(limit=1, channel_group="agent")
        if len(claimed) != 1:
            raise RuntimeError("isolated event did not schedule exactly one agent delivery")
        run.update(phase="native-launching", delivery_id=claimed[0]["id"])
        save(guard, run)
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        future = executor.submit(worker.deliver, claimed[0])
        deadline = time.monotonic() + 210
        healthy = False
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(source_url, timeout=2) as response:
                    healthy = response.status == 200 and response.read() == b"healthy"
            except urllib.error.HTTPError:
                pass
            if healthy or future.done():
                break
            time.sleep(1)
        if not healthy:
            if future.done():
                future.result()
            run.update(phase="not-repaired", native=native_receipt)
            save(guard, run)
            raise RuntimeError("isolated source was not independently healthy; preserve receipt and do not replay")
        verification_id = "notice-direct-verifier-20261027"
        verification = request(f"/v1/incidents/{incident_id}/health/verification", {"source_id": SOURCE, "verification_id": verification_id, "observed_state": "healthy", "fingerprint": fingerprint, "actor": "qa-independent-http-verifier", "evidence_refs": [source_url]}, "notice-direct-verify-20261027")
        resolved = request(f"/v1/incidents/{incident_id}/health/resolve", {"source_id": SOURCE, "verification_id": verification_id, "actor": "qa-independent-http-verifier", "trace_refs": [source_url]}, "notice-direct-resolve-20261027")
        future.result(timeout=45)
        final = request(f"/v1/incidents/{incident_id}")
        rows = center._connection.execute("SELECT channel,status FROM deliveries").fetchall()
        run.update(phase="verified", native=native_receipt, verification=verification, resolution=resolved, final_state=final.get("state"), deliveries=[dict(row) for row in rows], independent_http_healthy=healthy, phone_adapters=0, production_events=0)
        save(guard, run)
        print(json.dumps(run, ensure_ascii=False))
        assert run["final_state"] in {"resolved", "closed"}
        assert native_receipt.get("autopilot_armed") is True
        executor.shutdown(wait=True)
    finally:
        qa.terminate()
        try:
            qa.wait(timeout=10)
        except subprocess.TimeoutExpired:
            qa.kill()
        source.shutdown()
        api.shutdown()
        log.close()


if __name__ == "__main__":
    main()
