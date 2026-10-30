"""Derived research insights: agent behaviour, method disagreement, patch funnel, trace integrity.

Everything here is computed from a stored report's raw rows. Nothing is
estimated: missing traces, unavailable models and unlabeled scenarios stay
visible as such instead of being folded into averages.
"""
from __future__ import annotations

from collections import Counter
import statistics

from .hunter import verify_trace

CONCLUSIVE = {"confirmed", "not_reproduced"}
PATCH_STAGES = (
    ("attempted", "Candidate edits attempted"),
    ("reproduced", "Original weakness reproduced"),
    ("original_workflow", "Original workflow works"),
    ("syntax_and_startup", "Candidate starts cleanly"),
    ("security_fixed", "Security retest no longer reproduces"),
    ("legitimate_workflow", "Legitimate workflow preserved"),
    ("accepted", "Verified in the tested twin scenario"),
)


def _outcome(row):
    if row.get("status") == "unavailable":
        return "unavailable"
    if row.get("status") != "completed" or not isinstance(row.get("prediction"), bool) \
            or not row.get("truth_verified") or not isinstance(row.get("truth"), bool):
        return "abstain"
    return "correct" if row["prediction"] == row["truth"] else "wrong"


def _blocked_reason(payload):
    if payload.get("status") == "duplicate":
        return "duplicate action"
    return str(payload.get("reason", "blocked"))[:80]


def _steps_to_evidence(trace):
    """Actions taken until the first conclusive executed observation, or None."""
    actions = 0
    for event in trace:
        if event.get("kind") == "action":
            actions += 1
        elif event.get("kind") == "observation" and event.get("payload", {}).get("verdict") in CONCLUSIVE:
            return actions
    return None


def agent_behaviour(rows):
    traced = [r for r in rows if r.get("trace")]
    events = [e for r in traced for e in r["trace"]]
    steps = [s for s in (_steps_to_evidence(r["trace"]) for r in traced) if s is not None]
    integrity = [(r, verify_trace(r["trace"])) for r in traced]
    positives = [r for r in rows if r.get("prediction") is True and r.get("status") == "completed"]
    return {
        "traced_runs": len(traced),
        "actions_total": sum(e.get("kind") == "action" for e in events),
        "actions_per_run": statistics.mean([sum(e.get("kind") == "action" for e in r["trace"]) for r in traced]) if traced else None,
        "tool_usage": dict(Counter(e["payload"].get("name", "unknown") for e in events if e.get("kind") == "action").most_common()),
        "blocked_reasons": dict(Counter(_blocked_reason(e.get("payload", {})) for e in events if e.get("kind") == "blocked").most_common()),
        "finish_status": dict(Counter(next((e["payload"].get("status") for e in reversed(r["trace"]) if e.get("kind") == "finished"), "unfinished")
                                      for r in traced).most_common()),
        "model_errors": sum(e.get("kind") == "model_error" for e in events),
        "steps_to_conclusive_evidence": {"mean": statistics.mean(steps) if steps else None,
                                         "median": statistics.median(steps) if steps else None,
                                         "runs_without_conclusive_evidence": len(traced) - len(steps)},
        "evidence_backed_positive_rate": (sum(bool(r.get("evidence")) for r in positives) / len(positives)) if positives else None,
        "trace_integrity": {"verified": sum(v["verified"] for _, v in integrity), "checked": len(integrity),
                            "broken": [{"scenario_id": r["scenario_id"], "repetition": r["repetition"], "first_invalid": v["first_invalid"]}
                                       for r, v in integrity if not v["verified"]]},
    }


def disagreements(rows):
    """Scenarios where methods split, or where every method that answered was wrong."""
    result = []
    for scenario in sorted({r["scenario_id"] for r in rows}):
        group = [r for r in rows if r["scenario_id"] == scenario]
        methods = {}
        for baseline in sorted({r["baseline"] for r in group}):
            outcomes = Counter(_outcome(r) for r in group if r["baseline"] == baseline)
            methods[baseline] = {"outcome": outcomes.most_common(1)[0][0], "outcomes": dict(outcomes),
                                 "predictions": [r.get("prediction") for r in group if r["baseline"] == baseline]}
        answered = {b: m["outcome"] for b, m in methods.items() if m["outcome"] in {"correct", "wrong"}}
        if len(set(answered.values())) > 1:
            kind = "split"
        elif answered and set(answered.values()) == {"wrong"}:
            kind = "all_wrong"
        else:
            continue
        truth = next((r["truth"] for r in group if r.get("truth_verified")), None)
        result.append({"scenario_id": scenario, "truth": truth, "kind": kind, "methods": methods,
                       "correct_methods": sorted(b for b, o in answered.items() if o == "correct")})
    return result


def patch_funnel(patches):
    def reached(patch, stage):
        checks = patch.get("checks") or {}
        return {"attempted": True,
                "reproduced": (checks.get("original_security") or {}).get("verdict") == "confirmed",
                "original_workflow": checks.get("original_workflow") is True,
                "syntax_and_startup": checks.get("syntax_and_startup") is True,
                "security_fixed": (checks.get("security_retest") or {}).get("verdict") == "not_reproduced",
                "legitimate_workflow": checks.get("legitimate_workflow") is True,
                "accepted": patch.get("label") == "verified in the tested twin scenario"}[stage]
    funnel, survivors = [], list(patches)
    for stage, label in PATCH_STAGES:
        survivors = [p for p in survivors if reached(p, stage)]
        funnel.append({"stage": stage, "label": label, "count": len(survivors)})
    return funnel


def insights(report: dict) -> dict:
    rows = report.get("rows", [])
    baselines = sorted({r["baseline"] for r in rows})
    return {
        "agent": {b: agent_behaviour([r for r in rows if r["baseline"] == b]) for b in baselines},
        "disagreements": disagreements(rows),
        "patch_funnel": patch_funnel(report.get("patches", [])),
        "definitions": ("Steps to conclusive evidence count actions until the first executed observation with a "
                        "confirmed or not_reproduced verdict. Disagreements list scenarios where answering methods "
                        "split or all answered wrongly; abstentions and unavailable runs never count as correct. "
                        "Trace integrity recomputes each run's hash chain."),
    }
