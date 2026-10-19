import os
from pathlib import Path
import shutil
import time

import requests
import yaml
from huggingface_hub import hf_hub_download


repo = Path(os.environ["MAGIC_BOX_SEED_VC_REPO"]).resolve()
os.chdir(repo)
custom_cache = repo / "checkpoints"
hub_cache = custom_cache / "hf_cache"
custom_cache.mkdir(parents=True, exist_ok=True)
hub_cache.mkdir(parents=True, exist_ok=True)

def retry(label, action, attempts=8):
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            print(f"{label}: attempt {attempt}/{attempts}", flush=True)
            return action()
        except Exception as error:
            last_error = error
            print(f"{label}: {error}", flush=True)
            if attempt < attempts:
                time.sleep(min(30, attempt * 5))
    raise last_error


def remote_size(url):
    response = requests.head(url, allow_redirects=True, timeout=(30, 120))
    response.raise_for_status()
    return int(response.headers.get("content-length") or response.headers.get("x-linked-size") or 0)


def download_resumable(label, url, destination, attempts=20):
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    expected = retry(f"{label} size", lambda: remote_size(url))
    if destination.is_file() and (not expected or destination.stat().st_size == expected):
        print(f"{label}: already present", flush=True)
        return destination
    partial = destination.with_suffix(destination.suffix + ".part")
    if destination.is_file():
        destination.replace(partial)
    for attempt in range(1, attempts + 1):
        offset = partial.stat().st_size if partial.exists() else 0
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        print(f"{label}: attempt {attempt}/{attempts}, resume at {offset} bytes", flush=True)
        try:
            with requests.get(url, headers=headers, allow_redirects=True, stream=True, timeout=(30, 300)) as response:
                if response.status_code == 416 and expected and offset == expected:
                    partial.replace(destination)
                    return destination
                response.raise_for_status()
                append = offset > 0 and response.status_code == 206
                if offset > 0 and not append:
                    offset = 0
                mode = "ab" if append else "wb"
                bytes_this_connection = 0
                rotated_connection = False
                with partial.open(mode) as output:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            output.write(chunk)
                            bytes_this_connection += len(chunk)
                            if bytes_this_connection >= 128 * 1024 * 1024:
                                rotated_connection = True
                                break
                actual = partial.stat().st_size
                if expected and actual < expected and rotated_connection:
                    print(f"{label}: rotating connection at {actual}/{expected} bytes", flush=True)
                    continue
                if expected and actual != expected:
                    raise RuntimeError(f"incomplete file: {actual}/{expected} bytes")
                partial.replace(destination)
                return destination
        except Exception as error:
            print(f"{label}: {error}", flush=True)
            if attempt == attempts:
                raise
            time.sleep(min(30, attempt * 5))
    raise RuntimeError(f"{label} download failed")


checkpoint = retry(
    "Seed-VC singing checkpoint",
    lambda: hf_hub_download(
        "Plachta/Seed-VC",
        "DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth",
        cache_dir=custom_cache,
    ),
)
config_path = retry(
    "Seed-VC config",
    lambda: hf_hub_download(
        "Plachta/Seed-VC",
        "config_dit_mel_seed_uvit_whisper_base_f0_44k.yml",
        cache_dir=custom_cache,
    ),
)
retry(
    "RMVPE pitch model",
    lambda: hf_hub_download("lj1995/VoiceConversionWebUI", "rmvpe.pt", cache_dir=custom_cache),
)

campplus_source = repo / "campplus_cn_common.bin"
campplus_cache = custom_cache / "models--funasr--campplus"
campplus_commit = "e4b6ede7ce16997aff4ae69fbca1f0175e2afede"
campplus_hash = "3388cf5fd3493c9ac9c69851d8e7a8badcfb4f3dc631020c4961371646d5ada8"
campplus_blob = campplus_cache / "blobs" / campplus_hash
campplus_snapshot = campplus_cache / "snapshots" / campplus_commit / "campplus_cn_common.bin"
campplus_ref = campplus_cache / "refs" / "main"
if campplus_source.is_file():
    campplus_blob.parent.mkdir(parents=True, exist_ok=True)
    campplus_snapshot.parent.mkdir(parents=True, exist_ok=True)
    campplus_ref.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(campplus_source, campplus_blob)
    shutil.copy2(campplus_source, campplus_snapshot)
    campplus_ref.write_text(campplus_commit, encoding="utf-8")
else:
    retry(
        "CAMPPlus speaker encoder",
        lambda: hf_hub_download("funasr/campplus", "campplus_cn_common.bin", cache_dir=custom_cache),
    )

config = yaml.safe_load(Path(config_path).read_text(encoding="utf-8"))
local_models = custom_cache / "magicbox_models"
whisper_dir = local_models / "whisper-small"
bigvgan_dir = local_models / "bigvgan_v2_44khz_128band_512x"

for filename in ("config.json", "preprocessor_config.json", "model.safetensors"):
    download_resumable(
        f"Whisper {filename}",
        f"https://huggingface.co/openai/whisper-small/resolve/main/{filename}",
        whisper_dir / filename,
    )
for filename in ("config.json", "bigvgan_generator.pt"):
    download_resumable(
        f"BigVGAN {filename}",
        f"https://huggingface.co/nvidia/bigvgan_v2_44khz_128band_512x/resolve/main/{filename}",
        bigvgan_dir / filename,
    )

# Keep the installed configuration relocatable. The worker also rewrites these
# paths against the active portable root at inference time for older installs.
config["model_params"]["speech_tokenizer"]["name"] = "./checkpoints/magicbox_models/whisper-small"
config["model_params"]["vocoder"]["name"] = "./checkpoints/magicbox_models/bigvgan_v2_44khz_128band_512x"
magicbox_config = custom_cache / "magicbox_seed_vc_svc.yml"
magicbox_config.write_text(yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8")
print(checkpoint)
