#!/usr/bin/env python3
"""Independent assertions against a separate production-list consumer process."""
import json
import select
import subprocess
import sys

binary = sys.argv[1]
def read(scenario):
    result = subprocess.run([binary, scenario], check=True, capture_output=True, text=True, timeout=10)
    return json.loads(result.stdout)['pages']
def source(node, instance):
    return {'node': node, 'instance': instance}
a, b = source('node-a', 'same-profile'), source('node-b', 'same-profile')
c, d = source('node-a', 'empty-profile'), source('node-d', 'missing-profile')
pages = read('all')
assert len(pages) == 3
assert [p['next_offset'] for p in pages] == [1, 2, None]
rows = [p['sessions'][0] for p in pages]
assert [(r['project'], r['source'], r['native_id']) for r in rows] == [
    ('project-a/same', a, 'same-session'), ('project-b/same', b, 'same-session'),
    ('project-b/same', a, 'another-session')]
for p in pages:
    assert not p['coverage_complete'] and p['missing_sources'] == [d]
    assert [(v['source'], v['availability'], v['coverage']) for v in p['sources']] == [
        (a, 'Available', 'Complete'), (b, 'Unavailable', 'Unknown'), (c, 'Available', 'Complete')]
assert rows[1]['observed_at'] == 'cached-before-check'  # cached row is not live evidence
project = read('project-b')
assert len(project) == 2 and all(not p['coverage_complete'] and p['missing_sources'] == [d] and len(p['sources']) == 3 for p in project)
assert [p['sessions'][0]['source'] for p in project] == [b, a]
offline, empty, missing = read('offline')[0], read('empty')[0], read('missing')[0]
assert len(offline['sessions']) == 1 and offline['sources'][0]['availability'] == 'Unavailable' and not offline['coverage_complete']
assert empty['sessions'] == [] and empty['sources'][0]['availability'] == 'Available' and empty['coverage_complete']
assert missing['sessions'] == [] and missing['sources'] == [] and missing['missing_sources'] == [d] and not missing['coverage_complete']
print('production list API: same names isolated; offline != empty != missing; every page reports coverage; project filter OK')

if len(sys.argv) > 2:
    # Check the actual public boundary independently; never substitute this
    # unsupported response for successful list consumption.
    meta = {'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': {'name': 'list-coverage-check', 'version': '1'}}
    request = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {
        '_meta': meta, 'name': 'sessions', 'arguments': {'action': 'list'}}}
    with subprocess.Popen([sys.argv[2]], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True) as server:
        server.stdin.write(json.dumps(request) + '\n')
        server.stdin.flush()
        assert select.select([server.stdout], [], [], 10)[0], 'MCP list timed out'
        response = json.loads(server.stdout.readline())
        assert response['id'] == 1
        assert response['result']['isError'] is True
        assert response['result']['structuredContent']['code'] == 'unsupported'
        assert response['result']['structuredContent']['effect'] == 'none'
        server.stdin.close()
        assert server.wait(timeout=10) == 0
    print('public MCP sessions/list: unsupported, effect=none; no native consumer proof')
