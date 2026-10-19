"""MagicBox runner for RVC release 2.3.260718 (revision 8f2fdbf).

The pinned release predates the newer infer/cli.py entrypoint. This runner
binds its own infer.vc.modules.VC API without starting WebUI or HTTP.
"""
import argparse
import gc
import json
import os
import random
import sys
import tempfile
import threading
import time


def _write_progress(progress_file, payload):
    if not progress_file:
        return
    progress_directory = os.path.dirname(os.path.abspath(progress_file))
    os.makedirs(progress_directory, exist_ok=True)
    temporary = f"{progress_file}.{os.getpid()}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    os.replace(temporary, progress_file)


def _exit_when_parent_terminates(parent_pid):
    if not parent_pid or parent_pid <= 0 or os.name != "nt":
        return
    import ctypes

    synchronize = 0x00100000
    infinite = 0xFFFFFFFF
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(synchronize, False, int(parent_pid))
    if not handle:
        return

    def watch():
        try:
            kernel32.WaitForSingleObject(handle, infinite)
        finally:
            kernel32.CloseHandle(handle)
        os._exit(130)

    threading.Thread(target=watch, name="magicbox-rvc-parent-watch", daemon=True).start()


def _low_energy_boundaries(audio, sample_rate, chunk_seconds, search_seconds):
    import numpy as np

    total_samples = len(audio)
    target_step = max(1, int(chunk_seconds * sample_rate))
    search = max(1, int(search_seconds * sample_rate))
    minimum_step = max(1, int(min(12.0, chunk_seconds * 0.55) * sample_rate))
    energy_hop = max(1, int(0.02 * sample_rate))
    energy_window = max(energy_hop, int(0.08 * sample_rate))
    squared = np.square(np.asarray(audio, dtype=np.float32))
    cumulative = np.concatenate([np.zeros(1, dtype=np.float64), np.cumsum(squared, dtype=np.float64)])
    frame_starts = np.arange(0, total_samples, energy_hop, dtype=np.int64)
    frame_ends = np.minimum(total_samples, frame_starts + energy_window)
    rms = np.sqrt(np.maximum(0.0, (cumulative[frame_ends] - cumulative[frame_starts]) / np.maximum(1, frame_ends - frame_starts)))
    boundaries = [0]
    desired = target_step
    while total_samples - boundaries[-1] > target_step * 1.35:
        low = max(boundaries[-1] + minimum_step, desired - search)
        high = min(total_samples - minimum_step, desired + search)
        if high <= low:
            break
        low_frame = max(0, low // energy_hop)
        high_frame = min(len(rms), max(low_frame + 1, high // energy_hop))
        boundary = int((low_frame + int(np.argmin(rms[low_frame:high_frame]))) * energy_hop)
        if boundary <= boundaries[-1]:
            break
        boundaries.append(boundary)
        desired = boundary + target_step
    boundaries.append(total_samples)
    return boundaries


def _merge_with_crossfade(current, addition, overlap_samples):
    import numpy as np

    overlap = min(max(0, int(overlap_samples)), len(current), len(addition))
    if overlap <= 0:
        return np.concatenate([current, addition])
    phase = np.linspace(0.0, 1.0, overlap, endpoint=False, dtype=np.float32)
    blended = current[-overlap:] * (1.0 - phase) + addition[:overlap] * phase
    return np.concatenate([current[:-overlap], blended, addition[overlap:]])


def _install_index_cache(index_path):
    from infer.vc import pipeline as pipeline_module

    original_read_index = pipeline_module.faiss.read_index
    cache = {}

    class CachedIndex:
        def __init__(self, index, vectors):
            self._index = index
            self._vectors = vectors
            self.ntotal = index.ntotal

        def search(self, *args, **kwargs):
            return self._index.search(*args, **kwargs)

        def reconstruct_n(self, *_args, **_kwargs):
            return self._vectors

    def cached_read_index(path):
        key = os.path.abspath(path)
        if key not in cache:
            index = original_read_index(key)
            cache[key] = CachedIndex(index, index.reconstruct_n(0, index.ntotal))
        return cache[key]

    if index_path:
        pipeline_module.faiss.read_index = cached_read_index


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--index", required=True)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--speaker-id", type=int, default=0)
    parser.add_argument("--pitch", type=int, default=0)
    parser.add_argument("--seed", type=int, default=31002)
    parser.add_argument("--f0-method", default="rmvpe")
    parser.add_argument("--index-rate", type=float, default=0.65)
    parser.add_argument("--resample-sr", type=int, default=0)
    parser.add_argument("--rms-mix-rate", type=float, default=0.25)
    parser.add_argument("--protect", type=float, default=0.33)
    parser.add_argument("--chunk-seconds", type=float, default=30.0)
    parser.add_argument("--chunk-context-seconds", type=float, default=3.0)
    parser.add_argument("--chunk-crossfade-seconds", type=float, default=0.1)
    parser.add_argument("--progress-file", default="")
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()
    _exit_when_parent_terminates(args.parent_pid)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    source_root = os.path.abspath(args.source_root)
    os.chdir(source_root)
    sys.path.insert(0, source_root)
    os.environ["weight_root"] = os.path.dirname(os.path.abspath(args.model))
    os.environ["index_root"] = os.path.dirname(os.path.abspath(args.index))
    os.environ["outside_index_root"] = os.path.dirname(os.path.abspath(args.index))
    os.environ["rmvpe_root"] = os.path.join(source_root, "assets", "rmvpe")
    # The pinned RVC runtime caches one CUDA Graph for every tensor shape.
    # Song chunks vary in length, so graph capture grows VRAM on every chunk
    # and eventually stalls a 12 GB GPU. Eager inference lets the upstream
    # pipeline release temporary allocations between variable-length chunks.
    os.environ["RVC_CUDA_GRAPH"] = "0"
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
    sys.argv = [sys.argv[0]]
    import soundfile as sf
    import numpy as np
    import torch
    seed = args.seed % (2 ** 32)
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    torch.use_deterministic_algorithms(True)
    from configs.config import Config
    from infer.vc.modules import VC
    config = Config()
    if config.device == "cpu" or not torch.cuda.is_available():
        raise RuntimeError("RVC requires a usable CUDA runtime for the pinned MagicBox profile.")
    model_name = os.path.basename(args.model)
    started = time.perf_counter()
    vc = VC(config)
    vc.get_vc(model_name)
    _install_index_cache(args.index)
    source_audio, source_rate = sf.read(args.input, always_2d=True, dtype="float32")
    source_audio = source_audio.mean(axis=1)
    duration_seconds = len(source_audio) / max(1, source_rate)
    chunk_seconds = max(12.0, min(60.0, float(args.chunk_seconds)))
    context_seconds = max(0.5, min(4.0, float(args.chunk_context_seconds)))
    crossfade_seconds = max(0.02, min(0.25, float(args.chunk_crossfade_seconds)))
    boundaries = _low_energy_boundaries(source_audio, source_rate, chunk_seconds, min(5.0, chunk_seconds * 0.2))
    use_chunks = duration_seconds > chunk_seconds * 1.45 and len(boundaries) > 2
    if not use_chunks:
        status, result = vc.vc_single(args.speaker_id, args.input, args.pitch, args.f0_method, args.index, args.index_rate, args.resample_sr, args.rms_mix_rate, args.protect)
        if not result or result[0] is None or result[1] is None:
            raise RuntimeError(f"RVC vc_single failed: {status}")
        sample_rate, audio = result
        audio = audio.astype("float32") / 32768.0
    else:
        context_samples = int(round(context_seconds * source_rate))
        crossfade_source_samples = int(round(crossfade_seconds * source_rate))
        audio = None
        sample_rate = None
        with tempfile.TemporaryDirectory(prefix="magicbox-rvc-chunks-") as chunk_dir:
            for index in range(len(boundaries) - 1):
                core_start = boundaries[index]
                core_end = boundaries[index + 1]
                keep_start = max(0, core_start - (crossfade_source_samples if index > 0 else 0))
                keep_end = min(len(source_audio), core_end + (crossfade_source_samples if index < len(boundaries) - 2 else 0))
                input_start = max(0, keep_start - context_samples)
                input_end = min(len(source_audio), keep_end + context_samples)
                chunk_path = os.path.join(chunk_dir, f"chunk-{index + 1:03d}.wav")
                sf.write(chunk_path, source_audio[input_start:input_end], source_rate, subtype="PCM_16")
                _write_progress(args.progress_file, {
                    "state": "processing",
                    "chunk": index + 1,
                    "chunkCount": len(boundaries) - 1,
                    "completedChunks": index,
                    "percent": round(index / (len(boundaries) - 1) * 100.0, 2),
                    "elapsedSec": round(time.perf_counter() - started, 1),
                    "processedSourceSec": round(core_start / source_rate, 3),
                })
                status, result = vc.vc_single(args.speaker_id, chunk_path, args.pitch, args.f0_method, args.index, args.index_rate, args.resample_sr, args.rms_mix_rate, args.protect)
                if not result or result[0] is None or result[1] is None:
                    raise RuntimeError(f"RVC chunk {index + 1}/{len(boundaries) - 1} failed: {status}")
                chunk_rate, converted = result
                if sample_rate is None:
                    sample_rate = int(chunk_rate)
                elif int(chunk_rate) != sample_rate:
                    raise RuntimeError("RVC chunks returned inconsistent sample rates.")
                converted = converted.astype("float32") / 32768.0
                trim_start = int(round((keep_start - input_start) * sample_rate / source_rate))
                keep_length = int(round((keep_end - keep_start) * sample_rate / source_rate))
                piece = converted[trim_start:trim_start + keep_length]
                overlap = int(round(crossfade_seconds * 2.0 * sample_rate)) if audio is not None else 0
                audio = piece if audio is None else _merge_with_crossfade(audio, piece, overlap)
                del result, converted, piece
                torch.cuda.synchronize()
                gc.collect()
                torch.cuda.empty_cache()
                _write_progress(args.progress_file, {
                    "state": "completed",
                    "chunk": index + 1,
                    "chunkCount": len(boundaries) - 1,
                    "completedChunks": index + 1,
                    "percent": round((index + 1) / (len(boundaries) - 1) * 100.0, 2),
                    "elapsedSec": round(time.perf_counter() - started, 1),
                    "processedSourceSec": round(core_end / source_rate, 3),
                    "cudaAllocatedMiB": round(torch.cuda.memory_allocated() / (1024 * 1024), 2),
                    "cudaReservedMiB": round(torch.cuda.memory_reserved() / (1024 * 1024), 2),
                })
        expected_samples = int(round(len(source_audio) * sample_rate / source_rate))
        if len(audio) < expected_samples:
            audio = np.pad(audio, (0, expected_samples - len(audio)))
        elif len(audio) > expected_samples:
            audio = audio[:expected_samples]
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    sf.write(args.output, audio, sample_rate, subtype="PCM_16")
    peak_vram = None
    try:
        peak_vram = round(torch.cuda.max_memory_allocated() / (1024 * 1024), 2)
    except Exception:
        pass
    print(json.dumps({
        "sampleRate": sample_rate,
        "seed": seed,
        "runtimeFactor": (time.perf_counter() - started) / max(len(audio) / sample_rate, 1e-6),
        "peakVramMiB": peak_vram,
        "chunked": use_chunks,
        "chunkCount": len(boundaries) - 1 if use_chunks else 1,
        "chunkSeconds": chunk_seconds if use_chunks else duration_seconds,
    }), flush=True)


if __name__ == "__main__":
    main()
