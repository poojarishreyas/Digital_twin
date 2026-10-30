"""The threat-hunter MCP bridge: protocol surface, typed-action validation, and that
the executor's boundaries (and only-executed-evidence rule) carry through MCP."""
import json

from twin_ingestion.phase3.contracts import Limits
from twin_ingestion.phase3.direct_lab import DirectLab
from twin_ingestion.phase3.mcp_server import ACTION_MODELS, dispatch, tool_list
from twin_ingestion.phase3.tools import ToolExecutor
from test_phase3_boundaries import FakeLab


def executor(**limits):
    return ToolExecutor(FakeLab(), Limits(**limits))


def test_initialize_and_tool_list_cover_the_eight_typed_actions():
    init = dispatch({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, executor())
    assert init["result"]["serverInfo"]["name"] == "twin-threat-hunter"
    assert init["result"]["protocolVersion"]
    tools = dispatch({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, executor())["result"]["tools"]
    assert {t["name"] for t in tools} == set(ACTION_MODELS)
    for t in tools:
        assert t["inputSchema"]["type"] == "object"
        assert "name" not in t["inputSchema"].get("properties", {})  # tool name encodes the action
        assert "target_id" in t["inputSchema"]["properties"] and "port" in t["inputSchema"]["properties"]


def test_initialized_notification_has_no_response():
    assert dispatch({"jsonrpc": "2.0", "method": "notifications/initialized"}, executor()) is None


def test_security_check_executes_and_returns_a_verdict():
    ex = executor()
    res = dispatch({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
                    "params": {"name": "security_check", "arguments": {"target_id": "target", "port": 8080}}}, ex)["result"]
    assert res.get("isError") is not True
    obs = json.loads(res["content"][0]["text"])
    assert obs["verdict"] == "confirmed" and obs["tool"] == "security_check"
    assert ex.evidence and ex.evidence[0]["verdict"] == "confirmed"  # recorded in the ledger


def test_unregistered_target_is_blocked_through_mcp():
    ex = executor()
    res = dispatch({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                    "params": {"name": "security_check", "arguments": {"target_id": "production-db", "port": 8080}}}, ex)["result"]
    assert res["isError"] is True
    assert "registered" in json.loads(res["content"][0]["text"])["reason"]
    assert ex.evidence == []  # a blocked call produces no evidence


def test_offpolicy_arguments_are_rejected_before_execution():
    ex = executor()
    # Arbitrary SQL is not a valid database_probe argument.
    res = dispatch({"jsonrpc": "2.0", "id": 5, "method": "tools/call",
                    "params": {"name": "database_probe", "arguments": {"target_id": "target", "port": 5432, "query": "DROP TABLE x"}}}, ex)["result"]
    assert res["isError"] is True and json.loads(res["content"][0]["text"])["status"] == "rejected"
    assert not FakeLab().commands  # nothing ran


def test_step_limit_carries_through_mcp():
    ex = executor(max_steps=1)
    call = {"jsonrpc": "2.0", "id": 6, "method": "tools/call",
            "params": {"name": "security_check", "arguments": {"target_id": "target", "port": 8080}}}
    assert dispatch(call, ex)["result"].get("isError") is not True
    blocked = dispatch(call, ex)["result"]
    assert blocked["isError"] is True and "step" in json.loads(blocked["content"][0]["text"])["reason"]


def test_unknown_method_errors_but_unknown_notification_is_ignored():
    assert dispatch({"jsonrpc": "2.0", "id": 7, "method": "nope"}, executor())["error"]["code"] == -32601
    assert dispatch({"jsonrpc": "2.0", "method": "notifications/nope"}, executor()) is None


def test_direct_lab_from_config_and_dns_pin(tmp_path):
    cfg = tmp_path / "targets.json"
    cfg.write_text(json.dumps({"targets": [
        {"id": "web", "host": "dmz-web01", "ip": "10.20.1.173", "port": 8080, "kind": "nginx",
         "service": {"version": "1.27", "directives": [{"name": "server_tokens", "values": ["on"]}]}}]}))
    lab = DirectLab.from_config(cfg)
    assert set(lab.registry) == {"web"} and lab.registry["web"].ip == "10.20.1.173"
    assert lab.service("web")["directives"][0]["name"] == "server_tokens"
    code, out = lab.command("web", ["getent", "hosts", "dmz-web01"])
    assert code == 0 and out.strip() == "10.20.1.173 dmz-web01"  # resolves from trusted config


# ---- new read-only hunting checks (gap 4: more tools) ----
from twin_ingestion.phase3.contracts import RegistryTarget


class MiniLab:
    """One target of a given kind; command() returns a canned response (getent is pinned)."""
    def __init__(self, kind, port, response):
        self.registry = {"t": RegistryTarget(id="t", host="h", ip="10.0.0.5", port=port, kind=kind,
                                              snapshot_hash="a" * 64, image_id="x", fidelity_gaps=[])}
        self.scenario = {}
        self._response = response
    def command(self, target_id, argv, timeout=5):
        return (0, "10.0.0.5 h") if argv[:1] == ["getent"] else (0, self._response)
    def service(self, target_id):
        return {"id": "t", "kind": self.registry["t"].kind, "version": "", "directives": [], "hba_rules": []}


def _call(ex, name, **args):
    return dispatch({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                     "params": {"name": name, "arguments": {"target_id": "t" if "target_id" not in args else args.pop("target_id"), "port": args.pop("port", 8080), **args}}}, ex)["result"]


def test_new_tools_are_listed():
    names = {t["name"] for t in tool_list()}
    assert {"http_headers", "redis_config", "ssh_auth_methods"} <= names and len(names) == 11


def test_http_headers_flags_missing_security_headers_and_version():
    ex = ToolExecutor(MiniLab("nginx", 8080, "HTTP/1.1 200 OK\r\nServer: nginx/1.27.5\r\n\r\n"), Limits())
    obs = json.loads(_call(ex, "http_headers", port=8080)["content"][0]["text"])
    assert obs["version_disclosed"] is True
    assert "strict-transport-security" in obs["security_headers_missing"]
    assert obs["security_headers_present"] == []


def test_redis_config_reports_exposure_and_blocks_wrong_kind():
    ex = ToolExecutor(MiniLab("redis", 6379, "protected-mode\nno"), Limits())
    obs = json.loads(_call(ex, "redis_config", port=6379, parameter="protected-mode")["content"][0]["text"])
    assert obs["parameter"] == "protected-mode" and obs["value"] == "no" and obs["authentication_required"] is False
    # redis_config against an nginx target is refused.
    nginx = ToolExecutor(FakeLab(), Limits())
    res = _call(nginx, "redis_config", target_id="target", port=8080, parameter="bind")
    assert res["isError"] is True and "Redis" in json.loads(res["content"][0]["text"])["reason"]


def test_ssh_auth_methods_parses_offered_methods():
    ex = ToolExecutor(MiniLab("openssh", 22, "probe@h: Permission denied (publickey,password)."), Limits())
    obs = json.loads(_call(ex, "ssh_auth_methods", port=22)["content"][0]["text"])
    assert obs["offered_methods"] == ["password", "publickey"]


def test_new_tool_evidence_joins_ledger():
    ex = ToolExecutor(MiniLab("redis", 6379, "requirepass\n"), Limits())
    _call(ex, "redis_config", port=6379, parameter="requirepass")
    assert ex.evidence and ex.evidence[-1]["tool"] == "redis_config"


# ---- gap 3: hunt disposable twins (sandbox) vs live targets (direct) ----
import twin_ingestion.phase3.mcp_server as mcp_mod


def test_open_lab_direct_uses_directlab(tmp_path, monkeypatch):
    cfg = tmp_path / "t.json"
    cfg.write_text(json.dumps({"targets": [{"id": "web", "host": "h", "ip": "10.0.0.2", "port": 8080, "kind": "nginx"}]}))
    monkeypatch.setenv("TWIN_HUNT_MODE", "direct")
    monkeypatch.setenv("TWIN_HUNT_TARGETS", str(cfg))
    lab, cleanup = mcp_mod.open_lab()
    assert type(lab).__name__ == "DirectLab" and "web" in lab.registry
    cleanup()  # no-op, must not raise


def test_open_lab_sandbox_builds_and_tears_down_twin(tmp_path, monkeypatch):
    events = []

    class FakeLab:  # stands in for runtime.Lab (which needs Docker)
        def __init__(self, scenario, mode, destinations=None):
            events.append(("init", scenario["id"], mode)); self.registry = {}
        def __enter__(self):
            events.append(("enter",)); return self
        def __exit__(self, *a):
            events.append(("exit",))

    import twin_ingestion.phase3.runtime as runtime
    monkeypatch.setattr(runtime, "Lab", FakeLab, raising=True)
    scenario = tmp_path / "s.json"
    scenario.write_text(json.dumps({"id": "lab-redis", "services": [{"id": "target", "kind": "redis", "version": "7.4.2"}]}))
    monkeypatch.setenv("TWIN_HUNT_MODE", "sandbox")
    monkeypatch.setenv("TWIN_HUNT_SCENARIO", str(scenario))
    monkeypatch.setenv("TWIN_HUNT_SANDBOX_MODE", "desktop_smoke")
    lab, cleanup = mcp_mod.open_lab()
    assert ("init", "lab-redis", "desktop_smoke") in events and ("enter",) in events  # twin built
    cleanup()
    assert ("exit",) in events  # twin torn down


def test_open_lab_rejects_bad_mode_and_missing_config(monkeypatch):
    monkeypatch.setenv("TWIN_HUNT_MODE", "nonsense")
    try:
        mcp_mod.open_lab(); assert False
    except SystemExit:
        pass
    monkeypatch.setenv("TWIN_HUNT_MODE", "sandbox")
    monkeypatch.delenv("TWIN_HUNT_SCENARIO", raising=False)
    try:
        mcp_mod.open_lab(); assert False
    except SystemExit as exc:
        assert "TWIN_HUNT_SCENARIO" in str(exc)
