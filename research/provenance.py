"""Capture reproducibility inventories without credentials or environment dumps."""
import argparse
import hashlib
import json
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
import docker


def capture(output):
    root = Path(__file__).resolve().parents[1]
    files = []
    for directory in ("ingestion/twin_ingestion", "ingestion/tests", "research", "deploy/models", "schema", "ui/src", "agent/internal", "agent/cmd"):
        for path in (root / directory).rglob("*"):
            if path.is_file() and path.suffix in {".py", ".json", ".go", ".tsx", ".css"} and "results" not in path.parts:
                files.append(path)
    for name in ("ingestion/requirements.txt", "research/requirements.txt", "ui/package-lock.json", "agent/go.mod", "agent/go.sum"):
        path = root / name
        if path.exists(): files.append(path)
    hashes = {p.relative_to(root).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}
    dependencies = json.loads(subprocess.check_output([sys.executable, "-m", "pip", "list", "--format=json"], text=True))
    client = docker.from_env()
    try:
        info = client.info()
        engine = {"version": client.version()["Version"], "cpus": info["NCPU"], "ram_bytes": info["MemTotal"], "architecture": info["Architecture"]}
    finally:
        client.close()
    data = {"captured_at": datetime.now(timezone.utc).isoformat(),
        "capture_scope": "post-validation repository inventory; not an attestation of unchanged code throughout earlier pilots",
        "platform": platform.platform(), "processor": platform.processor(), "python": sys.version,
        "docker": engine, "dependencies": dependencies, "source_sha256": hashes}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(data, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    capture(parser.parse_args().output)
