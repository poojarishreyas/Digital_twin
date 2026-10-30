"""Issue agent client certificates from enrollment requests.

Use a dedicated issuing CA for enrollment so its key only ever signs agent client
certificates; the ingestion gRPC server trusts it alongside the lab CA. The
requested subject is ignored: the certificate's common name is always the
server-chosen agent ID, which is what binds telemetry to one tenant.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import re
import secrets

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

HOSTNAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,252}")


class EnrollmentError(ValueError):
    pass


class CertificateIssuer:
    def __init__(self, ca_cert_path: str, ca_key_path: str, server_ca_path: str, days: int = 365):
        self.ca_cert = x509.load_pem_x509_certificate(Path(ca_cert_path).read_bytes())
        self.ca_key = serialization.load_pem_private_key(Path(ca_key_path).read_bytes(), password=None)
        # The CA the agent must trust for the server's certificate (not necessarily the issuer).
        self.server_ca_pem = Path(server_ca_path).read_text(encoding="utf-8")
        self.issuer_pem = self.ca_cert.public_bytes(serialization.Encoding.PEM).decode()
        if not 1 <= days <= 825:
            raise ValueError("agent certificate validity must be 1-825 days")
        self.days = days

    @staticmethod
    def check_csr(csr_pem: str) -> x509.CertificateSigningRequest:
        if not isinstance(csr_pem, str) or len(csr_pem) > 8192 or "BEGIN CERTIFICATE REQUEST" not in csr_pem:
            raise EnrollmentError("a PEM certificate signing request is required")
        try:
            csr = x509.load_pem_x509_csr(csr_pem.encode())
        except Exception:
            raise EnrollmentError("certificate signing request could not be parsed") from None
        if not csr.is_signature_valid:
            raise EnrollmentError("certificate signing request signature is invalid")
        key = csr.public_key()
        if isinstance(key, rsa.RSAPublicKey):
            if key.key_size < 2048:
                raise EnrollmentError("RSA keys must be at least 2048 bits")
        elif isinstance(key, ec.EllipticCurvePublicKey):
            if not isinstance(key.curve, (ec.SECP256R1, ec.SECP384R1)):
                raise EnrollmentError("EC keys must use P-256 or P-384")
        else:
            raise EnrollmentError("only RSA and EC keys are accepted")
        return csr

    def issue(self, csr: x509.CertificateSigningRequest, agent_id: str):
        now = datetime.now(timezone.utc)
        not_after = now + timedelta(days=self.days)
        serial = x509.random_serial_number()
        certificate = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, agent_id)]))
            .issuer_name(self.ca_cert.subject)
            .public_key(csr.public_key())
            .serial_number(serial)
            .not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(not_after)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                         data_encipherment=False, key_agreement=False, key_cert_sign=False,
                                         crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(csr.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(self.ca_key.public_key()), critical=False)
            .sign(self.ca_key, hashes.SHA256()))
        return certificate.public_bytes(serialization.Encoding.PEM).decode(), format(serial, "x"), not_after


def clean_hostname(value: str) -> str:
    value = (value or "").strip()[:253]
    return value if HOSTNAME.fullmatch(value) else "unnamed-host"


def new_agent_id() -> str:
    return secrets.token_hex(16)
