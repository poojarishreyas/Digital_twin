from datetime import datetime, timezone
import pytest
from twin_ingestion.models import Evidence, Relationship


def test_observed_connection_cannot_claim_confirmed_evidence():
    with pytest.raises(ValueError):
        Relationship(
            kind="OBSERVED_CONNECTION", source_id="a", target_id="b",
            evidence=Evidence(source="socket", observed_at=datetime.now(timezone.utc), confidence="confirmed"),
        )


def test_confirmed_transition_requires_confirmed_evidence():
    with pytest.raises(ValueError):
        Relationship(
            kind="CONFIRMED_ATTACK_TRANSITION", source_id="a", target_id="b",
            evidence=Evidence(source="socket", observed_at=datetime.now(timezone.utc), confidence="observed"),
        )

