"""Declared fixture hypotheses. Independent wire checks verify them before scoring."""
import json
from pathlib import Path


def d(name, value, order=1, section=""):
    return dict(order=order, name=name, values=[value], section=section)


def h(method, order=1):
    return dict(order=order, name="rule", values=["host", "all", "all", "0.0.0.0/0", method])


def build():
    rows = []
    versions = {"nginx": "1.27.5", "postgresql": "17.2", "redis": "7.4.2", "openssh": "9.9p2"}
    def add(kind, description, positive, directives, hba=None):
        rows.append(dict(id=f"s{len(rows)+1:02}", description=description, proposed_truth=positive,
            test=kind + ".policy", services=[dict(id="target", kind=kind, version=versions[kind],
            directives=directives, hba_rules=hba or [])], links=[]))
    add("nginx", "Version header disclosure enabled", True, [d("server_tokens", "on")])
    add("nginx", "Version header disclosure disabled", False, [d("server_tokens", "off")])
    add("nginx", "Disclosure enabled with request body limit", True, [d("server_tokens", "on"), d("client_max_body_size", "1m", 2)])
    add("nginx", "Disclosure disabled with request body limit", False, [d("server_tokens", "off"), d("client_max_body_size", "2m", 2)])
    add("postgresql", "Unauthenticated synthetic SQL via trust", True, [d("listen_addresses", "*")], [h("trust")])
    add("postgresql", "SCRAM requires a password", False, [d("listen_addresses", "*")], [h("scram-sha-256")])
    add("postgresql", "First HBA reject precedes trust", False, [d("listen_addresses", "*")], [h("reject"), h("trust", 2)])
    add("postgresql", "First HBA trust precedes reject", True, [d("listen_addresses", "*")], [h("trust"), h("reject", 2)])
    add("redis", "Unauthenticated remote PING", True, [d("protected-mode", "no")])
    add("redis", "Protected mode denies remote unauthenticated client", False, [d("protected-mode", "yes")])
    add("redis", "Synthetic password required with protection disabled", False, [d("protected-mode", "no"), d("requirepass", "<redacted>", 2)])
    add("redis", "Explicit wildcard with unauthenticated access", True, [d("bind", "0.0.0.0"), d("protected-mode", "no", 2)])
    add("openssh", "Synthetic password login enabled", True, [d("passwordauthentication", "yes")])
    add("openssh", "Password login disabled", False, [d("passwordauthentication", "no")])
    add("openssh", "DenyUsers blocks synthetic login despite password enabled", False, [d("passwordauthentication", "yes"), d("denyusers", "synthetic", 2)])
    add("openssh", "AllowUsers permits synthetic password login", True, [d("passwordauthentication", "yes"), d("allowusers", "synthetic", 2)])
    for denied in (False, True):
        rows.append(dict(id=f"s{len(rows)+1:02}", description="Two-service proxy " + ("denies" if denied else "reaches") + " synthetic backend",
            proposed_truth=not denied, test="proxy_chain", services=[
                dict(id="front", kind="nginx", version="1.27.5", upstream="back", directives=[
                    d("proxy_pass", "http://source-backend:8080", section="http/server/location /")] + ([d("deny", "all", 2)] if denied else [])),
                dict(id="back", kind="nginx", version="1.27.5", directives=[d("server_tokens", "off")])], links=[["front", "back"]]))
    add("redis", "Unavailable source version is not silently replaced", None, [d("protected-mode", "no")])
    rows[-1]["services"][0]["version"] = "6.0.0"
    add("openssh", "Unsupported Match section remains excluded", None, [d("passwordauthentication", "yes", section="User synthetic")])
    return {"schema_version": "1.0", "truth_status": "hypotheses_require_independent_wire_verification", "scenarios": rows}


if __name__ == "__main__":
    Path(__file__).with_name("scenarios.json").write_text(json.dumps(build(), indent=2) + "\n", encoding="utf-8")
