"""Exposed customer API scenario: tool scope, evidence verdicts and repair boundaries."""
import json

import pytest
from pydantic import ValidationError

from twin_ingestion.customer_api.runtime import CustomerApiLab, synthetic_customers, FIRST_ID, CUSTOMERS
from twin_ingestion.customer_api.verification import (CustomerApiExecutor, OPERATIONS, security,
                                                      cross_customer, workflows)
from pydantic import TypeAdapter

from twin_ingestion.customer_api.contracts import CustomerAction, CustomerDecision
from twin_ingestion.phase3.contracts import ACTION as SHARED_ACTION, Decision, Limits
from twin_ingestion.phase3.model import SHARED_TOOLS, omniroute_decision_schema, scenario_tools
from twin_ingestion.phase3.tools import Blocked

ACTION = TypeAdapter(CustomerAction)


@pytest.mark.parametrize("action", [
    {"name": "customer_api_probe", "target_id": "gateway", "port": 8080, "operation": "http://production/"},
    {"name": "customer_api_probe", "target_id": "gateway", "port": 8080, "operation": "enumerate", "ids": ["1"]},
    {"name": "customer_api_probe", "target_id": "gateway", "port": 8080, "operation": "lookup", "credential": "x"},
    {"name": "customer_api_patch", "target_id": "gateway", "port": 8080, "policy": "open"},
])
def test_customer_tools_cannot_choose_urls_identifiers_credentials_or_policies(action):
    with pytest.raises(ValidationError):
        ACTION.validate_python(action)


def test_scenario_schema_offers_only_customer_tools_and_leaves_shared_hunts_unchanged():
    tools = scenario_tools(CustomerDecision.model_json_schema())
    assert sorted(tools) == ["customer_api_patch", "customer_api_probe", "inspect_config"]
    assert omniroute_decision_schema(tools)["properties"]["action"]["properties"]["name"]["enum"] == tools
    assert scenario_tools(Decision.model_json_schema()) is None
    assert omniroute_decision_schema()["properties"]["action"]["properties"]["name"]["enum"] == SHARED_TOOLS
    with pytest.raises(ValidationError):
        SHARED_ACTION.validate_python({"name": "customer_api_probe", "target_id": "g", "port": 8080,
                                       "operation": "enumerate"})
    with pytest.raises(ValidationError):  # Other scenarios' tools are not offered here.
        ACTION.validate_python({"name": "company_probe", "target_id": "g", "port": 8080, "operation": "restricted"})


def test_synthetic_customers_are_sequential_marked_and_tenant_specific():
    acme, globex = synthetic_customers("acme"), synthetic_customers("globex")
    assert list(acme) == [str(FIRST_ID + n) for n in range(CUSTOMERS)]
    assert all("(synthetic)" in c["full_name"] and c["email"].endswith(".example.invalid")
               and c["id_document"].startswith("SYN-") for c in acme.values())
    assert acme == synthetic_customers("acme")
    assert acme[str(FIRST_ID)]["id_document"] != globex[str(FIRST_ID)]["id_document"]
    assert OPERATIONS["enumerate"] == list(acme)[:20]


def test_internet_client_and_gateway_hold_no_credentials():
    lab = object.__new__(CustomerApiLab)
    lab.tenant, lab.policy = "acme", "open"
    lab.credentials = {n: "synthetic-private-" + n for n in ("customer", "staff", "database", "database_admin")}
    for role in ("internet", "gateway"):
        assert all(secret not in json.dumps(lab.config(role)) for secret in lab.credentials.values())
    api = json.dumps(lab.config("api"))
    assert lab.credentials["staff"] in api and lab.credentials["database_admin"] not in api


class Lab:
    tenant = "acme"
    target_id = "acme-job:gateway"
    policy = "open"

    def __init__(self, status=200, returned=True, correlated=True):
        self.status, self.returned, self.correlated, self.calls = status, returned, correlated, []

    def fetch(self, ids, actor):
        self.calls.append((tuple(ids), actor))
        return {"actor": actor, "observations": [
            {"request_id": f"{i:032x}", "customer_id": cid, "http_status": self.status,
             "returned_expected_record": self.returned, "chain_verified": self.correlated,
             "fields_returned": ["email", "id_document"] if self.returned else [],
             "record_hash": "h" if self.returned else None, "database_audit": {"status": self.status}}
            for i, cid in enumerate(ids)]}

    def masked_sample(self, customer_id):
        return {"customer_id": customer_id}

    def identity(self):
        return {"policy": self.policy}


@pytest.mark.parametrize("status,returned,correlated,expected", [
    (200, True, True, "confirmed"), (200, True, False, "inconclusive"),
    (200, False, True, "inconclusive"), (401, False, True, "not_reproduced"),
    (403, False, True, "not_reproduced"), (503, False, False, "inconclusive"),
    (401, False, False, "inconclusive")])
def test_only_correlated_seeded_records_confirm_exposure(status, returned, correlated, expected):
    assert security(Lab(status, returned, correlated), "enumerate")["verdict"] == expected


def test_attack_probes_are_unauthenticated_and_bounded():
    lab = Lab()
    result = security(lab, "enumerate")
    assert lab.calls == [(tuple(OPERATIONS["enumerate"]), "anonymous")]
    assert result["records_exposed"] == 20 and result["fields_exposed"] == ["email", "id_document"]
    assert set(result["observations"][0]) == {"request_id", "customer_id", "status", "matched_seeded_record",
                                              "chain_verified", "audit_status"}


def test_signed_in_customer_reading_a_neighbour_counts_as_exposure():
    assert cross_customer(Lab())["verdict"] == "confirmed"
    assert cross_customer(Lab(403, False, True))["verdict"] == "not_reproduced"


def test_outage_or_deny_all_is_not_a_passing_legitimate_workflow():
    assert not workflows(Lab(503, False, False))["passed"]
    assert not workflows(Lab(403, False, True))["passed"]
    assert workflows(Lab())["passed"]


def test_foreign_target_is_blocked_before_any_request():
    lab = Lab()
    executor = CustomerApiExecutor(lab, {}, Limits(max_seconds=60))
    with pytest.raises(Blocked, match="registered"):
        executor.execute(ACTION.validate_python({"name": "customer_api_probe", "target_id": "globex-job:gateway",
                                                 "port": 8080, "operation": "enumerate"}))
    assert not lab.calls and not executor.evidence


def test_repair_requires_executed_exposure_and_runs_once():
    lab, verified = Lab(), []
    executor = CustomerApiExecutor(lab, {}, Limits(max_seconds=60),
                                   verifier=lambda original, images: verified.append(1) or {"label": "stub"})
    patch = ACTION.validate_python({"name": "customer_api_patch", "target_id": lab.target_id, "port": 8080,
                                    "policy": "require_customer_authorization"})
    with pytest.raises(Blocked, match="executed"):
        executor.execute(patch)
    assert not lab.calls and not verified
    executor.execute(ACTION.validate_python({"name": "customer_api_probe", "target_id": lab.target_id,
                                             "port": 8080, "operation": "lookup"}))
    executor.execute(patch)
    with pytest.raises(Blocked, match="one candidate"):
        executor.execute(patch)
    assert verified == [1]


def test_hunt_uses_the_scenario_schema_and_refuses_foreign_tools():
    from twin_ingestion.phase3.hunter import hunt
    from twin_ingestion.phase3.model import ReplayModel
    lab = Lab()
    target = {"target_id": lab.target_id, "port": 8080}
    model = ReplayModel([
        {"hypothesis": "try another scenario's tool", "action": {"name": "company_probe", **target, "operation": "restricted"}, "stop": False},
        {"hypothesis": "enumerate", "action": {"name": "customer_api_probe", **target, "operation": "enumerate"}, "stop": True}])
    executor = CustomerApiExecutor(lab, {}, Limits(max_seconds=60))
    result = hunt(model, executor, executor.state(), Limits(max_seconds=60), decision_model=CustomerDecision)
    assert result["trace"][0]["kind"] == "model_error" and result["status"] == "model_error"
    assert not lab.calls
