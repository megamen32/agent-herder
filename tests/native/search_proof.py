"""Validate exact search result against the current complete local index scan."""


def verify_search(data, host_id, harness, session_id):
    if not isinstance(data, dict) or data.get('partial') is not False:
        return False
    hosts = data.get('hosts')
    if not isinstance(hosts, list) or len(hosts) != 1 or not isinstance(hosts[0], dict):
        return False
    host = hosts[0]
    if host.get('hostId') != host_id or host.get('state') != 'available' or host.get('partial') is not False:
        return False
    index = host.get('index')
    if not isinstance(index, dict) or index.get('indexing') is not False:
        return False
    run = index.get('run')
    if not isinstance(run, dict) or run.get('status') != 'complete' or not isinstance(run.get('scanId'), str) or not run['scanId']:
        return False
    sources = index.get('sources')
    if not isinstance(sources, list):
        return False
    relevant = [s for s in sources if isinstance(s, dict) and s.get('harness') == harness]
    if len(relevant) != 1 or relevant[0].get('state') != 'complete' or relevant[0].get('scanId') != run['scanId'] or type(relevant[0].get('missingContent')) is not int or relevant[0]['missingContent'] != 0:
        return False
    results = data.get('results')
    return isinstance(results, list) and any(isinstance(r, dict) and r.get('hostId') == host_id
        and r.get('harness') == harness and r.get('nativeSessionId') == session_id for r in results)


def attach_search_proof(journey, replies, host_id):
    harness = journey.get('harness')
    sessions = journey.get('sessions')
    if not isinstance(sessions, list) or len(sessions) != 2 or not isinstance(replies, list) or len(replies) != 2:
        raise ValueError('two session search proofs required')
    for session in sessions:
        matches = [r for r in replies if isinstance(r, dict) and r.get('harness') == harness and r.get('sessionId') == session.get('id')]
        if len(matches) != 1 or not verify_search(matches[0].get('response'), host_id, harness, session.get('id')):
            raise ValueError('complete exact session search not proven')
    return {**journey, 'missing': [x for x in journey.get('missing', []) if x != 'search'], 'searchProven': True}
