#!/usr/bin/env python3
"""Larkspur Goods: a small synthetic e-commerce store split into microservices.

One file, one role per process:  catalog | cart | orders | payments | shopper.
Standard library plus psycopg2 only. Every customer, card token and order is
synthetic. Upstream connections are kept alive so the twin agents observe them.
"""
from __future__ import annotations

import http.client
import json
import os
import random
import socket
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "larkspur-goods/2.4.1"
ROLE = sys.argv[1] if len(sys.argv) > 1 else ""
PORTS = {"catalog": 8081, "cart": 8082, "orders": 8083, "payments": 8084}
ENV = os.environ.get


class Upstream:
    """One persistent HTTP/1.1 connection per upstream, reopened on failure."""

    def __init__(self, host, port):
        self.host, self.port, self.lock, self.conn = host, port, threading.Lock(), None

    def call(self, method, path, body=None):
        with self.lock:
            for attempt in (0, 1):
                try:
                    if self.conn is None:
                        self.conn = http.client.HTTPConnection(self.host, self.port, timeout=5)
                    data = json.dumps(body).encode() if body is not None else None
                    self.conn.request(method, path, body=data, headers={"Content-Type": "application/json"})
                    response = self.conn.getresponse()
                    return response.status, json.loads(response.read() or b"{}")
                except Exception:
                    if self.conn:
                        self.conn.close()
                    self.conn = None
                    if attempt:
                        raise


class Database:
    """A single long-lived PostgreSQL session, reconnected if it drops."""

    def __init__(self):
        self.lock, self.conn = threading.Lock(), None

    def query(self, sql, args=(), write=False):
        import psycopg2
        with self.lock:
            for attempt in (0, 1):
                try:
                    if self.conn is None or self.conn.closed:
                        self.conn = psycopg2.connect(host=ENV("DB_HOST"), dbname="shop", user="shop_app",
                                                     password=ENV("DB_PASSWORD"), connect_timeout=5)
                        self.conn.autocommit = True
                    with self.conn.cursor() as cur:
                        cur.execute(sql, args)
                        return cur.fetchall() if cur.description else []
                except Exception:
                    self.conn = None
                    if attempt:
                        raise


class Redis:
    """Minimal RESP client for the cart service's session store."""

    def __init__(self, host="127.0.0.1", port=6379):
        self.addr, self.lock, self.sock = (host, port), threading.Lock(), None

    def command(self, *parts):
        payload = f"*{len(parts)}\r\n".encode() + b"".join(
            f"${len(str(p).encode())}\r\n{p}\r\n".encode() for p in parts)
        with self.lock:
            for attempt in (0, 1):
                try:
                    if self.sock is None:
                        self.sock = socket.create_connection(self.addr, timeout=3)
                        self.file = self.sock.makefile("rb")
                    self.sock.sendall(payload)
                    return self._read()
                except Exception:
                    if self.sock:
                        self.sock.close()
                    self.sock = None
                    if attempt:
                        raise

    def _read(self):
        line = self.file.readline().rstrip(b"\r\n")
        kind, rest = line[:1], line[1:]
        if kind in (b"+", b":"):
            return rest.decode()
        if kind == b"-":
            raise RuntimeError(rest.decode())
        if kind == b"$":
            size = int(rest)
            return None if size < 0 else self.file.read(size + 2)[:-2].decode()
        if kind == b"*":
            return [self._read() for _ in range(int(rest))]
        raise RuntimeError("unexpected redis reply")


def serve(handlers):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):
            pass

        def reply(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def dispatch(self, method):
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            if self.path == "/health":
                return self.reply(200, {"service": ROLE, "version": VERSION, "ready": True})
            for (verb, prefix), handler in handlers.items():
                if verb == method and self.path.startswith(prefix):
                    try:
                        return self.reply(*handler(self.path[len(prefix):], body))
                    except Exception as exc:
                        return self.reply(503, {"error": type(exc).__name__})
            self.reply(404, {"error": "not found"})

        def do_GET(self):
            self.dispatch("GET")

        def do_POST(self):
            self.dispatch("POST")

    ThreadingHTTPServer(("0.0.0.0", PORTS[ROLE]), Handler).serve_forever()


def catalog():
    db = Database()

    def products(rest, _):
        if rest.strip("/"):
            rows = db.query("SELECT sku, name, category, price_cents, stock FROM products WHERE sku=%s", (rest.strip("/"),))
            if not rows:
                return 404, {"error": "unknown product"}
            rows = rows[:1]
        else:
            rows = db.query("SELECT sku, name, category, price_cents, stock FROM products ORDER BY sku LIMIT 24")
        items = [dict(zip(("sku", "name", "category", "price_cents", "stock"), r)) for r in rows]
        return 200, items[0] if rest.strip("/") else {"products": items}

    serve({("GET", "/products"): products})


def cart():
    redis = Redis(ENV("REDIS_HOST", "127.0.0.1"))

    def get(session, _):
        return 200, {"session": session.strip("/"), "items": redis.command("HGETALL", "cart:" + session.strip("/"))}

    def add(session, body):
        key = "cart:" + session.strip("/")
        redis.command("HINCRBY", key, str(body["sku"]), str(int(body.get("qty", 1))))
        redis.command("EXPIRE", key, "3600")
        return 200, {"session": session.strip("/"), "added": body["sku"]}

    serve({("GET", "/cart"): get, ("POST", "/cart"): add})


def orders():
    db, payments = Database(), Upstream(ENV("PAYMENTS_HOST", "127.0.0.1"), 8084)

    def place(_, body):
        order_id = "LG-" + uuid.uuid4().hex[:10].upper()
        total = int(body["total_cents"])
        status, auth = payments.call("POST", "/authorize", {"order_id": order_id, "amount_cents": total,
                                                            "card_token": body["card_token"]})
        state = "paid" if status == 200 and auth.get("approved") else "payment_failed"
        db.query("INSERT INTO orders(order_id, customer_id, total_cents, status) VALUES (%s,%s,%s,%s)",
                 (order_id, body["customer_id"], total, state), write=True)
        return 201, {"order_id": order_id, "status": state}

    def recent(_, __):
        rows = db.query("SELECT order_id, customer_id, total_cents, status FROM orders ORDER BY created_at DESC LIMIT 10")
        return 200, {"orders": [dict(zip(("order_id", "customer_id", "total_cents", "status"), r)) for r in rows]}

    serve({("POST", "/orders"): place, ("GET", "/orders"): recent})


def payments():
    def authorize(_, body):
        # Mock processor: synthetic tokens only; roughly 3% are declined.
        approved = body.get("card_token", "").startswith("tok_synthetic_") and random.random() > 0.03
        return 200, {"order_id": body["order_id"], "approved": approved,
                     "authorization": "AUTH-" + uuid.uuid4().hex[:8].upper() if approved else None}

    serve({("POST", "/authorize"): authorize})


def shopper():
    """Synthetic customers browsing and buying through the storefront every few seconds."""
    store = Upstream("127.0.0.1", 80)
    while True:
        try:
            session = uuid.uuid4().hex[:12]
            _, listing = store.call("GET", "/api/catalog/products")
            items = listing.get("products") or []
            if items:
                pick = random.choice(items)
                store.call("GET", "/api/catalog/products/" + pick["sku"])
                store.call("POST", "/api/cart/cart/" + session, {"sku": pick["sku"], "qty": random.randint(1, 3)})
                store.call("GET", "/api/cart/cart/" + session)
                if random.random() < 0.4:
                    store.call("POST", "/api/orders/orders", {
                        "customer_id": f"CUST-{random.randint(10001, 10250)}", "total_cents": pick["price_cents"],
                        "card_token": "tok_synthetic_" + uuid.uuid4().hex[:16]})
        except Exception:
            pass
        time.sleep(random.uniform(1.5, 4))


if __name__ == "__main__":
    {"catalog": catalog, "cart": cart, "orders": orders, "payments": payments, "shopper": shopper}[ROLE]()
