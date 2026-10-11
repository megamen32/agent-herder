"""Isolated real Notice HTTP/DB/card peer; Telegram is replaced by an in-memory API."""
import io
import json
import os
import sys
import threading
import time
import urllib.parse
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, sys.argv[2])
from notification_center import http_api
from notification_center.core import NotificationCenter
from notification_center.telegram_interactions import TelegramActionCodec

os.environ.update(TELEGRAM_CALLBACK_ALLOWED_USER_IDS="42", TELEGRAM_CHAT_ID="-100", TELEGRAM_BOT_TOKEN="fixture-bot-token")
root = Path(sys.argv[1])
generic = len(sys.argv)>3 and sys.argv[3]=='execution-display'
center = NotificationCenter(root / 'notice.sqlite3', {'admin-token': {'project': 'admin', 'max_severity': 'critical'}, 'hermes-token': {'project': 'hermes', 'max_severity': 'critical'}}, default_quiet_hours=[])
event = {'schema': 'notify.event.v1', 'project': 'admin', 'recipient': 'me', 'kind': 'incident', 'severity': 'critical',
         'title': 'Сервис не отвечает', 'body': 'Проверяем причину', 'dedup_key': 'original-incident', 'event_type': 'health.degraded',
         'source_id': 'site-source', 'host_id': 'fixture', 'signal_type': 'https', 'correlation_id': 'site-episode'}
incident_id = None if generic else center.create_event('admin-token', 'original-create', event)['incident_id']
calls = []
worker = http_api.DeliveryWorker(center, http_api.TelegramSender('fixture-bot-token', '-100', action_codec=TelegramActionCodec('s' * 32), center=center, severity_routes={'health': {'chat_id': '-100', 'message_thread_id': 324}}))
real_urlopen = http_api.urllib.request.urlopen

def network(request, **kwargs):
    if urllib.parse.urlsplit(request.full_url).hostname != 'api.telegram.org':
        return real_urlopen(request, **kwargs)
    payload = {k: v[0] for k, v in urllib.parse.parse_qs(request.data.decode()).items()}
    method = request.full_url.rsplit('/', 1)[-1]
    calls.append({'method': method, **payload})
    response = io.BytesIO(json.dumps({'ok': True, 'result': {'message_id': 42, 'chat': {'id': -100}}}).encode())
    response.status = 200
    return response

def telegram_api(_token, method, payload):
    calls.append({'method': method, **payload})
    return {'ok': True, 'result': {'message_id': 42, 'chat': {'id': -100}}}

def flush():
    with center._lock:
        deliveries = center._connection.execute("SELECT id FROM deliveries WHERE (channel='telegram' OR channel LIKE 'telegram.%') AND status='queued' ORDER BY created_at").fetchall()
    for row in deliveries:
        with center._lock, center._connection:
            center._connection.execute('UPDATE incidents SET telegram_card_updated_at=0')
            center._connection.execute("UPDATE deliveries SET status='claimed',claimed_at=?,attempt=attempt+1 WHERE id=?", (time.time(), row[0]))
            delivery = dict(center._connection.execute('SELECT * FROM deliveries WHERE id=?', (row[0],)).fetchone())
        worker.deliver(delivery)

base_handler = http_api.build_handler(center, 'health-token', 'mcp-token')
class Handler(base_handler):
    def do_POST(self):
        super().do_POST()
        flush()
    def do_GET(self):
        if self.path == '/fixture-proof':
            with center._lock:
                incidents = center._connection.execute('SELECT count(*) FROM incidents').fetchone()[0]
                progress = center._connection.execute("SELECT count(*) FROM events WHERE event_type='health.progress'").fetchone()[0]
                questions = center._connection.execute('SELECT count(*) FROM human_requests').fetchone()[0]
                delivery_states = [dict(row) for row in center._connection.execute('SELECT channel,status,last_error FROM deliveries').fetchall()]
            import sqlite3
            with sqlite3.connect(f'file:{root / "notice.sqlite3"}?mode=ro',uri=True) as reopened:
                payloads=[json.loads(row[0]) for row in reopened.execute('SELECT payload_json FROM events')]
            body = json.dumps({'incident_id': incident_id, 'incidents': incidents, 'progress': progress, 'questions': questions, 'calls': calls, 'delivery_states': delivery_states, 'payloads':payloads}).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            super().do_GET()
    def log_message(self, *_args): pass

with patch('notification_center.http_api.urllib.request.urlopen', side_effect=network), patch('notification_center.http_api.telegram_api', side_effect=telegram_api):
    flush()
    if not generic:
        receipt = center.record_health_agent_session(incident_id, 'native-launch', '', 'opencode', 'ses_real_opencode', 'https://agent.bezrabotnyi.com', stage='health-diagnosis')
    flush()
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(json.dumps({'url': f'http://127.0.0.1:{server.server_address[1]}', 'incidentId': incident_id}), flush=True)
    sys.stdin.readline()
    server.shutdown(); server.server_close()
center._connection.close()
