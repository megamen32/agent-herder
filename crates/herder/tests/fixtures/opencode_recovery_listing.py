"""Loopback native API for the Rust owner's recovery and restart test."""
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


session_id = "ses_Interrupted"
base = "/api/session/" + session_id
started = int(time.time() * 1000) - 1000
session = {
    "id": session_id, "projectID": "project", "location": {"directory": str(Path.cwd())},
    "model": {"providerID": "fixture", "id": "main"},
    "time": {"created": started, "updated": started + 10, "busy": started},
}
inbox = []
cursor = "next+/=&?"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path, query = urlsplit(self.path).path, parse_qs(urlsplit(self.path).query)
        if path == "/openapi.json":
            return self.reply({"openapi": "3.1.0", "paths": {
                "/api/session": {"get": {}, "post": {}}, "/api/event": {"get": {}}}})
        if path == "/api/session":
            assert query["limit"] == ["32"]
            if "cursor" not in query:
                assert query["order"] == ["desc"] and query["archived"] == ["false"]
                return self.reply({"data": [], "cursor": {"next": cursor}})
            assert query["cursor"] == [cursor]
            return self.reply({"data": [session], "cursor": {"next": None}})
        if path == "/api/session/active":
            return self.reply({"data": {}})
        if path == "/api/session/ses_Offline":
            return self.reply({"code": "service_starting"}, 503)
        if path in ("/api/session/ses_Missing", "/api/session/ses_WrongMiss"):
            return self.reply({"_tag": "SessionNotFoundError", "sessionID": "ses_Missing"}, 404)
        if path == base:
            if inbox and Path("restarted").exists():
                Path("rechecked").touch()
            return self.reply({"data": session})
        if path in (base + "/form", base + "/permission"):
            return self.reply({"data": []})
        if path == base + "/inbox":
            return self.reply({"data": inbox})
        if path == base + "/message":
            return self.reply({"data": [{"type": "user", "id": "msg_Input",
                                         "text": "fixture work", "time": {"created": started + 10}}]})
        if path.startswith(base + "/message/"):
            return self.reply({"_tag": "MessageNotFoundError", "sessionID": session_id,
                               "messageID": path.split("/")[-1]}, 404)
        self.reply({}, 404)

    def do_POST(self):
        assert self.path == base + "/synthetic"
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body["resume"] and body["delivery"] == "queue"
        row = {"id": body["id"], "sessionID": session_id, "time": {"created": started + 30},
               "type": "synthetic", "delivery": "queue",
               "payload": {k: body[k] for k in ("text", "description", "metadata")}}
        inbox.append(row)
        with open("native-sends", "a") as out:
            print(body["metadata"]["agentHerderInputId"], file=out)
        self.reply({"data": row})


with HTTPServer(("127.0.0.1", 0), Handler) as server:
    print(server.server_port, flush=True)
    server.serve_forever()
