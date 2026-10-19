"""MagicBox patch runner for the pinned YingMusic-SVC source tree.

It calls the upstream model functions directly, but supplies the missing
MagicBox contract: explicit output path, deterministic seeds, configurable
adaptive F0, and no accompany/final-mix path.
"""
import argparse
import importlib.util
import json
import os
import random
import shutil
import sys
import tempfile
from types import SimpleNamespace


_dll_handles = []


def prepare_runtime_dlls():
    candidates = [
        os.environ.get("MAGICBOX_YINGMUSIC_PYTHON_LIBRARY_BIN", ""),
        os.path.join(sys.prefix, "Lib", "site-packages", "torch", "lib"),
        os.path.join(os.path.dirname(sys.executable), "..", "Lib", "site-packages", "torch", "lib"),
    ]
    for candidate in candidates:
        directory = os.path.abspath(candidate)
        if not os.path.isdir(directory):
            continue
        os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")
        if hasattr(os, "add_dll_directory"):
            try:
                _dll_handles.append(os.add_dll_directory(directory))
            except OSError:
                pass


def load_upstream(source_root):
    source_root = os.path.abspath(source_root)
    os.chdir(source_root)
    sys.path.insert(0, source_root)
    entry = os.path.join(source_root, "my_inference.py")
    spec = importlib.util.spec_from_file_location("magicbox_yingmusic_upstream", entry)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"YingMusic entrypoint is missing: {entry}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output-path", required=True)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--cache-root", required=True)
    parser.add_argument("--diffusion-steps", type=int, default=50)
    parser.add_argument("--cfg-rate", type=float, default=0.7)
    parser.add_argument("--auto-f0-adjust", type=str, default="true")
    parser.add_argument("--max-shift-semitones", type=float, default=12)
    parser.add_argument("--forced-pitch-shift", type=float, default=None)
    parser.add_argument("--seed", type=int, required=True)
    parser.add_argument("--fp16", type=str, default="true")
    args = parser.parse_args()
    prepare_runtime_dlls()
    auto_f0 = args.auto_f0_adjust.lower() in ("1", "true", "yes", "on")
    fp16 = args.fp16.lower() in ("1", "true", "yes", "on")
    os.environ["HF_HUB_CACHE"] = os.path.abspath(args.cache_root)
    os.environ["TRANSFORMERS_CACHE"] = os.path.abspath(args.cache_root)
    random.seed(args.seed)
    try:
        import numpy as np
        np.random.seed(args.seed)
    except Exception:
        pass
    import torch
    torch.manual_seed(args.seed)
    if not torch.cuda.is_available():
        raise RuntimeError("YingMusic requires a CUDA runtime for the pinned MagicBox profile.")
    torch.cuda.manual_seed_all(args.seed)
    device = torch.device("cuda:0")
    module = load_upstream(args.source_root)
    os.environ["HF_HUB_CACHE"] = os.path.abspath(args.cache_root)
    os.environ["HF_HOME"] = os.path.abspath(args.cache_root)
    os.environ["TRANSFORMERS_CACHE"] = os.path.abspath(args.cache_root)
    try:
        from huggingface_hub import hf_hub_download
        def cached_model_download(repo_id, model_filename="pytorch_model.bin", config_filename=None):
            model_path = hf_hub_download(repo_id=repo_id, filename=model_filename, cache_dir=os.path.abspath(args.cache_root))
            if config_filename is None:
                return model_path
            return hf_hub_download(repo_id=repo_id, filename=config_filename, cache_dir=os.path.abspath(args.cache_root))
        module.load_custom_model_from_hf = cached_model_download
    except Exception as exc:
        raise RuntimeError(f"YingMusic Hugging Face cache binding is unavailable: {exc}") from exc
    original_preprocess = module.preprocess_voice_conversion
    metrics = {"reportedPitchShift": None}

    def patched_preprocess(*preprocess_args, **preprocess_kwargs):
        preprocess_kwargs["enable_adaptive"] = auto_f0
        preprocess_kwargs["max_shift_semitones"] = args.max_shift_semitones
        preprocess_kwargs["forch_pitch_shift"] = args.forced_pitch_shift
        result = original_preprocess(*preprocess_args, **preprocess_kwargs)
        metrics["reportedPitchShift"] = float(result[1]) if result[1] is not None else None
        return result

    module.preprocess_voice_conversion = patched_preprocess
    work_root = tempfile.mkdtemp(prefix="magicbox-yingmusic-", dir=os.path.abspath(args.cache_root))
    try:
        runtime_args = SimpleNamespace(
            checkpoint=os.path.abspath(args.checkpoint),
            config=os.path.abspath(args.config),
            source=os.path.abspath(args.source),
            target=os.path.abspath(args.target),
            diffusion_steps=args.diffusion_steps,
            length_adjust=1.0,
            inference_cfg_rate=args.cfg_rate,
            f0_condition=True,
            semi_tone_shift=args.forced_pitch_shift,
            fp16=fp16,
            output=work_root,
            expname="converted",
        )
        bundle = module.load_models_api(runtime_args, device=device)
        generated = module.run_inference(runtime_args, bundle, device=device)
        os.makedirs(os.path.dirname(os.path.abspath(args.output_path)), exist_ok=True)
        shutil.copyfile(generated, os.path.abspath(args.output_path))
        print(json.dumps({"outputPath": os.path.abspath(args.output_path), **metrics}), flush=True)
    finally:
        shutil.rmtree(work_root, ignore_errors=True)


if __name__ == "__main__":
    main()
