from __future__ import annotations
import statistics


def ratio(a, b):
    return a / b if b else None


def summarize(report):
    summaries = {}
    for baseline in sorted({r["baseline"] for r in report["rows"]}):
        rows = [r for r in report["rows"] if r["baseline"] == baseline]
        labeled = [r for r in rows if r.get("truth_verified") and isinstance(r.get("truth"), bool)]
        conclusive = [r for r in labeled if isinstance(r.get("prediction"), bool) and r["status"] == "completed"]
        tp = sum(r["prediction"] and r["truth"] for r in conclusive)
        fp = sum(r["prediction"] and not r["truth"] for r in conclusive)
        tn = sum(not r["prediction"] and not r["truth"] for r in conclusive)
        fn = sum(not r["prediction"] and r["truth"] for r in conclusive)
        precision, recall = ratio(tp, tp + fp), ratio(tp, tp + fn)
        elapsed = [r["elapsed_seconds"] for r in rows if r["status"] == "completed"]
        summaries[baseline] = {
            "declared_runs": len(rows), "labeled_runs": len(labeled), "conclusive_runs": len(conclusive),
            "tp": tp, "fp": fp, "tn": tn, "fn": fn, "precision": precision, "recall_conclusive": recall,
            "recall_all_labeled": ratio(tp, sum(r["truth"] for r in labeled)),
            "f1": ratio(2 * tp, 2 * tp + fp + fn), "false_positive_rate": ratio(fp, fp + tn),
            "coverage": ratio(len(conclusive), len(labeled)),
            "unsupported_rate": ratio(sum(r["status"] == "unsupported" for r in rows), len(rows)),
            "inconclusive_rate": ratio(sum(r["status"] in {"inconclusive", "error"} for r in rows), len(rows)),
            "unavailable_rate": ratio(sum(r["status"] == "unavailable" for r in rows), len(rows)),
            "mean_detection_seconds": statistics.mean(elapsed) if elapsed else None,
            "detection_seconds_sd": statistics.stdev(elapsed) if len(elapsed) > 1 else None,
            "variation_scope": "across scenario runtimes; repeated-seed variability requires >1 repetition",
            "peak_ram_mb": max((r.get("peak_ram_mb", 0) for r in rows), default=0) if any("peak_ram_mb" in r for r in rows) else None,
            "total_cpu_seconds": sum(r.get("cpu_seconds", 0) for r in rows) if any("cpu_seconds" in r for r in rows) else None,
            "total_ram_mb_seconds": sum(r.get("ram_mb_seconds", 0) for r in rows) if any("ram_mb_seconds" in r for r in rows) else None,
            "ai_tokens": sum(r.get("reported_tokens") or 0 for r in rows) if any(r.get("reported_tokens") is not None for r in rows) else None,
            "cost_usd": sum(r["cost_usd"] for r in rows) if rows and all(r.get("cost_usd") is not None for r in rows) else None,
        }
        per_repetition = []
        for repetition in sorted({r["repetition"] for r in rows}):
            group = [r for r in conclusive if r["repetition"] == repetition]
            per_repetition.append(ratio(sum(r["prediction"] == r["truth"] for r in group), len(group)))
        values = [x for x in per_repetition if x is not None]
        summaries[baseline]["accuracy_by_repetition"] = per_repetition
        summaries[baseline]["repeat_accuracy_sd"] = statistics.stdev(values) if len(values) > 1 else None
    patches = report.get("patches", [])
    accepted = [p for p in patches if p.get("label") == "verified in the tested twin scenario"]
    regressions = [p for p in patches if p.get("checks", {}).get("original_workflow") is True and p.get("checks", {}).get("legitimate_workflow") is False]
    return {"baselines": summaries, "patches": {"attempts": len(patches), "accepted": len(accepted),
        "regressions_detected": len(regressions), "success_rate": ratio(len(accepted), len(patches)),
        "regression_rate": ratio(len(regressions), len(patches))},
        "definitions": "Precision/recall/F1/FPR use conclusive independently labeled cases. Coverage and all-labeled recall expose abstention. Missing metrics are null."}
