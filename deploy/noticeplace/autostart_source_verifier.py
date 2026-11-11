#!/usr/bin/env python3
"""One source-check tick; official lifecycle SDK plus bounded native file reads.

No polling loop, harness activation, executor status, model call or message send.
An existing owner cycle may call run_tick; deployment/wiring is separate.
"""
from __future__ import annotations
import argparse
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.parse

PROJECT='agent-herder'
SOURCE='agent-herder-autostart'
SIGNAL='unfinished-session-autostart-failed'
# A refusal that was never submitted is a deferral, not a native failure. The
# producer emits it under its own signal type, and the source owns that class
# exactly like the exhausted one: it must be able to answer for it.
DEFERRAL_SIGNALS=('unfinished-session-quota-blocked','unfinished-session-not-submitted')
OWNED_SIGNALS=(SIGNAL,)+DEFERRAL_SIGNALS
MAX_JSON=8*1024*1024
MAX_TAIL=4*1024*1024
# The server gives a due check a deadline of 300 seconds and serves a due
# page of at most SWEEP_PAGE_SIZE (20) checks. The source answers every due
# check of one sweep in one tick, because a check that waits behind the
# others misses that deadline and the incident is delivered to an executor
# again with the health of the source still unknown.
#
# The admission is sized for the whole page, not for a fraction of it: every
# accepted answer moves a check to the tail of the (verification_due,
# incident_id) order, so the incident that the server re-armed most often is
# the one that is answered last. An admission below the page size truncates
# the sweep exactly there, and the truncated check waits for a later tick
# while its own deadline runs out.
#
# The batch stays bounded by the deadline instead of by the count: the
# owning cycle gives the tick 45 seconds, one check costs a local read and
# one HTTP round trip, and the admission deadline stops the batch long before
# that. The count only has to stay above what the deadline can still admit.
MAX_CHECKS_PER_TICK=40
TICK_DEADLINE_SECONDS=18

@dataclass(frozen=True)
class SourcePaths:
    autopilot: Path
    human_stops: Path
    codex: Path


def stamp(value):
    if not isinstance(value,str): raise ValueError('missing timestamp')
    parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
    if parsed.tzinfo is None: raise ValueError('timestamp has no timezone')
    return parsed.timestamp()


def identity(record):
    workspace=os.path.normpath(record.get('workspaceIdentity') or record['cwd'])
    return f"unfinished-{record['harness']}:{record['sessionId']}:{workspace}-{record['startedAt']}"


def failed_root_of(controls,interrupted_turn):
    """The native root turn of the interrupted turn.

    The record names the interrupted TURN, not the root it belongs to. A
    continuation runs under the root of the turn it continues, so the root is
    resolved from the native rollout itself instead of being assumed.
    """
    roots={event['payload'].get('root_turn_id') for _,event in controls
           if event['payload'].get('turn_id')==interrupted_turn and event['payload'].get('root_turn_id')}
    if len(roots)==1:return roots.pop()
    if roots:return None
    # The interrupted turn is the thread's own root: its own event may have
    # left the tail while the later turns still carry its root.
    if any(event['payload'].get('root_turn_id')==interrupted_turn for _,event in controls):
        return interrupted_turn
    return None


def signature(path):
    st=path.stat()
    return st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns


def thread_row(root,session_id):
    database=root/'state_5.sqlite'
    with closing(sqlite3.connect(database.as_uri()+'?mode=ro',uri=True,timeout=1)) as db:
        db.execute('PRAGMA query_only=ON')
        rows=db.execute('SELECT id,cwd,rollout_path,archived FROM threads WHERE id=?',(session_id,)).fetchall()
    if len(rows)!=1: raise ValueError('native thread not uniquely indexed')
    return rows[0]


def measure(group,paths,*,host_id,clock=time.time):
    """Fresh read of the ORIGINAL failed session, not its repair executor.

    Conservative Codex-only positive: exact native continuation root completed
    after the failure notice. Missing/removed episode or unsupported harness is
    unknown. Native completion proves resumed execution, not semantic task QA.
    """
    observed=clock()
    def result(state,reason):
        return {'observed_state':state,'observed_at':clock(),
                'evidence_refs':['herder-autostart:'+reason]}
    if (any(group.get(k)!=v for k,v in {'project':PROJECT,'source_id':SOURCE,'host_id':host_id}.items())
            or group.get('signal_type') not in OWNED_SIGNALS
            or group.get('problem_type')!=group.get('signal_type')):
        return result('unknown','foreign-or-unsupported-source')
    checked={}
    def read_json(path):
        path=Path(path);before=signature(path)
        if before[2]>MAX_JSON: raise ValueError('state exceeds read budget')
        with path.open('rb') as stream:data=stream.read(MAX_JSON+1)
        if len(data)>MAX_JSON or before!=signature(path): raise ValueError('state changed')
        checked[path]=before
        return json.loads(data)
    try:
        state=read_json(paths.autopilot/'unfinished-sessions.json')
        # Retained source episode is authoritative after the work item is removed/rearmed.
        exact=[r for r in state.get('sourceBindings',[]) if identity(r)==group.get('correlation_id')]
        if not exact:
            exact=[r for r in state['sessions'] if identity(r)==group.get('correlation_id')]
        if len(exact)!=1:return result('unknown','exact-episode-unavailable')
        record=exact[0];sid=record['sessionId'];cwd=os.path.normpath(record['cwd'])
        if (record['harness']!='codex' or record.get('recoveryCause') not in
            {'turn.failed','process.disconnected','stalled','quota_exhausted'}
            or record.get('recoveryBlockedReason')):
            return result('unknown','native-recovery-binding-unavailable')
        failed=stamp(record['notifiedAt'])
        if not stamp(record['startedAt'])<=failed<=observed:return result('unknown','invalid-episode-time')
        interrupted_turn=record.get('recoveryTurnId')
        if not interrupted_turn:return result('unknown','failed-native-turn-unavailable')
        stops=read_json(paths.human_stops)['sessions']
        if any(r.get('harness')=='codex' and r.get('id')==sid and r.get('active') is not False for r in stops):
            return result('unknown','human-stop')
        for filename in ['human-requests.json','choices.json']:
            for question in read_json(paths.autopilot/filename)['requests']:
                target=question.get('target',question)
                if (target.get('agent',target.get('harness','codex'))=='codex'
                    and target.get('sessionId')==sid and question.get('status')=='pending'
                    and (not target.get('cwd') or os.path.normpath(target['cwd'])==cwd)):
                    return result('unknown','pending-human-question')
        row=thread_row(paths.codex,sid)
        if row[3] or os.path.normpath(row[1])!=cwd:return result('unknown','archived-or-wrong-workspace')
        rollout=Path(row[2]).resolve()
        rollout.relative_to((paths.codex/'sessions').resolve())
        before=signature(rollout)
        with rollout.open('rb') as stream:
            header=json.loads(stream.readline(512*1024))
            start=max(0,before[2]-MAX_TAIL);stream.seek(start)
            if start:stream.readline(MAX_TAIL)
            data=stream.read(MAX_TAIL+1)
        if (len(data)>MAX_TAIL or not data.endswith(b'\n') or signature(rollout)!=before):
            return result('unknown','incomplete-or-changing-native-tail')
        checked[rollout]=before
        if (header.get('type')!='session_meta' or header['payload'].get('id')!=sid
            or os.path.normpath(header['payload'].get('cwd',''))!=cwd):
            return result('unknown','native-header-mismatch')
        events=[json.loads(line) for line in data.splitlines() if line.strip()]
        controls=[(i,e) for i,e in enumerate(events) if e.get('type')=='event_msg'
                  and e.get('payload',{}).get('type') in {'task_started','task_complete','turn_aborted','task_failed'}]
        if not controls:return result('unknown','native-terminal-unavailable')
        # The record names the interrupted turn. The proof is the ROOT turn it
        # belongs to: a continuation of that root is the same execution, and a
        # turn of another root is not.
        failed_root=failed_root_of(controls,interrupted_turn)
        if not failed_root:return result('unknown','failed-native-root-unavailable')
        index,last=controls[-1];terminal=last['payload'];turn=terminal.get('turn_id')
        if terminal.get('type')!='task_complete':return result('unknown','native-not-completed')
        if (not turn or turn==interrupted_turn or terminal.get('root_turn_id')!=failed_root
            or not failed<stamp(last.get('timestamp'))<=observed):
            return result('unknown','unrelated-or-old-native-completion')
        starts=[e for _,e in controls[:-1] if e['payload'].get('type')=='task_started'
                and e['payload'].get('turn_id')==turn and e['payload'].get('root_turn_id')==failed_root]
        if len(starts)!=1 or not failed<stamp(starts[0].get('timestamp'))<=stamp(last.get('timestamp')):
            return result('unknown','continuation-start-unproven')
        for event in events[index+1:]:
            payload=event.get('payload',{})
            if (event.get('type')=='turn_context' or payload.get('role')=='user'
                or payload.get('type') in {'user_message','request_user_input','error'}):
                return result('unknown','new-input-after-completion')
        if thread_row(paths.codex,sid)!=row or any(signature(p)!=s for p,s in checked.items()):
            return result('unknown','source-changed-during-measurement')
        return result('healthy',f'codex-native:{sid}:{turn}:same-root-completed')
    except (OSError,ValueError,KeyError,TypeError,sqlite3.Error):
        return result('unknown','source-unavailable-or-invalid')


def write_state(path,value):
    """Write the state of the verifier atomically, in the mode of the SDK."""
    temporary=path.with_suffix('.new')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    try:
        with os.fdopen(fd,'w') as stream:
            json.dump(value,stream,sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary,path)
    except BaseException:
        try:os.unlink(temporary)
        except OSError:pass
        raise


def retire_superseded_intent(verifier,state_dir):
    """Retire a pending submission that the server has already moved past.

    The official SDK reconciles a pending intent only against an exact
    receipt. When the submission never reached the server - a restart of the
    notification center in the middle of it is enough - that receipt can
    never arrive, and every later tick raises VerificationPending: the
    source falls silent for good and the server expires its checks, which
    delivers the incident to an executor again with the health of the source
    still unknown.

    The server moves on by itself: an accepted answer rotates the request
    id of the row, and an expired request is re-armed with a new
    generation. Once the identity of the row differs from the identity of
    the intent, the receipt can never match and a late POST of the intent
    is refused by the server as stale. The intent is superseded, so it is
    retired here instead of silencing the source.

    Returns 'superseded', 'confirmed', 'ambiguous' or None.
    """
    path=Path(state_dir)/'verification.json'
    try:saved=json.loads(path.read_text())
    except (OSError,ValueError):return None
    if saved.get('status')!='submitting':return None
    body=saved.get('body') or {}
    incident=saved.get('incident_id')
    if not isinstance(incident,str) or not incident:return None
    try:
        current=verifier.transport('GET','/v1/incidents/'+urllib.parse.quote(incident,safe=''))
    except Exception:return None
    lifecycle=(current or {}).get('lifecycle') or {}
    receipt=lifecycle.get('last_check_receipt') or {}
    result=receipt.get('result') or {}
    if (receipt.get('idempotency_key')==saved.get('idempotency_key')
        and receipt.get('request_id')==body.get('request_id')
        and result.get('generation')==body.get('generation')
        and result.get('observed_state')==body.get('observed_state')):
        # The submission did land: the SDK confirms it on its own.
        return 'confirmed'
    if (lifecycle.get('request_id'),lifecycle.get('generation'))==(body.get('request_id'),body.get('generation')):
        # The server still holds this exact request: the outcome of the
        # submission is ambiguous and the SDK keeps its fail-closed fence.
        return 'ambiguous'
    server_request=lifecycle.get('request_id')
    if not isinstance(server_request,str) or not server_request or server_request==body.get('request_id'):
        # The server did not name a different request: there is no proof that
        # the submission is superseded, so the fence of the SDK stays.
        return 'ambiguous'
    saved['status']='superseded'
    write_state(path,saved)
    return 'superseded'


def run_tick(paths,*,host_id,base_url,token,state_dir,transport=None):
    # Lifecycle, pagination and accepted/UNKNOWN reconciliation have one owner.
    import sys
    sys.path.insert(0,'/opt/noticeplace')
    from notification_center.consumer_lifecycle import SourceVerifier
    verifier=SourceVerifier(base_url,token,PROJECT,SOURCE,host_id,state_dir,transport=transport)
    # A submission the server has moved past must not silence the source.
    retire_superseded_intent(verifier,state_dir)
    return verifier.tick(lambda group:measure(group,paths,host_id=host_id),
                         max_checks=MAX_CHECKS_PER_TICK,
                         deadline_seconds=TICK_DEADLINE_SECONDS,
                         accept_group=lambda g:g.get('signal_type') in OWNED_SIGNALS
                         and g.get('problem_type')==g.get('signal_type'))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--autopilot-state',type=Path,required=True)
    parser.add_argument('--human-stop-store',type=Path,required=True)
    parser.add_argument('--codex-root',type=Path,required=True)
    parser.add_argument('--host-id',required=True)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check-group',type=Path,help='read-only local predicate, no API or receipt writes')
    mode.add_argument('--tick',action='store_true',help='source-owned official SDK tick; existing owner cycle only')
    parser.add_argument('--verifier-state',type=Path)
    args=parser.parse_args();paths=SourcePaths(args.autopilot_state.resolve(),args.human_stop_store.resolve(),args.codex_root.resolve())
    if args.check_group:
        print(json.dumps(measure(json.loads(args.check_group.read_text()),paths,host_id=args.host_id)));return
    if not args.verifier_state:parser.error('--tick requires --verifier-state')
    endpoint=os.environ.get('NOTIFY_CENTER_EVENT_URL','').removesuffix('/v1/events')
    token=os.environ.get('NOTIFY_CENTER_TOKEN','')
    if not endpoint or not token:parser.error('existing source endpoint/credential must be configured')
    receipts=run_tick(paths,host_id=args.host_id,base_url=endpoint,token=token,state_dir=args.verifier_state)
    print(json.dumps({'source':SOURCE,'receipts':len(receipts)}))
if __name__=='__main__':main()
