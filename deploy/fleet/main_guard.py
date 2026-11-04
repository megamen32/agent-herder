"""Deploy guard: only code merged into origin/main reaches the live Herder.

Owner rule: unmerged branches are blocked from the live Agent Herder.
Two checks, no flag bypass:
  1. the candidate commit is reachable from origin/main (after a fetch);
  2. the revision that actually runs now (live) is an ancestor of the candidate,
     so a rollout can never drop commits the live node already has.
Plus a reconciliation of the witnesses of the live revision:
node-config.json sourceSha, the 'current' symlink, the running process.

The only escape hatch is the environment variable EMERGENCY_ENV with a
non-empty reason; every use is appended to the rollout journal first.
"""
import json
import os
import re
import subprocess
import time
from pathlib import Path

EMERGENCY_ENV = "AGENT_HERDER_EMERGENCY_UNMERGED_ROLLOUT"
MAIN_REF = "refs/remotes/origin/main"
SHA_RE = re.compile(r"[a-f0-9]{40}")


class MainGuardError(RuntimeError):
    pass


def journal_path():
    return Path(os.environ.get("AGENT_HERDER_ROLLOUT_JOURNAL") or
                Path.home() / ".local/state/agent-herder/rollout-journal.jsonl")


def _git(base, *args):
    return subprocess.run(list(base) + list(args), capture_output=True, text=True, timeout=60)


def fetch_main(base):
    """Refresh origin/main; a stale local ref must never admit a rollout."""
    result = _git(base, "fetch", "--quiet", "origin", "+refs/heads/main:" + MAIN_REF)
    if result.returncode != 0:
        raise MainGuardError(
            "release_main_unverifiable: не удалось обновить origin/main / cannot fetch origin/main: "
            + result.stderr.strip()[:300])


def _is_ancestor(base, ancestor, descendant):
    result = _git(base, "merge-base", "--is-ancestor", ancestor, descendant)
    if result.returncode not in (0, 1):
        raise MainGuardError("release_revision_unknown: коммит неизвестен репозиторию / commit unknown to the repository: "
                             + ancestor[:12] + " " + descendant[:12] + " " + result.stderr.strip()[:200])
    return result.returncode == 0


def _log(base, spec, limit=15):
    out = _git(base, "log", "--oneline", "--no-decorate", "-n", str(limit), spec).stdout.strip()
    return out or "(none)"


def reconcile_live(config_sha, link_sha, process_sha=None):
    """The configured, linked and running revisions must be one revision."""
    seen = {"node-config sourceSha": config_sha, "current symlink": link_sha}
    if process_sha:
        seen["running process"] = process_sha
    if len(set(seen.values())) > 1:
        detail = ", ".join(name + "=" + str(value)[:12] for name, value in seen.items())
        raise MainGuardError(
            "release_live_revision_mismatch: фактическая живая ревизия расходится с node-config.json (" + detail + "). "
            "Исправь node-config.json или перезапусти юнит на нужной ревизии. / "
            "The running revision disagrees with node-config.json (" + detail + "). "
            "Fix node-config.json or restart the unit on the intended release, then retry.")


def revision_mismatch_message(config_sha, expected_sha):
    return ("release_revision_changed_since_admission: node-config.json sourceSha=" + str(config_sha)[:12]
            + ", фактическая ревизия / actual live revision=" + str(expected_sha)[:12]
            + ". Расхождение: исправь node-config.json или перезапусти юнит, затем повтори. / "
            "Mismatch: fix node-config.json or restart the unit on the intended release, then retry.")


def sha_of_release_path(text):
    match = re.search(r"/releases/([a-f0-9]{40})(?:/|$)", text or "")
    return match.group(1) if match else None


def _violation(base, live_sha, candidate_sha):
    """Return (code, message) for the first violated rule, or None."""
    if not _is_ancestor(base, candidate_sha, MAIN_REF):
        extra = _log(base, MAIN_REF + ".." + candidate_sha)
        return ("release_candidate_not_in_main",
                "ОТКАЗ: ветка не влита в main, сделай PR. / REFUSED: the branch is not merged into origin/main, open a PR.\n"
                "Коммиты вне main / commits not in main:\n" + extra)
    if live_sha and not _is_ancestor(base, live_sha, candidate_sha):
        extra = _log(base, candidate_sha + ".." + live_sha)
        return ("release_candidate_would_discard_live_commits",
                "ОТКАЗ: в live есть коммиты, которых нет в main: влей их, потом выкатывай. / "
                "REFUSED: live has commits that are not in the candidate (main): merge them first, then roll out.\n"
                "Коммиты live без кандидата / live commits missing from the candidate:\n" + extra)
    return None


def check_deployable(base, live_sha, candidate_sha, fetch=True):
    """Raise MainGuardError unless candidate is in origin/main and descends from live."""
    for sha in (candidate_sha, live_sha):
        if sha and not SHA_RE.fullmatch(sha):
            raise RuntimeError("release_revision_invalid")
    if fetch:
        fetch_main(base)
    problem = _violation(base, live_sha, candidate_sha)
    if problem is None:
        return
    code, message = problem
    reason = os.environ.get(EMERGENCY_ENV, "").strip()
    if reason:
        path = journal_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a") as handle:
                handle.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                         "event": "emergency_unmerged_rollout", "rule": code,
                                         "live": live_sha, "candidate": candidate_sha,
                                         "reason": reason, "user": os.environ.get("USER", "")}) + "\n")
        except OSError as error:
            raise MainGuardError(code + ": " + message + "\nаварийный журнал недоступен / emergency journal unwritable: " + str(error))
        print("WARNING: emergency override " + EMERGENCY_ENV + " journaled: " + code)
        return
    raise MainGuardError(code + ": " + message)
