"""Synthetic lab identities. Replace this fixture identity provider in real apps."""
import hmac
import os


def authenticate(headers):
    authorization = headers.get("Authorization", "")
    identities = (
        (os.environ.get("LAB_CUSTOMER_A_TOKEN", "synthetic-alice-token"), {"customer_id": "CUST-10001", "role": "customer"}),
        (os.environ.get("LAB_CUSTOMER_B_TOKEN", "synthetic-bob-token"), {"customer_id": "CUST-10002", "role": "customer"}),
        (os.environ.get("LAB_SUPPORT_TOKEN", "synthetic-support-token"), {"customer_id": None, "role": "support"}),
    )
    for token, principal in identities:
        if token and hmac.compare_digest(authorization, "Bearer " + token):
            return principal
    return None
