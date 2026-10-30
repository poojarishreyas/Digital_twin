from twin_ingestion.sanitize import REDACTED, sanitize


def test_recursive_secret_removal():
    value = {"safe": "ok", "password": "seeded-secret", "nested": [{"url": "redis://user:seeded-secret@cache/0"}]}
    clean = sanitize(value)
    assert clean["password"] == REDACTED
    assert "seeded-secret" not in str(clean)

