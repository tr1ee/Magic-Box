import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("RVC worker is bound to the pinned release VC API and exposes model/index inference", () => {
  const worker = read("server/workers/vtv_rvc_worker.py");
  assert.match(worker, /"infer", "vc", "modules\.py"/);
  assert.match(read("server/workers/vtv_rvc_runner.py"), /infer\.vc\.modules/);
  assert.match(worker, /subprocess\.Popen/);
  const pollingSeconds = Number(worker.match(/communicate\(timeout=(\d+)\)/)?.[1]);
  assert.ok(pollingSeconds > 0 && pollingSeconds <= 15, "RVC must poll at least every 15 seconds to report progress");
  assert.match(worker, /except subprocess\.TimeoutExpired:/);
  assert.match(worker, /stalled_seconds >= stall_timeout_seconds/);
  assert.match(worker, /terminate_process_tree\(process\)/);
  assert.match(worker, /"event": "progress"/);
  assert.match(worker, /rvc\.inference\.chunk/);
  assert.match(worker, /rvc\.inference\.loading/);
  assert.match(worker, /--index/);
  assert.doesNotMatch(worker, /inference bindings are not installed/);
});

test("YingMusic worker calls the MagicBox runner and only returns dry vocal output", () => {
  const worker = read("server/workers/vtv_yingmusic_worker.py");
  const runner = read("server/workers/vtv_yingmusic_runner.py");
  assert.match(worker, /MAGICBOX_YINGMUSIC_RUNNER/);
  assert.match(worker, /dryVocal/);
  assert.match(worker, /44100/);
  assert.match(runner, /auto-f0-adjust/);
  assert.match(runner, /output-path/);
  assert.match(worker, /checkpointPresent/);
  assert.doesNotMatch(runner, /echo_then_reverb_save/);
});

test("runtime installers verify hashes and only activate after model smoke", () => {
  const rvc = read("scripts/install-voice-rvc-v2.ps1");
  const ying = read("scripts/install-voice-yingmusic-svc.ps1");
  for (const script of [rvc, ying]) {
    assert.match(script, /Get-FileHash/);
    assert.match(script, /smokePassed/);
    assert.match(script, /if \(\$smokePassed\)/);
    assert.match(script, /WheelhousePath/);
    assert.match(script, /requirementsLockSha256/);
    assert.match(script, /verifiedHardware/);
  }
  assert.match(rvc, /webOnlyPackages/);
  assert.match(ying, /PatchedTreeHash/);
  assert.match(ying, /CheckpointSha256/);
});
