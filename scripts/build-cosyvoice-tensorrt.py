"""Build and validate the managed RTX TensorRT estimator for CosyVoice 3."""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository-dir", required=True)
    parser.add_argument("--model-dir", required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    repository_dir = Path(args.repository_dir).resolve()
    model_dir = Path(args.model_dir).resolve()
    sys.path.insert(0, str(repository_dir))
    sys.path.insert(0, str(repository_dir / "third_party" / "Matcha-TTS"))

    import numpy as np
    import onnxruntime
    import tensorrt as trt
    import torch
    from cosyvoice.cli.cosyvoice import AutoModel

    onnx_path = model_dir / "flow.decoder.estimator.fp32.onnx"
    plan_path = model_dir / "flow.decoder.estimator.fp16.mygpu.plan"
    metadata_path = model_dir / "flow.decoder.estimator.fp16.mygpu.json"
    plan_path.unlink(missing_ok=True)

    model = AutoModel(model_dir=str(model_dir))
    estimator = model.model.flow.decoder.estimator.eval()
    device = model.model.device
    out_channels = estimator.out_channels

    def inputs(sequence_length: int):
        return (
            torch.rand((2, out_channels, sequence_length), dtype=torch.float32, device=device),
            torch.ones((2, 1, sequence_length), dtype=torch.float32, device=device),
            torch.rand((2, out_channels, sequence_length), dtype=torch.float32, device=device),
            torch.rand((2,), dtype=torch.float32, device=device),
            torch.rand((2, out_channels), dtype=torch.float32, device=device),
            torch.rand((2, out_channels, sequence_length), dtype=torch.float32, device=device),
        )

    sample = inputs(256)
    torch.onnx.export(
        estimator,
        sample,
        str(onnx_path),
        export_params=True,
        opset_version=18,
        do_constant_folding=True,
        input_names=["x", "mask", "mu", "t", "spks", "cond"],
        output_names=["estimator_out"],
        dynamic_axes={
            "x": {2: "seq_len"}, "mask": {2: "seq_len"},
            "mu": {2: "seq_len"}, "cond": {2: "seq_len"},
            "estimator_out": {2: "seq_len"},
        },
    )

    session = onnxruntime.InferenceSession(
        str(onnx_path),
        sess_options=onnxruntime.SessionOptions(),
        providers=["CPUExecutionProvider"],
    )
    max_absolute_difference = 0.0
    for sequence_length in (64, 256, 512):
        values = inputs(sequence_length)
        expected = estimator(*values).detach().cpu()
        actual = session.run(None, {
            name: value.detach().cpu().numpy()
            for name, value in zip(("x", "mask", "mu", "t", "spks", "cond"), values)
        })[0]
        maximum = float(np.max(np.abs(expected.numpy() - actual)))
        max_absolute_difference = max(max_absolute_difference, maximum)
        torch.testing.assert_close(expected, torch.from_numpy(actual), rtol=1e-2, atol=5e-4)

    model.model.load_trt(str(plan_path), str(onnx_path), 1, True)
    if not plan_path.is_file() or plan_path.stat().st_size == 0:
        raise RuntimeError("TensorRT did not produce a usable estimator engine.")

    gpu = torch.cuda.get_device_properties(0)
    metadata = {
        "schemaVersion": 1,
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "pythonVersion": platform.python_version(),
        "torchVersion": torch.__version__,
        "tensorRtVersion": trt.__version__,
        "gpuName": gpu.name,
        "gpuComputeCapability": f"{gpu.major}.{gpu.minor}",
        "precision": "fp16",
        "onnxValidated": True,
        "onnxValidationMaxAbsoluteDifference": max_absolute_difference,
        "planBytes": plan_path.stat().st_size,
    }
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(json.dumps(metadata))


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUTF8", "1")
    main()
