"""Temporary synthetic end-to-end ingestion check for the audit Compose project."""
import hashlib
import json
import os
import ssl
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import grpc


root = Path(__file__).resolve().parents[1]
certs = root / "certs"
api_url = os.environ.get("TWIN_API_URL", "http://127.0.0.1:8080")
api_headers = {"Authorization": "Bearer " + os.environ["TWIN_API_TOKEN"]} if os.environ.get("TWIN_API_TOKEN") else {}
api_context = ssl.create_default_context(cafile=os.environ.get("TWIN_API_CA"))
def client(name):
    creds = grpc.ssl_channel_credentials(
        root_certificates=(certs / "ca.crt").read_bytes(),
        private_key=(certs / (name + ".key")).read_bytes(),
        certificate_chain=(certs / (name + ".crt")).read_bytes(),
    )
    channel = grpc.secure_channel("127.0.0.1:8443", creds,
        options=[("grpc.ssl_target_name_override", "ingestion.local")])
    return channel.unary_unary("/twin.telemetry.v1.TelemetryIngest/Sync",
        request_serializer=lambda value: json.dumps(value).encode(),
        response_deserializer=lambda value: json.loads(value))


sync_windows = client("agent")
sync_linux = client("agent-linux")


def stamp():
    return datetime.now(timezone.utc).isoformat()


def envelope(host_id, os_name, sequence, components, relationships, removed=(), full=True, gaps=()):
    now = stamp()
    return {"schema_version": "1.0", "agent_id": host_id, "sequence": sequence,
        "sent_at": now, "full_snapshot": full,
        "host": {"id": host_id, "hostname": host_id, "os": os_name,
                 "architecture": "amd64", "hardware": {"cpu": "synthetic"}},
        "components": components, "removed": list(removed), "relationships": relationships,
        "gaps": list(gaps),
        "metrics": {"collection_ms": 4, "cpu_percent": 0.1, "ram_bytes": 4096,
                    "envelope_bytes": 0, "polling_interval_sec": 30}}


def api(path):
    with urllib.request.urlopen(urllib.request.Request(api_url + path, headers=api_headers), timeout=5, context=api_context) as response:
        return json.load(response)


def classify(asset_id, entry, critical):
    request = urllib.request.Request(
        api_url + "/api/assets/" + asset_id + "/classification",
        data=json.dumps({"entry": entry, "critical": critical}).encode(),
        headers={"Content-Type": "application/json", **api_headers}, method="PUT")
    with urllib.request.urlopen(request, timeout=5, context=api_context) as response:
        return json.load(response)


windows = (certs / "agent.id").read_text().strip()
linux = (certs / "agent-linux.id").read_text().strip()
service_id = "service:" + windows + ":nginx"
linux_service_id = "service:" + linux + ":nginx"
old_listener_id = "listener:" + windows + ":tcp:8080"
new_listener_id = "listener:" + windows + ":tcp:8081"
evidence = {"source": "synthetic-audit", "observed_at": stamp(), "confidence": "observed"}
data = {"name": "nginx", "version": "1.27.5", "password": "seeded-audit-secret"}
old_archetype = hashlib.sha256(b"nginx-audit").hexdigest()
new_archetype = hashlib.sha256(b"nginx-audit-edited").hexdigest()
component = {"kind": "service", "id": service_id,
    "hash": hashlib.sha256(b"nginx-initial-sanitized").hexdigest(),
    "archetype_hash": old_archetype,
    "data": data, "evidence": evidence}
linux_component = {**component, "id": linux_service_id,
                   "data": {"name": "nginx", "version": "1.27.5"}}
relation = {"kind": "HAS_SERVICE", "source_id": windows, "target_id": service_id,
            "evidence": evidence}
linux_relation = {"kind": "HAS_SERVICE", "source_id": linux, "target_id": linux_service_id,
                  "evidence": evidence}
old_listener = {"kind": "listener", "id": old_listener_id,
                "hash": hashlib.sha256(b"tcp-8080").hexdigest(), "data": {"port": 8080},
                "evidence": evidence}
old_listener_relation = {"kind": "HAS_LISTENER", "source_id": windows,
                         "target_id": old_listener_id, "evidence": evidence}
transient_relation = {"kind": "HAS_CONFIGURATION", "source_id": windows,
                      "target_id": service_id, "evidence": evidence}
new_listener = {**old_listener, "id": new_listener_id,
                "hash": hashlib.sha256(b"tcp-8081").hexdigest(), "data": {"port": 8081}}
new_listener_relation = {**old_listener_relation, "target_id": new_listener_id}
gap = {"collector": "firewall", "field": "rules", "reason": "permission_denied", "at": stamp()}

first = envelope(windows, "windows", 1, [component, old_listener],
                 [relation, old_listener_relation, transient_relation])
ack1 = sync_windows(first, timeout=10)
duplicate = sync_windows(first, timeout=10)
wrong_identity = sync_windows(envelope(linux, "linux", 1, [], []), timeout=10)
linux_ack = sync_linux(envelope(linux, "linux", 1, [linux_component], [linux_relation], gaps=[gap]), timeout=10)
before = api("/api/topology")
inventory = api("/api/inventory")
updated_component = {**component, "hash": hashlib.sha256(b"nginx-edited-sanitized").hexdigest(),
                     "archetype_hash": new_archetype,
                     "data": {"name": "nginx", "version": "1.27.5", "server_tokens": "off"}}
edit_ack = sync_windows(envelope(windows, "windows", 2, [updated_component, new_listener],
                         [relation, new_listener_relation], removed=[old_listener_id], full=False), timeout=10)
edited = api("/api/topology")
reconcile_ack = sync_windows(envelope(windows, "windows", 3, [updated_component, new_listener],
                              [relation, new_listener_relation], full=True), timeout=10)
reconciled = api("/api/topology")
remove_ack = sync_windows(envelope(windows, "windows", 4, [], [], full=True), timeout=10)
after = api("/api/topology")

assert ack1["accepted_sequence"] == 1 and not ack1["duplicate"], ack1
assert duplicate["duplicate"] and duplicate["accepted_sequence"] == 1, duplicate
assert wrong_identity["accepted_sequence"] == 0 and "certificate identity" in wrong_identity["error"], wrong_identity
assert linux_ack["accepted_sequence"] == 1 and not linux_ack["duplicate"], linux_ack
assert edit_ack["accepted_sequence"] == 2 and not edit_ack["duplicate"], edit_ack
assert reconcile_ack["accepted_sequence"] == 3 and not reconcile_ack["duplicate"], reconcile_ack
assert remove_ack["accepted_sequence"] == 4 and not remove_ack["duplicate"], remove_ack
assert any(node["id"] == service_id for node in before["nodes"]), before
assert any(node["id"] == linux_service_id for node in before["nodes"]), before
assert any(node["id"] == "archetype:" + old_archetype for node in before["nodes"]), before
assert {e["source"] for e in before["edges"] if e["kind"] == "INSTANCE_OF" and
        e["target"] == "archetype:" + old_archetype} >= {service_id, linux_service_id}, before
assert not any(node["id"] == old_listener_id for node in edited["nodes"]), edited
assert not any(edge["source"] == windows and edge["target"] == service_id and
               edge["kind"] == "HAS_CONFIGURATION" for edge in edited["edges"]), edited
assert len([node for node in edited["nodes"] if node["id"] == new_listener_id]) == 1
assert [e["target"] for e in edited["edges"] if e["source"] == service_id and
        e["kind"] == "INSTANCE_OF"] == ["archetype:" + new_archetype], edited
assert len([node for node in reconciled["nodes"] if node["id"] == service_id]) == 1
assert len([node for node in reconciled["nodes"] if node["id"] == new_listener_id]) == 1
assert not any(node["id"] == service_id for node in after["nodes"]), after
assert not any(node["id"] == new_listener_id for node in after["nodes"]), after
assert any(node["id"] == linux_service_id for node in after["nodes"]), after
assert len([node for node in after["nodes"] if node["id"] == windows]) == 1
assert len([node for node in after["nodes"] if node["id"] == linux]) == 1
assert "seeded-audit-secret" not in json.dumps(before)
assert any(row["agent_id"] == linux and row["gaps"] for row in inventory), inventory

connection = {"kind": "OBSERVED_CONNECTION", "source_id": windows, "target_id": linux,
              "evidence": evidence}
path_ack = sync_windows(envelope(windows, "windows", 5, [], [connection], full=False), timeout=10)
classify(windows, True, False)
classify(linux, False, True)
paths = api("/api/paths?max_depth=4")["paths"]
assert path_ack["accepted_sequence"] == 5 and not path_ack["duplicate"], path_ack
matching = [path for path in paths if path and path[0]["source"] == windows and path[-1]["target"] == linux]
assert len(matching) == 1 and matching[0][0]["kind"] == "OBSERVED_CONNECTION", paths
assert matching[0][0]["observed_at"] and matching[0][0]["evidence_source"], paths

# A synthetic two-hop route exercises evidence analysis and read-only isolation.
critical_endpoint = "endpoint:synthetic-audit-critical"
second_hop = {"kind": "OBSERVED_CONNECTION", "source_id": linux, "target_id": critical_endpoint,
              "evidence": evidence}
chain_ack = sync_linux(envelope(linux, "linux", 2, [], [linux_relation, second_hop],
                                 full=False, gaps=[gap]), timeout=10)
assert chain_ack["accepted_sequence"] == 2, chain_ack
classify(linux, False, False)
classify(critical_endpoint, False, True)
analysis = api("/api/paths?max_depth=4")
assert len(analysis["assessments"]) == 1 and analysis["assessments"][0]["hop_count"] == 2, analysis
assert analysis["assessments"][0]["validation_status"] == "unvalidated", analysis
assert any(issue["reason"] == "collection_gaps" for issue in analysis["assessments"][0]["issues"]), analysis
assert analysis["review_points"][0]["asset_id"] == linux, analysis
preview = api("/api/paths?max_depth=4&isolated_asset=" + linux)
assert preview["isolation_preview"]["affected_count"] == 1, preview
assert preview["isolation_preview"]["remaining_count"] == 0, preview
assert len(api("/api/paths?max_depth=4")["paths"]) == 1

# Valid client credentials cannot overwrite another host or manufacture a confirmation.
foreign_component = {**linux_component, "data": {"name": "forged"}}
foreign_ack = sync_windows(envelope(windows, "windows", 6, [foreign_component], [], full=False), timeout=10)
assert foreign_ack["accepted_sequence"] == 0 and foreign_ack["error"] == "invalid telemetry", foreign_ack
forged_transition = {**connection, "kind": "CONFIRMED_ATTACK_TRANSITION",
                     "evidence": {**evidence, "confidence": "confirmed"}}
forged_ack = sync_windows(envelope(windows, "windows", 6, [], [forged_transition], full=False), timeout=10)
assert forged_ack["accepted_sequence"] == 0, forged_ack
assert not any(edge["kind"] == "CONFIRMED_ATTACK_TRANSITION" for edge in api("/api/topology")["edges"])
malformed = envelope(windows, "windows", 6, [], [], full=False)
malformed["host"]["os"] = "seeded-audit-secret"
malformed_ack = sync_windows(malformed, timeout=10)
assert malformed_ack["error"] == "invalid telemetry" and "seeded-audit-secret" not in json.dumps(malformed_ack)

print(json.dumps({"mtls_ingest": True, "windows_and_linux_synthetic_hosts": True,
                  "certificate_identity_enforced": True,
                  "duplicate_idempotent": True, "service_removal_converged": True,
                  "config_and_port_edit_converged": True, "full_snapshot_reconciled": True,
                  "archetype_host_edges_preserved": True,
                  "secret_absent_from_graph": True, "permission_gap_visible": True,
                  "evidenced_candidate_path": True,
                  "two_hop_evidence_analysis": True, "isolation_preview_read_only": True,
                  "cross_host_write_rejected": True, "forged_confirmation_rejected": True,
                  "invalid_payload_not_echoed": True,
                  "nodes_after": len(after["nodes"])}, indent=2))
