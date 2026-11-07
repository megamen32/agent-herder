#!/usr/bin/env python3
"""Run the isolated native CLI candidate stage, never attest a release."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


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


def main():
    if len(sys.argv) != 6:
        raise ValueError('expected release, SHA, Codex binary, OpenCode binary and receipt')
    release, sha, codex, opencode, receipt = sys.argv[1:]
    base = Path(__file__).resolve().parent
    command = [sys.executable, str(base / 'launch.py'), '--candidate', release, '--',
               sys.executable, str(base / 'candidate_stand.py'), release, codex, opencode]
    start = time.monotonic()
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=180, check=False)
    try:
        report = json.loads(result.stdout)
        output = validate_cli_candidate(report, sha, result.returncode)
    except (ValueError, TypeError) as error:
        raise ValueError(f'CLI candidate gate failed: {error}; {result.stderr[-1200:]}') from error
    output['elapsed_seconds'] = round(time.monotonic() - start, 3)
    path = Path(receipt)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile('w', dir=path.parent, prefix='.ci-', delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(output, stream)
    os.replace(temporary, path)
    print(f"CLI candidate PASS; full release INCOMPLETE; receipt {path}")
    return 0


if __name__ == '__main__':
    sys.exit(main())
