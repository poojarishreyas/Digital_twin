import re
from typing import Any

REDACTED = "<redacted>"
SECRET_KEY = re.compile(r"password|passwd|secret|token|private[_-]?key|credential|community|auth[_-]?key", re.I)
CREDENTIAL_URL = re.compile(r"([a-z][a-z0-9+.-]*://[^:/\s]+:)[^@/\s]+(@)", re.I)
PEM_KEY = re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----", re.I | re.S)


def sanitize(value: Any, key: str = "") -> Any:
    if SECRET_KEY.search(key):
        return REDACTED
    if isinstance(value, dict):
        return {str(k): sanitize(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    if isinstance(value, str):
        return PEM_KEY.sub(REDACTED, CREDENTIAL_URL.sub(r"\1" + REDACTED + r"\2", value))
    return value

