"""Larkspur order-history lab: intentionally vulnerable, synthetic data only."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
from auth import authenticate

ORDERS = [
    {"order_id": "LG-DEMO-001", "customer_id": "CUST-10001", "total_cents": 3499, "status": "paid"},
    {"order_id": "LG-DEMO-002", "customer_id": "CUST-10002", "total_cents": 1899, "status": "paid"},
    {"order_id": "LG-DEMO-003", "customer_id": "CUST-10001", "total_cents": 2500, "status": "pending"},
]


def list_orders(headers):
    # VULNERABILITY: caller identity and order ownership are not checked.
    return 200, {"orders": ORDERS}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        route = urlsplit(self.path).path
        if route in {"/orders", "/api/orders/orders"}:
            status, body = list_orders(self.headers)
        elif route == "/health":
            status, body = 200, {"service": "larkspur-order-history-lab", "synthetic": True}
        else:
            status, body = 404, {"error": "not found"}
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8083)
    args = parser.parse_args()
    print(f"Synthetic vulnerable lab: http://{args.host}:{args.port}/orders")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
