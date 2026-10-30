"""Generate plots and measured manuscript tables; unavailable values remain missing."""
import argparse
import json
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from twin_ingestion.phase3.metrics import summarize


def generate(path):
    report = json.loads(path.read_text())
    summary = summarize(report)
    output = path.parent
    (output / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    names = ["static_assessment", "default_twins", "synced_deterministic", "synced_twinhunter"]
    labels = ["Static rules", "Default twins", "Synchronized\ndeterministic", "Synchronized\nTwinHunter"]
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.5), constrained_layout=True)
    for ax, metric, title in zip(axes, ["f1", "coverage"], ["F1 on conclusive labeled fixtures", "Conclusive coverage of labeled fixtures"]):
        for i, name in enumerate(names):
            value = summary["baselines"][name][metric]
            if value is not None and summary["baselines"][name]["unavailable_rate"] < 1:
                ax.bar(i, value, color="#147d92")
                ax.text(i, value + .025, f"{value:.2f}", ha="center", fontsize=10)
            else:
                ax.text(i, .12, "Not measured", ha="center", color="#6b7280")
        ax.set(xticks=range(4), xticklabels=labels, ylim=(0, 1.15), title=title)
        ax.spines[["top", "right"]].set_visible(False)
        ax.grid(axis="y", alpha=.2)
        ax.set_axisbelow(True)
    fig.suptitle(f"{report['mode']}: small declared fixture set; no AI superiority claim", fontsize=11)
    for extension in ("png", "svg"):
        fig.savefig(output / f"baseline-quality.{extension}", dpi=180)
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(8, 4), constrained_layout=True)
    for name, label in zip(names, labels):
        value = summary["baselines"][name]["mean_detection_seconds"]
        if value is not None:
            ax.bar(label, value, color="#386cb0")
            ax.text(label, value, f"{value:.4f}s", ha="center", va="bottom")
    ax.set(ylabel="Seconds per case (includes twin startup)", title="Measured detection elapsed time")
    fig.savefig(output / "detection-time.png", dpi=180)
    plt.close(fig)
    lines = ["# Measured results", "", f"Run `{report['run_id']}`; mode `{report['mode']}`; manifest `{report['manifest_hash']}`.", "",
             "| Method | Runs | Conclusive | Precision | Recall | F1 | Unsupported | Unavailable |",
             "|---|---:|---:|---:|---:|---:|---:|---:|"]
    def fmt(value): return "not measured" if value is None else f"{value:.3f}"
    for name in names:
        m = summary["baselines"][name]
        lines.append(f"| {name} | {m['declared_runs']} | {m['conclusive_runs']} | {fmt(m['precision'])} | {fmt(m['recall_conclusive'])} | {fmt(m['f1'])} | {fmt(m['unsupported_rate'])} | {fmt(m['unavailable_rate'])} |")
    lines += ["", "Static rules and synchronized deterministic twins must be compared directly: a tie provides no evidence of improved detection over static assessment.",
              "These fixtures test specific policy behaviors. Version disclosure and synthetic password login are not proof of an exploitable production vulnerability.",
              "", "## Patch controls", ""]
    for patch in report["patches"]:
        lines.append(f"- {patch.get('seeded_case', 'candidate')}: {patch['label']}.")
    lines += ["", "Unsupported and unavailable cases remain in JSON/CSV. Quality metrics condition on conclusive independent labels; coverage is reported separately.",
              "No AI tokens/cost, agent overhead, synchronization latency, or full-VM costs are claimed where no measurement exists."]
    (output / "results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("report", type=Path)
    generate(parser.parse_args().report)
