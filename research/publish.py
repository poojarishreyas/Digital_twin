"""Import a completed report into the authenticated control-plane history API."""
import argparse
import os
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument("report", type=Path)
parser.add_argument("--api", default="http://127.0.0.1:8080")
args = parser.parse_args()
url = urlsplit(args.api)
if url.scheme != "https" and url.hostname not in {"127.0.0.1", "localhost", "::1"}:
    raise SystemExit("Remote report imports require HTTPS")
request = urllib.request.Request(args.api.rstrip("/") + "/api/research/reports", data=args.report.read_bytes(),
    headers={"Content-Type": "application/json", "Authorization": "Bearer " + os.environ["TWIN_API_TOKEN"]})
with urllib.request.urlopen(request, timeout=15) as response:
    print(response.status)
