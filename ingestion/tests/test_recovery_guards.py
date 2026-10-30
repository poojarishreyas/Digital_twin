"""Recovery refuses unsafe input before it creates or writes Docker volumes."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile

import pytest

spec = importlib.util.spec_from_file_location("cold_backup", Path(__file__).resolve().parents[2] / "deploy/ops/cold_backup.py")
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def fixture_backup(path, unsafe=None):
    stores = {}
    for logical in ("pgdata", "neo4jdata"):
        archive = path / (logical + ".tar.gz")
        with tarfile.open(archive, "w:gz") as stream:
            entry = tarfile.TarInfo(unsafe or "data/record")
            entry.size = 4
            stream.addfile(entry, io.BytesIO(b"test"))
        stores[logical] = {"archive": archive.name, "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
                           "bytes": archive.stat().st_size, "image_id": "sha256:" + "1" * 64}
    (path / "manifest.json").write_text(json.dumps({"version": 1, "stores": stores}))


def test_cold_backup_refuses_active_deployment(tmp_path, monkeypatch):
    monkeypatch.setattr(backup, "output", lambda *args: "active-container")
    with pytest.raises(ValueError, match="stop ALL"):
        backup.archive("company", tmp_path / "backup")
    assert not (tmp_path / "backup").exists()


@pytest.mark.parametrize("unsafe", ["../../escape", "/absolute"])
def test_restore_rejects_archive_traversal_before_creating_volumes(tmp_path, monkeypatch, unsafe):
    fixture_backup(tmp_path, unsafe)
    monkeypatch.setattr(backup, "output", lambda *args: "")
    monkeypatch.setattr(backup, "docker", lambda *args, **kwargs: pytest.fail("must not write a volume"))
    with pytest.raises(ValueError, match="unsafe archive"):
        backup.restore(tmp_path, "fresh-recovery")


def test_restore_rejects_tampering_and_existing_target(tmp_path, monkeypatch):
    fixture_backup(tmp_path)
    monkeypatch.setattr(backup, "output", lambda *args: "fresh-recovery_pgdata" if args[0] == "volume" else "")
    with pytest.raises(ValueError, match="never overwrites"):
        backup.restore(tmp_path, "fresh-recovery")
    monkeypatch.setattr(backup, "output", lambda *args: "")
    with (tmp_path / "pgdata.tar.gz").open("ab") as stream:
        stream.write(b"tamper")
    with pytest.raises(ValueError, match="integrity mismatch"):
        backup.restore(tmp_path, "fresh-recovery")
