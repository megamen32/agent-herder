#!/usr/bin/env python3
"""Run the isolated native CLI candidate stage, never attest a release."""
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from zcode_candidate_remote import run_zcode_candidate


def write_receipt(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', dir=path.parent, prefix='.ci-', delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream)
    os.replace(temporary, path)


def invalidate_receipt(path):
    write_receipt(path, {'cli_candidate': 'INCOMPLETE', 'release': 'INCOMPLETE'})


def validate_zcode_candidate(report, payload_digest):
    if (not isinstance(report, dict) or report.get('scope') != 'isolated-candidate-only'
            or report.get('status') != 'PASS' or report.get('artifact_consistent') is not True
            or report.get('artifact_sha256') != payload_digest):
        raise ValueError('ZCode candidate payload or scoped result invalid')
    rows = [x for x in report.get('reports', []) if isinstance(x, dict) and x.get('scope') == 'zcode-official-project']
    if len(rows) != 1:
        raise ValueError('ZCode native scenario missing or duplicated')
    row = rows[0]
    sessions, pages = row.get('sessions'), row.get('transcriptPages')
    if (not isinstance(row.get('version'), str) or not row['version']
            or type(row.get('fixtureRequests')) is not int or row['fixtureRequests'] < 2
            or not isinstance(sessions, list) or len(sessions) != 2
            or any(not isinstance(s, str) or not s for s in sessions) or sessions[0] == sessions[1]
            or not isinstance(pages, list) or len(pages) != 2
            or any(type(n) is not int or n < 2 for n in pages)
            or any(row.get(key) is not True for key in ('sessionsCreated', 'sessionsListed',
                   'sessionsSearched', 'projectListed', 'answer', 'transcriptComplete'))):
        raise ValueError('ZCode native journey incomplete')
    return row


def validate_cli_candidate(report, sha, returncode):
    if returncode != 2 or not isinstance(report, dict):
        raise ValueError('candidate runner failed or did not return INCOMPLETE')
    if report.get('scope') != 'isolated-candidate' or report.get('status') != 'INCOMPLETE':
        raise ValueError('candidate scope or status invalid')
    if (report.get('candidate_bundle') or {}).get('source_sha') != sha:
        raise ValueError('candidate source identity mismatch')
    if not {'installed-process', 'other-required-environments'}.issubset(set(report.get('missing', []))):
        raise ValueError('full release limitations missing')
    rows = report.get('journeys')
    if not isinstance(rows, list) or len(rows) != 2 or {r.get('harness') for r in rows if isinstance(r, dict)} != {'codex', 'opencode'}:
        raise ValueError('required CLI journey missing or duplicated')
    versions = report.get('cli_versions') or {}
    for row in rows:
        h = row['harness']
        sessions = row.get('sessions')
        if (row.get('status') != 'INCOMPLETE' or row.get('searchProven') is not True
                or type(row.get('fixtureRequests')) is not int or row['fixtureRequests'] < 2
                or not isinstance(versions.get(h), str) or not versions[h]
                or not isinstance(sessions, list) or len(sessions) != 2):
            raise ValueError(f'{h} CLI scenario incomplete')
        if (any(not isinstance(s, dict) or not isinstance(s.get('id'), str) or not s['id']
                or type(s.get('pages')) is not int or s['pages'] < 2 for s in sessions)
                or sessions[0]['id'] == sessions[1]['id']):
            raise ValueError(f'{h} sessions or transcript incomplete')
    return {'cli_candidate': 'PASS', 'release': 'INCOMPLETE', 'report': report}


V1_HARNESSES = ('chatgpt', 'zai', 'opencode', 'codex', 'zcode')
V1_CHECKS = ('create', 'second_deliver_same_session', 'read_both', 'export_native_complete',
             'search_with_coverage', 'projects_with_provenance', 'reopen_without_resend')
V1_NEGATIVE_CHECKS = ('wrong_instance_or_principal', 'same_key_no_replay',
                      'same_key_payload_conflict', 'unknown_after_restart_no_replay',
                      'human_stop_before_send')
V1_STATUSES = frozenset(('PASS', 'FAIL', 'BLOCKED', 'UNSUPPORTED', 'UNKNOWN'))


def validate_v1_report(report, expected):
    """Validate a stage report against caller-supplied run and artifact identities.

    Each lane is {"checks": {check_name: status}}. Only exact PASS for every
    required check permits the named stage; this never upgrades candidate to installed.
    """
    if not isinstance(expected, dict) or not isinstance(report, dict):
        raise ValueError('V1 report and expected identity must be objects')
    run_id = expected.get('run_id')
    if (not isinstance(run_id, str) or not 1 <= len(run_id) <= 128
            or any(ord(char) < 32 for char in run_id)):
        raise ValueError('V1 expected run_id invalid')
    for key, pattern in (('source_sha', r'(?:[0-9a-f]{40}|[0-9a-f]{64})'),
                         ('artifact_sha256', r'[0-9a-f]{64}')):
        value = expected.get(key)
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            raise ValueError(f'V1 expected {key} invalid')
    if expected.get('stage') not in ('candidate', 'installed'):
        raise ValueError('V1 expected stage invalid')
    for key in ('run_id', 'source_sha', 'artifact_sha256', 'stage'):
        if report.get(key) != expected[key]:
            raise ValueError(f'V1 {key} mismatch')
    lanes = report.get('lanes')
    if not isinstance(lanes, dict):
        raise ValueError('V1 lanes missing or invalid')
    for harness in V1_HARNESSES:
        lane = lanes.get(harness)
        checks = lane.get('checks') if isinstance(lane, dict) else None
        if not isinstance(checks, dict):
            raise ValueError(f'V1 {harness} checks missing or invalid')
        for check in V1_CHECKS:
            state = checks.get(check)
            if not isinstance(state, str) or state not in V1_STATUSES:
                raise ValueError(f'V1 {harness}.{check} missing or invalid')
            if state != 'PASS':
                raise ValueError(f'V1 {harness}.{check} is {state}')
    negative = report.get('negative_checks')
    if not isinstance(negative, dict):
        raise ValueError('V1 negative_checks missing or invalid')
    for check in V1_NEGATIVE_CHECKS:
        state = negative.get(check)
        if not isinstance(state, str) or state not in V1_STATUSES:
            raise ValueError(f'V1 negative_checks.{check} missing or invalid')
        if state != 'PASS':
            raise ValueError(f'V1 negative_checks.{check} is {state}')
    return {'status': 'PASS', 'stage': expected['stage']}


def _v1_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('duplicate key')
            result[key] = value
        return result
    try:
        with open(path, 'rb') as stream:
            data = stream.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError('too large')
        return json.loads(data, object_pairs_hook=unique)
    except (OSError, ValueError, UnicodeError, RecursionError):
        raise ValueError('V1 input is unreadable or invalid JSON') from None


def _validate_v1_cli(args):
    try:
        if len(args) != 2:
            raise ValueError('V1 requires report and expected identity files')
        result = validate_v1_report(_v1_json(args[0]), _v1_json(args[1]))
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--validate-v1':
        return _validate_v1_cli(sys.argv[2:])
    if len(sys.argv) != 6:
        raise ValueError('expected release, SHA, Codex binary, OpenCode binary and receipt')
    release, sha, codex, opencode, receipt = sys.argv[1:]
    invalidate_receipt(receipt)
    base = Path(__file__).resolve().parent
    command = [sys.executable, str(base / 'launch.py'), '--candidate', release, '--',
               sys.executable, str(base / 'candidate_stand.py'), release, codex, opencode]
    start = time.monotonic()
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180, check=False)
    try:
        report = json.loads(result.stdout)
        output = validate_cli_candidate(report, sha, result.returncode)
        zcode_report, digest = run_zcode_candidate(release, sha)
        validate_zcode_candidate(zcode_report, digest)
    except (ValueError, TypeError) as error:
        raise ValueError(f'CLI candidate gate failed: {error}; {result.stderr[-1200:]}') from error
    output['zcode_candidate'] = 'PASS'
    output['zcode_report'] = zcode_report
    output['elapsed_seconds'] = round(time.monotonic() - start, 3)
    path = Path(receipt)
    write_receipt(path, output)
    print(f"Codex/OpenCode/ZCode candidate PASS; full release INCOMPLETE; receipt {path}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
