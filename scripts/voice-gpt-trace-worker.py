"""Temporary local diagnostic entrypoint; normal application uses the worker directly."""
import faulthandler
import os
import runpy
from pathlib import Path

root = Path(__file__).resolve().parents[1]
trace = (root / "artifacts/ttv-strict-2026-09-06/api-gpt-stacks.log").open("w")
faulthandler.dump_traceback_later(45, repeat=True, file=trace)
os.environ["MAGIC_BOX_GPT_SOVITS_REPO"] = str(Path(os.environ["MAGIC_BOX_VOICE_ENGINE_MODEL_DIR"]).parents[1] / "runtime/GPT-SoVITS")
runpy.run_path(str(root / "server/voice_engine_worker_gpt_sovits.py"), run_name="__main__")
