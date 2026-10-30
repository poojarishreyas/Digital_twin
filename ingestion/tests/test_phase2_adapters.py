import json
from pathlib import Path
import pytest
from twin_ingestion.phase2.adapters import render

FIXTURES = json.loads((Path(__file__).resolve().parents[2] / "emulation" / "fixtures" / "core-behavior.json").read_text())


@pytest.mark.parametrize("fixture", FIXTURES, ids=lambda f: f["service"] + "-" + f["case"])
def test_fixed_behavior_fixture_renders_explicit_policy(fixture):
    rendered = render(fixture["service"], fixture["version"], fixture["directives"], fixture.get("hba_rules"))
    assert rendered.supported, rendered.fidelity_gaps
    content = "\n".join(rendered.files.values())
    expected = fixture["directives"][-1]["values"][0]
    if fixture["service"] == "postgresql":
        expected = fixture["hba_rules"][0]["values"][-1]
    assert expected in content


def test_unknown_version_and_directive_fail_visibly():
    rendered = render("redis", "6.0.0", [{"order": 1, "name": "tls-port", "values": ["6380"]}])
    assert not rendered.supported
    assert any(g.startswith("version_unavailable") for g in rendered.fidelity_gaps)
    assert any(g.startswith("directive_unsupported") for g in rendered.fidelity_gaps)


def test_nginx_proxy_requires_mapped_dependency():
    directives = [{"order": 1, "name": "proxy_pass", "values": ["http://upstream:8080"], "section": "http/server/location /"}]
    assert not render("nginx", "1.27.5", directives).supported
    linked = render("nginx", "1.27.5", directives, upstream_alias="twin-upstream:8080", instance_marker="abc")
    assert linked.supported
    assert "proxy_pass http://twin-upstream:8080" in linked.files["nginx.conf"]

