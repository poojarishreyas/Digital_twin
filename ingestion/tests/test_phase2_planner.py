from twin_ingestion.phase2.planner import Service, enumerate_paths, plan


def test_multi_hop_services_are_co_scheduled_or_untested():
    services = [Service("nginx-a", "entry", "nginx", "1.27.5", "a", cpu_millis=300, ram_mb=100),
                Service("nginx-b", "critical", "nginx", "1.27.5", "b", cpu_millis=300, ram_mb=100)]
    edges = [{"source": "entry", "target": "critical", "kind": "OBSERVED_CONNECTION"}]
    fitting = plan(["entry"], ["critical"], edges, services, cpu_budget_millis=800, ram_budget_mb=400)
    assert fitting.waves[0].service_ids == ["nginx-a", "nginx-b"]
    assert fitting.paths[0].status == "planned"
    too_small = plan(["entry"], ["critical"], edges, services, cpu_budget_millis=500, ram_budget_mb=400)
    assert not too_small.waves
    assert too_small.paths[0].reason == "bundle_exceeds_budget"


def test_path_universe_excludes_confirmed_transitions_and_is_bounded():
    edges = [{"source": "a", "target": "b", "kind": "OBSERVED_CONNECTION"},
             {"source": "a", "target": "c", "kind": "CONFIRMED_ATTACK_TRANSITION"},
             {"source": "b", "target": "c", "kind": "INFERRED_REACHABILITY"}]
    paths, truncated, excluded = enumerate_paths(["a"], ["c"], edges, max_hops=2)
    assert paths == [(('a', 'b', 'c'), ('OBSERVED_CONNECTION', 'INFERRED_REACHABILITY'))]
    assert not truncated
    assert excluded[0]["reason"] == "edge_kind_excluded"


def test_path_cap_reports_truncation():
    edges = [{"source": "a", "target": f"middle-{i}", "kind": "OBSERVED_CONNECTION"} for i in range(3)]
    edges += [{"source": f"middle-{i}", "target": "z", "kind": "OBSERVED_CONNECTION"} for i in range(3)]
    paths, truncated, _ = enumerate_paths(["a"], ["z"], edges, max_hops=2, max_paths=2)
    assert len(paths) == 2 and truncated


def test_path_with_unrepresented_dependency_is_untested():
    services = [Service("nginx-a", "entry", "nginx", "1.27.5", "a")]
    edges = [{"source": "entry", "target": "critical", "kind": "OBSERVED_CONNECTION"}]
    result = plan(["entry"], ["critical"], edges, services)
    assert result.waves == []
    assert result.paths[0].reason == "unsupported_or_missing_service_on_path"

