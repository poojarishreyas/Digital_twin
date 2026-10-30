"""Consistent cold backups and restore into NEW Compose volumes only.

Stop external workers and all project containers before archive. This command
never stops a deployment, overwrites an existing volume, or starts services.
Store backups on encrypted storage: they contain topology and database secrets.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile


def docker(*args, **kwargs):
    return subprocess.run(["docker", *args], check=True, **kwargs)


def output(*args):
    return docker(*args, stdout=subprocess.PIPE).stdout.decode().strip()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def project_name(value):
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", value):
        raise ValueError("invalid Compose project name")
    return value


def archive(project, destination):
    project_name(project)
    if output("ps", "-q", "--filter", "label=com.docker.compose.project=" + project):
        raise ValueError("stop ALL project containers and external workers before a cold backup")
    ids = output("ps", "-aq", "--filter", "label=com.docker.compose.project=" + project).split()
    if not ids:
        raise ValueError("project containers must exist, stopped, for volume identification")
    containers = json.loads(output("inspect", *ids))
    stores = {}
    for service, logical, target in (("postgres", "pgdata", "/var/lib/postgresql/data"), ("neo4j", "neo4jdata", "/data")):
        matches = [c for c in containers if c["Config"]["Labels"].get("com.docker.compose.service") == service]
        if len(matches) != 1 or matches[0]["State"].get("OOMKilled") or matches[0]["State"]["ExitCode"] != 0:
            raise ValueError("exactly one cleanly stopped database container required per store")
        container = matches[0]
        mounts = [m for m in container["Mounts"] if m["Destination"] == target and m["Type"] == "volume"]
        if len(mounts) != 1:
            raise ValueError("expected named database volume")
        volume = mounts[0]["Name"]
        metadata = json.loads(output("volume", "inspect", volume))[0]
        if (metadata.get("Labels") or {}).get("com.docker.compose.project") != project:
            raise ValueError("refusing a volume outside this Compose project")
        stores[logical] = {"volume": volume, "image_id": container["Image"], "image_reference": container["Config"]["Image"]}
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    manifest = {"version": 1, "recorded_at": datetime.now(timezone.utc).isoformat(), "source_project": project, "stores": {}}
    # Reuse the already-present database image; do not pull an unpinned helper.
    helper = stores["pgdata"]["image_id"]
    for logical, metadata in stores.items():
        file = destination / (logical + ".tar.gz")
        with file.open("xb") as stream:
            docker("run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "DAC_READ_SEARCH",
                   "--mount", f"type=volume,src={metadata['volume']},dst=/source,readonly", "--entrypoint", "tar", helper,
                   "-czf", "-", "-C", "/source", ".", stdout=stream)
        manifest["stores"][logical] = {**metadata, "archive": file.name, "sha256": digest(file), "bytes": file.stat().st_size}
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def restore(source, target_project):
    """Validate archive entries, then populate only newly-created named volumes."""
    project_name(target_project)
    if output("ps", "-aq", "--filter", "label=com.docker.compose.project=" + target_project):
        raise ValueError("target project already has containers; choose a fresh recovery project")
    source = Path(source)
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or set(manifest.get("stores", {})) != {"pgdata", "neo4jdata"}:
        raise ValueError("unsupported backup manifest")
    existing = set(output("volume", "ls", "--format", "{{.Name}}").splitlines())
    if any(target_project + "_" + name in existing for name in manifest["stores"]):
        raise ValueError("restore never overwrites existing volumes")
    for logical, metadata in manifest["stores"].items():
        if metadata["archive"] != logical + ".tar.gz":
            raise ValueError("invalid archive filename")
        file = source / metadata["archive"]
        if file.stat().st_size != metadata["bytes"] or digest(file) != metadata["sha256"]:
            raise ValueError("backup integrity mismatch")
        # Reject links/devices and traversal before trusted orchestration extracts.
        with tarfile.open(file, "r:gz") as stream:
            for member in stream:
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
                    raise ValueError("backup contains unsupported or unsafe archive entries")
    helper = manifest["stores"]["pgdata"]["image_id"]
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", helper):
        raise ValueError("backup helper must use a recorded image ID")
    docker("image", "inspect", helper, stdout=subprocess.DEVNULL)
    created = []
    try:
        for logical, metadata in manifest["stores"].items():
            volume = target_project + "_" + logical
            output("volume", "create", "--label", "com.docker.compose.project=" + target_project,
                   "--label", "com.docker.compose.volume=" + logical, volume)
            created.append(volume)
            with (source / metadata["archive"]).open("rb") as stream:
                docker("run", "--rm", "-i", "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "CHOWN",
                       "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--mount", f"type=volume,src={volume},dst=/restore",
                       "--entrypoint", "tar", helper, "-xzf", "-", "-C", "/restore", stdin=stream)
    except Exception:
        for volume in created:
            docker("volume", "rm", volume, stdout=subprocess.DEVNULL)
        raise
    return created


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    backup = sub.add_parser("archive")
    backup.add_argument("--project", required=True)
    backup.add_argument("--destination", type=Path, required=True)
    backup.add_argument("--external-workers-stopped", action="store_true", required=True)
    recovery = sub.add_parser("restore")
    recovery.add_argument("--source", type=Path, required=True)
    recovery.add_argument("--new-project", required=True)
    args = parser.parse_args()
    if args.command == "archive":
        archive(args.project, args.destination)
        print("Both stopped stores archived. Keep credentials/TLS recovery material separately in your vault.")
    else:
        restore(args.source, args.new_project)
        print("New recovery volumes populated. Start matching database images and verify before switching traffic.")


if __name__ == "__main__":
    main()
