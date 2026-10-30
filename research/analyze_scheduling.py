import argparse
import json
import statistics
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def generate(path=Path("research/results/scheduling.json")):
    path = Path(path)
    data = json.loads(path.read_text())
    metrics = ["cpu_seconds", "ram_mb_seconds", "peak_ram_mb"]
    labels = ["Total CPU seconds", "Integrated memory (MB s)", "Sampled peak RAM (MB)"]
    fig, axes = plt.subplots(1, 3, figsize=(11, 4), constrained_layout=True)
    lines = ["# Matched scheduling subset", "", "Three repetitions; four real service containers; identical two tested targets; 20-second always-on horizon.", "",
             "| Policy | CPU seconds, mean ± SD | MB seconds, mean ± SD | Peak RAM MB, mean ± SD |", "|---|---:|---:|---:|"]
    summaries = {}
    for policy in ("selective", "always_on"):
        rows = [r for r in data["records"] if r["policy"] == policy]
        summaries[policy] = {metric: {"mean": statistics.mean(r[metric] for r in rows), "sd": statistics.stdev(r[metric] for r in rows)} for metric in metrics}
        cells = [f"{summaries[policy][m]['mean']:.3f} ± {summaries[policy][m]['sd']:.3f}" for m in metrics]
        lines.append("| " + " | ".join([policy, *cells]) + " |")
    for ax, metric, label in zip(axes, metrics, labels):
        for index, policy in enumerate(summaries):
            result = summaries[policy][metric]
            ax.bar(index, result["mean"], yerr=result["sd"], capsize=5, color=["#147d92", "#6a78a5"][index])
        ax.set(xticks=[0, 1], xticklabels=["Selective", "Always on"], title=label)
        ax.spines[["top", "right"]].set_visible(False)
        ax.grid(axis="y", alpha=.2)
        ax.set_axisbelow(True)
    fig.suptitle("Docker Desktop lifecycle subset: mean ± sample SD (3 repetitions)")
    fig.savefig(path.with_name("scheduling-cost.png"), dpi=180)
    fig.savefig(path.with_name("scheduling-cost.svg"))
    plt.close(fig)
    lines += ["", "This measures the declared lifecycle policy only; it does not establish security-path coverage or general fleet savings.",
              "The separate 100-node graph contains zero physically instrumented hosts. Full-VM comparison was not run."]
    path.with_name("scheduling-results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.with_name("scheduling-summary.json").write_text(json.dumps(summaries, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("report", nargs="?", type=Path, default=Path("research/results/scheduling.json"))
    generate(parser.parse_args().report)
