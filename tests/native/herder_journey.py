"""Two-session Herder journey. Caller owns isolation and supplies explicit transports."""
import time
import urllib.parse
import uuid


def run_journey(api, read_transcript, harness, model, project, *, timeout=30, sleep=time.sleep):
    if not all(isinstance(x, str) and x for x in (harness, model, project)):
        raise ValueError('exact harness, model and project required')
    settings = api('/api/settings')
    if not any(p.get('path') == project for p in settings.get('projects', []) if isinstance(p, dict)):
        raise RuntimeError('test project is not listed')
    before = api('/_stats').get('requests')
    if type(before) is not int or before < 0:
        raise RuntimeError('fixture request counter unavailable')
    sessions = []
    for i in range(2):
        marker = f'HERDER_CI_{uuid.uuid4().hex}'
        created = api('/api/sessions', {'harness': harness, 'name': marker, 'cwd': project, 'model': model})
        sid = created.get('sessionId') or (created.get('session') or {}).get('id')
        if not isinstance(sid, str) or not sid or sid in [row['id'] for row in sessions]:
            raise RuntimeError('missing or duplicate native session ID; no replay')
        path = '/api/sessions/' + urllib.parse.quote(harness, safe='') + '/' + urllib.parse.quote(sid, safe='') + '/message'
        try:
            sent = api(path, {'message': marker, 'mode': 'queue', 'inputId': marker, 'humanRequested': True})
        except Exception as error:
            raise RuntimeError(f'{harness} session {sid}: send outcome unknown; no replay') from error
        job = (sent.get('job') or {}).get('id')
        if not isinstance(job, str) or not job:
            raise RuntimeError(f'{harness} session {sid}: missing job, outcome unknown; no replay')
        deadline = time.monotonic() + timeout
        while True:
            state = api('/api/jobs/' + urllib.parse.quote(job, safe='')).get('job', {})
            if state.get('state') in ('completed', 'failed', 'cancelled'):
                break
            if time.monotonic() >= deadline:
                raise RuntimeError(f'{harness} session {sid}: job {job} outcome unknown; no replay')
            sleep(.2)
        if state.get('state') != 'completed' or (state.get('result') or {}).get('ok') is not True:
            raise RuntimeError(f'{harness} session {sid}: delivery failed; no replay')
        deadline = time.monotonic() + timeout
        while True:
            try:
                pages = read_transcript(harness, sid, marker)
                break
            except ValueError as error:
                if str(error) != 'exact input followed by fixture answer missing' or time.monotonic() >= deadline:
                    raise
                sleep(.2)
        if type(pages) is not int or pages < 2:
            raise RuntimeError('complete paginated transcript not proven')
        sessions.append({'id': sid, 'job': job, 'pages': pages, 'marker': marker})
    deadline = time.monotonic() + timeout
    while True:
        listing = api('/api/sessions?harness=' + urllib.parse.quote(harness, safe='') + '&limit=100').get('sessions', [])
        if all(any(isinstance(x, dict) and x.get('id') == row['id'] and x.get('harness') == harness for x in listing) for row in sessions):
            break
        if time.monotonic() >= deadline:
            raise RuntimeError('both exact sessions not found in list')
        sleep(.2)
    after = api('/_stats').get('requests')
    if type(after) is not int or after - before < 2:
        raise RuntimeError('fixture model did not receive both requests')
    return {'status': 'INCOMPLETE', 'harness': harness, 'sessions': sessions,
            'fixtureRequests': after - before, 'missing': ['search', 'installed-process']}
