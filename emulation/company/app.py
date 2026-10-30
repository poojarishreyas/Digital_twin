"""Synthetic company application. Deliberate authorization defect; isolated lab only."""
from __future__ import annotations

import asyncio
import hashlib
import http.client
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "company-records/1.0.0"
CONFIG = Path("/run/company/config.json")


def emit(value):
    if "component" in value:
        with Path("/run/company/events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(value, separators=(",", ":")) + "\n")
    print(json.dumps(value, separators=(",", ":")), flush=True)


def probe(host, record, actor, credential, request_id):
    if record not in {"ordinary", "restricted"} or actor not in {"employee", "admin"}:
        raise ValueError("unsupported synthetic request")
    connection = http.client.HTTPConnection(host, 8080, timeout=4)
    try:
        connection.request("GET", "/records/" + record, headers={
            "Authorization": "Bearer " + credential, "X-Request-ID": request_id})
        response = connection.getresponse()
        raw = response.read(8193)
        if len(raw) > 8192:
            raise ValueError("oversized company response")
        return {"status": response.status, "body": json.loads(raw)}
    finally:
        connection.close()


def serve():
    cfg = json.loads(CONFIG.read_text())
    role = cfg["role"]
    loop = asyncio.new_event_loop()
    database = None
    upstream = None
    lock = threading.RLock()
    if role == "api":
        import asyncpg
        for attempt in range(60):
            try:
                database = loop.run_until_complete(asyncpg.connect(
                    host=cfg["database"], user="company_app", database="company",
                    password=cfg["database_password"], timeout=3))
                break
            except Exception:
                if attempt == 59:
                    raise
                time.sleep(0.25)
    elif role == "gateway":
        upstream = http.client.HTTPConnection(cfg["api"], 8080, timeout=4)
    elif role == "employee" and cfg.get("discovery_traffic"):
        def traffic():
            connection = http.client.HTTPConnection(cfg["gateway"], 8080, timeout=3)
            while True:
                try:
                    import uuid
                    connection.request("GET", "/records/ordinary", headers={
                        "Authorization": "Bearer " + cfg["employee_credential"],
                        "X-Request-ID": uuid.uuid4().hex})
                    connection.getresponse().read(8192)
                except Exception:
                    connection.close()
                time.sleep(1)
        threading.Thread(target=traffic, daemon=True).start()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass  # Never log authorization headers or credential-bearing URLs.

        def reply(self, status, body):
            data = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            with lock:
                self.handle_get()

        def handle_get(self):
            if self.path == "/health":
                return self.reply(200, {"service": role, "version": VERSION, "ready": True})
            request_id = self.headers.get("X-Request-ID", "")
            if not re.fullmatch(r"[a-f0-9]{32}", request_id):
                return self.reply(400, {"error": "request identity required"})
            if self.path not in {"/records/ordinary", "/records/restricted"} or role == "employee":
                return self.reply(404, {"error": "not found"})
            if role == "gateway":
                try:
                    upstream.request("GET", self.path, headers={
                        "Authorization": self.headers.get("Authorization", ""),
                        "X-Request-ID": request_id})
                    response = upstream.getresponse()
                    data = response.read(8193)
                    if len(data) > 8192:
                        raise ValueError("response limit")
                    emit({"component": "gateway", "request_id": request_id,
                          "upstream_status": response.status})
                    return self.reply(response.status, json.loads(data))
                except Exception:
                    upstream.close()
                    return self.reply(502, {"error": "upstream unavailable"})
            auth = self.headers.get("Authorization", "")
            actor = next((actor for actor in ("employee", "admin")
                          if auth == "Bearer " + cfg[actor + "_credential"]), None)
            if actor is None:
                return self.reply(401, {"error": "authentication required"})
            record_id = self.path.rsplit("/", 1)[-1]
            try:
                record = loop.run_until_complete(database.fetchrow(
                    "SELECT id, classification, body FROM records WHERE id=$1", record_id))
                # This is the seeded defect: authentication alone permits restricted records.
                denied = cfg["authorization"] == "deny_all" or (
                    cfg["authorization"] == "enforced" and actor == "employee"
                    and record["classification"] == "restricted")
                status = 403 if denied else 200
                loop.run_until_complete(database.execute(
                    "INSERT INTO access_audit(request_id, actor, record_id, outcome) VALUES($1,$2,$3,$4)",
                    request_id, actor, record_id, status))
                emit({"component": "api", "request_id": request_id, "actor": actor,
                      "record": record_id, "status": status})
                if denied:
                    return self.reply(403, {"error": "forbidden", "request_id": request_id})
                return self.reply(200, {"request_id": request_id, "record": dict(record),
                                       "tenant": cfg["tenant"], "version": VERSION})
            except Exception:
                return self.reply(503, {"error": "database unavailable"})

    emit({"component": role, "version": VERSION, "event": "ready"})
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "probe":
        if len(sys.argv) == 5:
            cfg = json.loads(CONFIG.read_text())
            request = {"host": cfg["gateway"], "record": sys.argv[2], "actor": sys.argv[3],
                       "credential": cfg[sys.argv[3] + "_credential"], "request_id": sys.argv[4]}
        else:
            request = json.load(sys.stdin)
        emit(probe(**request))
    else:
        serve()
