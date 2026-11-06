#!/usr/bin/env python3
"""Recording stdio MCP endpoint. Strict mode accepts only the v1 wire baseline."""
import json, os, sys

trace = os.environ['PROBE_TRACE']
mode = os.environ['PROBE_MODE']
def record(direction, message):
    with open(trace, 'a', encoding='utf-8') as f:
        f.write(json.dumps({'direction': direction, 'message': message}, sort_keys=True) + '\n')
def send(msg):
    record('server_to_client', msg)
    print(json.dumps(msg), flush=True)
for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        record('invalid_client_input', line.rstrip())
        continue
    record('client_to_server', msg)
    if 'id' not in msg:
        continue
    method = msg.get('method')
    if mode == 'strict' and method != 'server/discover':
        send({'jsonrpc':'2.0','id':msg['id'],'error':{'code':-32601,'message':'v1 requires server/discover and MCP 2026-07-28'}})
    elif method == 'server/discover':
        send({'jsonrpc':'2.0','id':msg['id'],'result':{'resultType':'complete','supportedVersions':['2026-07-28'],'capabilities':{'tools':{},'resources':{},'extensions':{'io.modelcontextprotocol/tasks':{},'io.modelcontextprotocol/skills':{}}},'ttlMs':0,'cacheScope':'private','_meta':{'io.modelcontextprotocol/serverInfo':{'name':'v003-probe','version':'1'}}}})
    elif method == 'initialize':
        version = '2026-07-28' if mode == 'future' else msg['params']['protocolVersion']
        send({'jsonrpc':'2.0','id':msg['id'],'result':{'protocolVersion':version,'capabilities':{'tools':{},'resources':{'subscribe':True,'listChanged':True},'extensions':{'io.modelcontextprotocol/tasks':{},'io.modelcontextprotocol/skills':{}}},'serverInfo':{'name':'v003-probe','version':'1'}}})
    elif method in ('tools/list','resources/list','resources/templates/list','prompts/list'):
        key = {'tools/list':'tools','resources/list':'resources','resources/templates/list':'resourceTemplates','prompts/list':'prompts'}[method]
        send({'jsonrpc':'2.0','id':msg['id'],'result':{key:[]}})
    else:
        send({'jsonrpc':'2.0','id':msg['id'],'error':{'code':-32601,'message':'probe method unavailable'}})
