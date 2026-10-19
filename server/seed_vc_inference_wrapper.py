import os
import random
import sys
from pathlib import Path

import numpy as np
import torch
from transformers import WhisperModel


if len(sys.argv) < 2:
    raise SystemExit("Seed-VC inference path is required.")

seed_value = os.environ.get("MAGIC_BOX_SEED_VC_SEED", "").strip()
if seed_value:
    try:
        seed = int(seed_value)
        random.seed(seed)
        np.random.seed(seed % (2**32 - 1))
        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except ValueError:
        raise RuntimeError("MAGIC_BOX_SEED_VC_SEED must be an integer when provided.")

inference_path = sys.argv.pop(1)
sys.argv[0] = inference_path
inference_dir = str(Path(inference_path).resolve().parent)
if inference_dir not in sys.path:
    sys.path.insert(0, inference_dir)

if not torch.cuda.is_available():
    original_from_pretrained = WhisperModel.from_pretrained

    @classmethod
    def cpu_from_pretrained(cls, *args, **kwargs):
        if kwargs.get("torch_dtype") == torch.float16:
            kwargs["torch_dtype"] = torch.float32
        return original_from_pretrained(*args, **kwargs)

    WhisperModel.from_pretrained = cpu_from_pretrained

overlap_frames = 16
try:
    overlap_frames = max(16, min(104, int(os.environ.get("MAGIC_BOX_SEED_VC_OVERLAP_FRAMES", "16"))))
except ValueError:
    pass

source = Path(inference_path).read_text(encoding="utf-8")
overlap_marker = "    overlap_frame_len = 16"
if source.count(overlap_marker) != 1:
    raise RuntimeError("Installed Seed-VC inference.py has an unsupported chunking layout.")
source = source.replace(overlap_marker, f"    overlap_frame_len = {overlap_frames}", 1)

scope = {
    "__name__": "__main__",
    "__file__": inference_path,
    "__package__": None,
    "__cached__": None,
}
exec(compile(source, inference_path, "exec"), scope)
