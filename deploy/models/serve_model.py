"""Run on the GPU control-plane host. No Docker socket or sandbox network access."""
import json
import os
import subprocess
import sys
from pathlib import Path
from importlib.metadata import version

lock = json.loads(Path(__file__).with_name("model-lock.json").read_text())
if version("vllm") != lock["vllm_version"]:
    raise SystemExit("Install the locked vLLM version before serving")
if version("transformers") != lock["transformers_version"]:
    raise SystemExit("Install the locked Transformers version before serving")
gpu = subprocess.check_output(["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"], text=True)
print(gpu)
devices = [line.split(",") for line in gpu.strip().splitlines()]
if not devices or lock["gpu_family"].lower() not in devices[0][0].lower():
    raise SystemExit("The first GPU does not match the locked GPU family")
if int(devices[0][1]) < lock["minimum_gpu_memory_mib"] or int(devices[0][2]) < lock["minimum_free_gpu_memory_mib"]:
    raise SystemExit("The first GPU does not have enough available memory for the locked profile")
key = os.environ.get("TWIN_MODEL_API_KEY")
if not key:
    raise SystemExit("Set TWIN_MODEL_API_KEY; do not expose an unauthenticated endpoint")
os.environ["VLLM_API_KEY"] = key
command = ["vllm", "serve", lock["model_id"], "--revision", lock["revision"], "--served-model-name", lock["served_name"],
           "--dtype", lock["dtype"], "--max-model-len", str(lock["context_length"]), "--gpu-memory-utilization", str(lock["gpu_memory_utilization"]),
           "--tensor-parallel-size", "1", "--max-num-seqs", "1", "--language-model-only", "--host", "127.0.0.1", "--port", "8000"]
Path("model-runtime-manifest.json").write_text(json.dumps({"lock": lock, "gpu": gpu, "command": command}, indent=2))
raise SystemExit(subprocess.call(command))
