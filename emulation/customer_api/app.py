"""Synthetic telecom customer API modeled on the publicly reported 2022 Optus exposure.

Deliberate defect, isolated lab only: the customer endpoint is reachable from the
internet edge, requires no authentication and uses sequential customer identifiers.
Every person, document number and address is generated and marked synthetic.
"""
from __future__ import annotations

import asyncio
import http.client
import json
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "customer-api/1.0.0"
CONFIG = Path("/run/customer/config.json")
ROUTE = re.compile(r"/v1/customers/([0-9]{7})")
MAX_BATCH = 25


def emit(value):
    if "component" in value:
        with Path("/run/customer/events.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(value, separators=(",", ":")) + "\n")
    print(json.dumps(value, separators=(",", ":")), flush=True)


def probe(host, customer_ids, request_ids, credential=None):
    """Fixed client: GET one customer path per identifier, nothing else."""
    if not 1 <= len(customer_ids) <= MAX_BATCH or len(customer_ids) != len(request_ids):
        raise ValueError("unsupported synthetic request batch")
    results = []
    for customer_id, request_id in zip(customer_ids, request_ids):
        if not re.fullmatch(r"[0-9]{7}", str(customer_id)):
            raise ValueError("unsupported synthetic customer identifier")
        headers = {"X-Request-ID": request_id}
        if credential:
            headers["Authorization"] = "Bearer " + credential
        connection = http.client.HTTPConnection(host, 8080, timeout=4)
        try:
            connection.request("GET", f"/v1/customers/{customer_id}", headers=headers)
            response = connection.getresponse()
            raw = response.read(8193)
            if len(raw) > 8192:
                raise ValueError("oversized customer response")
            results.append({"customer_id": str(customer_id), "request_id": request_id,
                            "status": response.status, "body": json.loads(raw)})
        finally:
            connection.close()
    return {"results": results}


def serve():
    cfg = json.loads(CONFIG.read_text())
    role = cfg["role"]
    loop = asyncio.new_event_loop()
    lock = threading.RLock()
    database = None
    if role == "api":
        import asyncpg
        for attempt in range(60):
            try:
                database = loop.run_until_complete(asyncpg.connect(
                    host=cfg["database"], user="customer_app", database="customers",
                    password=cfg["database_password"], timeout=3))
                break
            except Exception:
                if attempt == 59:
                    raise
                time.sleep(0.25)

    def actor_of(authorization):
        if authorization == "Bearer " + cfg["staff_credential"]:
            return "staff", None
        for token, customer_id in cfg["customer_sessions"].items():
            if authorization == "Bearer " + token:
                return "customer", customer_id
        return "anonymous", None

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass  # Never log authorization headers.

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
            match = ROUTE.fullmatch(self.path)
            if not match or role == "internet":
                return self.reply(404, {"error": "not found"})
            customer_id = match.group(1)
            if role == "gateway":
                # Public edge: forwards the customer route unchanged, as reported.
                upstream = http.client.HTTPConnection(cfg["api"], 8080, timeout=4)
                try:
                    headers = {"X-Request-ID": request_id}
                    if self.headers.get("Authorization"):
                        headers["Authorization"] = self.headers["Authorization"]
                    upstream.request("GET", self.path, headers=headers)
                    response = upstream.getresponse()
                    data = response.read(8193)
                    if len(data) > 8192:
                        raise ValueError("response limit")
                    emit({"component": "gateway", "request_id": request_id,
                          "upstream_status": response.status})
                    return self.reply(response.status, json.loads(data))
                except Exception:
                    return self.reply(502, {"error": "upstream unavailable"})
                finally:
                    upstream.close()
            actor, own_id = actor_of(self.headers.get("Authorization", ""))
            policy = cfg["authorization"]
            # The seeded defect: policy "open" serves any identifier to anyone.
            if policy == "deny_all":
                status = 403
            elif policy == "enforced" and actor == "anonymous":
                status = 401
            elif policy == "enforced" and actor == "customer" and own_id != customer_id:
                status = 403
            else:
                status = 200
            try:
                record = None
                if status == 200:
                    record = loop.run_until_complete(database.fetchrow(
                        "SELECT customer_id, full_name, date_of_birth, email, phone, address, id_document "
                        "FROM customers WHERE customer_id=$1", customer_id))
                    status = 200 if record else 404
                loop.run_until_complete(database.execute(
                    "INSERT INTO access_audit(request_id, actor, customer_id, outcome) VALUES($1,$2,$3,$4)",
                    request_id, actor, customer_id, status))
                emit({"component": "api", "request_id": request_id, "actor": actor,
                      "customer_id": customer_id, "status": status})
            except Exception:
                return self.reply(503, {"error": "database unavailable"})
            if status != 200:
                return self.reply(status, {"error": {401: "authentication required", 403: "forbidden",
                                                     404: "not found"}[status], "request_id": request_id})
            return self.reply(200, {"request_id": request_id, "customer": dict(record),
                                   "tenant": cfg["tenant"], "version": VERSION})

    emit({"component": role, "version": VERSION, "event": "ready"})
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "probe":
        print(json.dumps(probe(**json.load(sys.stdin)), separators=(",", ":")), flush=True)
    else:
        serve()
