#!/usr/bin/env python3
"""Run the isolated native CLI candidate stage, never attest a release."""
import json
import hashlib
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def run_zcode_candidate(*args, **kwargs):
    # The installed browser mode ships this same gate without the unrelated
    # isolated-candidate remote driver. Preserve that driver for its own mode.
    from zcode_candidate_remote import run_zcode_candidate as run
    return run(*args, **kwargs)


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
             'search_with_coverage', 'projects_with_provenance', 'reopen_without_resend',
             'vibe_session_visibility')
V1_NEGATIVE_CHECKS = ('wrong_instance_or_principal', 'same_key_no_replay',
                      'same_key_payload_conflict', 'unknown_after_restart_no_replay',
                      'human_stop_before_send')
V1_STATUSES = frozenset(('PASS', 'FAIL', 'BLOCKED', 'UNSUPPORTED', 'UNKNOWN'))



def validate_vibe_browser_evidence(evidence, harness, run_id, *, allow_owned_browser=False):
    """Bind visible canary and owner-native active catalog before any cleanup."""
    if not isinstance(evidence, dict):
        raise ValueError(f'V1 {harness} browser evidence missing or invalid')
    if evidence.get('transport') != 'vibe-mcp':
        raise ValueError(f'V1 {harness} browser evidence is not from Vibe')
    if evidence.get('run_id') != run_id or evidence.get('harness') != harness:
        raise ValueError(f'V1 {harness} browser evidence identity mismatch')
    scope = evidence.get('native_catalog_scope')
    owned_browser = scope == 'owned_current_conversations'
    completed_codex = scope == 'registered_canary_completed_turns'
    official_zcode = scope == 'pinned_official_server_owner'
    bounded = owned_browser or completed_codex or official_zcode
    if owned_browser and (not allow_owned_browser or harness not in ('chatgpt', 'zai')):
        raise ValueError('Owned conversation capability is limited to installed browser lanes')
    if completed_codex and (not allow_owned_browser or harness != 'codex'):
        raise ValueError('Completed native canary capability is limited to installed Codex lane')
    if official_zcode and (not allow_owned_browser or harness != 'zcode'):
        raise ValueError('Pinned official server capability is limited to installed ZCode lane')
    for field, expected in (
            ('control_scope', 'authorized_registered_sessions'),
            ('native_catalog_scope', scope if bounded else 'authorized_owner_active_sessions'),
            ('observation_phase', 'before_cleanup'),
            ('native_state_contract', 'AgentSession.status')):
        if evidence.get(field) != expected:
            raise ValueError(f'V1 {harness} browser evidence {field} missing or invalid')
    for field in ('instance_ref', 'core_session_ref', 'native_session_id',
                  'ui_native_session_id', 'native_receipt_ref', 'browser_snapshot_ref',
                  'native_catalog_ref', 'native_raw_state_ref'):
        value = evidence.get(field)
        if (not isinstance(value, str) or not 1 <= len(value) <= 2048
                or value != value.strip() or any(ord(char) < 32 for char in value)):
            raise ValueError(f'V1 {harness} browser evidence {field} missing or invalid')
    core = evidence['core_session_ref']
    native = evidence['native_session_id']
    if (not core.startswith('session:') or core == 'session:'
            or native.startswith('session:') or native != evidence['ui_native_session_id']):
        raise ValueError(f'V1 {harness} native/UI session identity mismatch')
    # Canonical AgentSession.status comes from the existing adapter. Keep the
    # provider's raw record in native_raw_state_ref; never infer status here.
    native_state, ui_state = evidence.get('native_state'), evidence.get('ui_state')
    if native_state not in ('idle', 'running', 'stopped') or ui_state != native_state:
        raise ValueError(f'V1 {harness} native/UI state missing, unknown or inconsistent')
    # Exact canary readback, not aggregate coverage of archived registry rows.
    if owned_browser:
        validate_owned_conversation_proof(evidence, harness)
    elif completed_codex:
        validate_completed_codex_proof(evidence)
    elif official_zcode:
        validate_official_zcode_proof(evidence)
    else:
        if evidence.get('native_coverage_complete') is not True:
            raise ValueError(f'V1 {harness} native coverage is incomplete')
        if evidence.get('native_catalog_complete') is not True:
            raise ValueError(f'V1 {harness} owner native active catalog is incomplete')
    visible_sets = {}
    for field in ('native_active_session_ids', 'ui_visible_session_ids'):
        values = evidence.get(field)
        if (not isinstance(values, list)
                or any(not isinstance(value, str) or not value.strip()
                       or value != value.strip() or any(ord(char) < 32 for char in value)
                       for value in values)
                or len(values) != len(set(values))):
            raise ValueError(f'V1 {harness} browser evidence {field} missing or invalid')
        visible_sets[field] = set(values)
    active = visible_sets['native_active_session_ids']
    if (owned_browser or completed_codex) and not active.issubset({native}):
        raise ValueError('Owned conversation evidence cannot claim a wider native inventory')
    visible = visible_sets['ui_visible_session_ids']
    # Read authority includes native active sessions absent from the control
    # registry. They must be visible; no registration or import is required.
    if native not in visible or not active.issubset(visible):
        raise ValueError(f'V1 {harness} exact native sessions are not visible in UI')
    native_states = evidence.get('native_active_states')
    ui_states = evidence.get('ui_session_states')
    if (not isinstance(native_states, dict) or set(native_states) != active
            or any(state not in ('running', 'needs_input') for state in native_states.values())
            or not isinstance(ui_states, dict)
            or ui_states.get(native) != ui_state
            or any(ui_states.get(session) != state for session, state in native_states.items())
            or (native in active and native_states[native] != native_state)):
        raise ValueError(f'V1 {harness} active native/UI states missing, unknown or inconsistent')


def validate_owned_conversation_proof(evidence, harness):
    from urllib.parse import urlsplit
    if (evidence.get('native_coverage_complete') is not False
            or evidence.get('native_catalog_complete') is not False
            or evidence.get('canary_native_coverage_complete') is not True
            or evidence.get('global_inventory_status') != 'UNVERIFIED'):
        raise ValueError('Owned conversation proof must preserve unverified global inventory')
    proof = evidence.get('native_owned_conversation_proof')
    if not isinstance(proof, dict) or proof.get('capability') != 'owned-current-conversation':
        raise ValueError('Exact owned native conversation capability proof required')
    account = proof.get('account_scope_sha256')
    if (not isinstance(account, str) or not re.fullmatch(r'[0-9a-f]{64}', account)
            or account != evidence.get('expected_account_scope_sha256')
            or not isinstance(proof.get('owned_page_namespace'), str)
            or not re.fullmatch(r'vibe-[0-9a-f]{64}', proof['owned_page_namespace'])
            or proof['owned_page_namespace'] != evidence.get('expected_owned_page_namespace')
            or proof.get('native_session_id') != evidence['native_session_id']
            or proof.get('canonical_status') != evidence['native_state']
            or type(proof.get('owned_page_id')) is not int or proof['owned_page_id'] < 1):
        raise ValueError('Owned native conversation account, page or state mismatch')
    for field in ('native_conversation_id', 'owned_page_url', 'source_route', 'owned_view_ref',
                  'native_messages_ref', 'dom_generation_state_ref', 'observed_at'):
        value = proof.get(field)
        if (not isinstance(value, str) or not 1 <= len(value) <= 2048 or value != value.strip()
                or any(ord(char) < 32 for char in value)):
            raise ValueError('Owned native conversation receipt missing or invalid')
    try:
        url = urlsplit(proof['owned_page_url'])
        if (url.scheme != 'https' or url.username or url.password or url.query or url.fragment
                or url.netloc != ('chatgpt.com' if harness == 'chatgpt' else 'chat.z.ai')
                or '/' in proof['native_conversation_id']
                or url.path != '/c/' + proof['native_conversation_id']
                or proof['source_route'] != proof['owned_page_url']):
            raise ValueError('Owned native page origin mismatch')
    except ValueError:
        raise ValueError('Owned native page origin invalid') from None
    if (proof['observed_at'] != evidence.get('native_observed_at')
            or type(evidence.get('native_observed_age_ms')) not in (int, float)
            or not -5000 <= evidence['native_observed_age_ms'] <= 30000):
        raise ValueError('Owned native conversation was not fresh at UI observation')


def validate_completed_codex_proof(evidence):
    from datetime import datetime
    proof = evidence.get('native_completed_turns_proof')
    if (evidence.get('native_coverage_complete') is not False
            or evidence.get('native_catalog_complete') is not False
            or evidence.get('canary_native_coverage_complete') is not True
            or evidence.get('global_inventory_status') != 'UNVERIFIED'
            or evidence.get('native_state') != 'idle'
            or evidence.get('native_active_session_ids') != []
            or not isinstance(proof, dict)
            or proof.get('capability') != 'registered-canary-completed-turns'
            or proof.get('source') != 'codex-native-thread-read-completion'
            or proof.get('native_session_id') != evidence['native_session_id']
            or proof.get('core_session_ref') != evidence['core_session_ref']
            or proof.get('cwd') != evidence.get('expected_cwd')
            or proof.get('canonical_status') != 'idle'):
        raise ValueError('Exact Codex canary completion proof required; global inventory stays unverified')
    for field in ('cwd', 'native_messages_ref', 'canonical_completion_ref', 'observed_at'):
        value = proof.get(field)
        if (not isinstance(value, str) or not 1 <= len(value) <= 2048 or value != value.strip()
                or any(ord(char) < 32 for char in value)):
            raise ValueError('Codex canonical completion receipt missing or invalid')
    if not proof['cwd'].startswith('/'):
        raise ValueError('Codex exact native cwd required')
    try:
        parsed = datetime.fromisoformat(proof['observed_at'].replace('Z', '+00:00'))
        if parsed.utcoffset() is None: raise ValueError()
    except (ValueError, TypeError):
        raise ValueError('Codex canonical observation timestamp invalid') from None
    if (proof['observed_at'] != evidence.get('native_observed_at')
            or type(evidence.get('native_observed_age_ms')) not in (int, float)
            or not -5000 <= evidence['native_observed_age_ms'] <= 30000):
        raise ValueError('Codex native proof was not fresh at UI observation')
    for field in ('completed_turn_ids', 'native_delivery_receipt_refs', 'native_delivery_receipt_ids'):
        values = proof.get(field)
        if (not isinstance(values, list) or len(values) != 2 or len(set(values)) != 2
                or any(not isinstance(value, str) or not value.strip() or value != value.strip()
                       or len(value) > 2048 or any(ord(char) < 32 for char in value) for value in values)):
            raise ValueError('Codex two distinct native turns and original receipts required')
    if proof.get('latest_turn_id') != proof['completed_turn_ids'][1]:
        raise ValueError('Codex exact latest completed turn required')
    for field in ('fingerprint', 'canonical_transcript_sha256'):
        if not isinstance(proof.get(field), str) or not re.fullmatch(r'[0-9a-f]{64}', proof[field]):
            raise ValueError('Codex complete canonical transcript digest required')


def validate_official_zcode_proof(evidence):
    from datetime import datetime
    proof = evidence.get('native_official_server_proof')
    if (evidence.get('native_coverage_complete') is not False
            or evidence.get('native_catalog_complete') is not False
            or evidence.get('canary_native_coverage_complete') is not True
            or evidence.get('official_owner_coverage_complete') is not True
            or evidence.get('global_inventory_status') != 'UNVERIFIED'
            or evidence.get('native_state') not in ('idle', 'stopped')
            or not isinstance(proof, dict) or proof.get('capability') != 'official-server-canary'
            or proof.get('source') != 'zcode-native-session-read+official-supervisor'
            or proof.get('native_session_id') != evidence['native_session_id']
            or proof.get('core_session_ref') != evidence['core_session_ref']
            or proof.get('cwd') != evidence.get('expected_cwd')
            or proof.get('host_id') != evidence.get('host_id')
            or proof.get('create_model') != evidence.get('expected_create_model')
            or proof.get('canonical_status') != evidence['native_state']
            or type(proof.get('official_pid')) is not int or proof['official_pid'] < 1
            or type(proof.get('official_generation')) is not int or proof['official_generation'] < 0):
        raise ValueError('Exact official ZCode canary proof required; global inventory stays unverified')
    for field in ('cwd', 'host_id', 'create_model', 'native_transcript_ref', 'official_before_ref', 'official_after_ref', 'observed_at'):
        value = proof.get(field)
        if (not isinstance(value, str) or not 1 <= len(value) <= 2048 or value != value.strip()
                or any(ord(char) < 32 for char in value)):
            raise ValueError('Official ZCode native receipt missing or invalid')
    if not proof['cwd'].startswith('/'):
        raise ValueError('Official ZCode exact native cwd required')
    if not re.fullmatch(r'[^/\s$]+/[^/\s$]+\$[^/\s$]+', proof['create_model']):
        raise ValueError('Official ZCode exact provider model and reasoning required')
    for field in ('completed_message_ids', 'user_message_ids', 'native_delivery_receipt_refs', 'native_delivery_receipt_ids'):
        values = proof.get(field)
        if (not isinstance(values, list) or len(values) != 2
                or any(not isinstance(value, str) or not value.strip() or value != value.strip()
                       or len(value) > 2048 or any(ord(char) < 32 for char in value) for value in values)
                or len(set(values)) != 2):
            raise ValueError('Official ZCode two distinct completed native messages and original receipts required')
    if not isinstance(proof.get('native_transcript_sha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', proof['native_transcript_sha256']):
        raise ValueError('Official ZCode complete native transcript digest required')
    if (proof['observed_at'] != evidence.get('native_observed_at')
            or type(evidence.get('native_observed_age_ms')) not in (int, float)
            or not -5000 <= evidence['native_observed_age_ms'] <= 15000
            or type(evidence.get('official_catalog_age_ms')) not in (int, float)
            or not -5000 <= evidence['official_catalog_age_ms'] <= 15000):
        raise ValueError('Official ZCode proof was not fresh at UI observation')
    try:
        dates = [datetime.fromisoformat(evidence[key].replace('Z', '+00:00')) for key in (
            'native_observed_at', 'official_catalog_observed_at', 'official_catalog_expires_at', 'ui_observed_at')]
        native, catalog, expires, ui = dates
        if (any(value.utcoffset() is None for value in dates) or expires <= ui
                or not 0 < (expires - catalog).total_seconds() <= 16
                or not -5 <= (ui - native).total_seconds() <= 15
                or not -5 <= (ui - catalog).total_seconds() <= 15):
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError):
        raise ValueError('Official ZCode observation and supervisor expiry invalid') from None


def validate_report_identity(report, expected):
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
    return run_id


INSTALLED_BROWSER_CHECKS = (
    'create', 'reply', 'continue_same_session', 'read_both',
    'vibe_session_visibility', 'open_details', 'owned_cleanup',
)


def validate_installed_browser_report(report, expected):
    """Production browser smoke; full candidate protocol negatives stay separate."""
    run_id = validate_report_identity(report, expected)
    if expected['stage'] != 'installed' or report.get('mode') != 'installed-browser':
        raise ValueError('Installed browser mode and stage required')
    for field in ('status', 'functional_status', 'identity', 'browser_cleanup'):
        if report.get(field) != 'PASS':
            raise ValueError(f'Installed browser {field} is not PASS')
    if report.get('transport_cleanup') == 'FAIL':
        raise ValueError('Installed browser transport cleanup failed')
    lanes = report.get('lanes')
    if not isinstance(lanes, dict) or set(lanes) != set(V1_HARNESSES):
        raise ValueError('Installed browser five lanes required')
    for harness in V1_HARNESSES:
        lane = lanes[harness]
        checks = lane.get('checks') if isinstance(lane, dict) else None
        if not isinstance(checks, dict) or any(checks.get(key) != 'PASS' for key in INSTALLED_BROWSER_CHECKS):
            raise ValueError(f'Installed browser {harness} checks incomplete')
        validate_vibe_browser_evidence(lane.get('browser_evidence'), harness, run_id, allow_owned_browser=True)
    inventory = 'UNVERIFIED' if any(lanes[h]['browser_evidence'].get('native_catalog_scope') != 'authorized_owner_active_sessions' for h in V1_HARNESSES) else 'VERIFIED'
    if report.get('global_inventory_status') != inventory:
        raise ValueError('Installed functional result must state independent inventory coverage')
    return {'status': 'PASS', 'functional_status': 'PASS', 'global_inventory_status': inventory,
            'stage': 'installed', 'mode': 'installed-browser'}


def validate_v1_report(report, expected):
    """Validate a stage report against caller-supplied run and artifact identities.

    Each lane is {"checks": {check_name: status}}. Only exact PASS for every
    required check permits the named stage; this never upgrades candidate to installed.
    """
    run_id = validate_report_identity(report, expected)
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
        validate_vibe_browser_evidence(lane.get('browser_evidence'), harness, run_id)
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


def _validate_v1_cli(args, validator=validate_v1_report):
    try:
        if len(args) != 2:
            raise ValueError('V1 requires report and expected identity files')
        result = validator(_v1_json(args[0]), _v1_json(args[1]))
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


def _installed_browser_cli(args):
    if len(args) != 4:
        print('Installed browser requires bundle, fixture, request and exclusive run root', file=sys.stderr)
        return 2
    bundle, fixture_path, request_path, run_root = args
    try:
        fixture = _v1_json(fixture_path)
        request = _v1_json(request_path)
        node = fixture['node_executable']
        if not isinstance(node, str) or not Path(node).is_absolute():
            raise ValueError('Installed browser pinned Node executable required')
        if hashlib.sha256(Path(node).read_bytes()).hexdigest() != fixture.get('node_sha256'):
            raise ValueError('Installed browser Node digest mismatch')
        if hashlib.sha256(Path(bundle).read_bytes()).hexdigest() != fixture.get('collector_sha256'):
            raise ValueError('Installed browser collector digest mismatch')
        completed = subprocess.run(
            [node, bundle, '--fixture', fixture_path, '--request', request_path, '--run-root', run_root],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=1800, check=False)
        if completed.returncode != 0:
            raise ValueError('Installed browser collector failed; protected receipt retained')
        expected = {'run_id': request['run_id'], 'source_sha': request['expected_source_sha'],
                    'artifact_sha256': fixture['expected_artifact_sha256'], 'stage': 'installed'}
        result = validate_installed_browser_report(_v1_json(Path(run_root) / 'report.json'), expected)
    except (ValueError, KeyError, OSError, subprocess.TimeoutExpired):
        print('Installed browser verification failed; protected receipt retained', file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--installed-browser':
        return _installed_browser_cli(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == '--validate-installed-browser':
        return _validate_v1_cli(sys.argv[2:], validate_installed_browser_report)
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
