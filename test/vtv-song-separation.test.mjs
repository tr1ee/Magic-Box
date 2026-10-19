import test from "node:test";
import assert from "node:assert/strict";
import { separateSharedSongStems } from "../server/voice/vtv/song-separation.mjs";

test("modern engines share the requested separator, model and cancellation signal", async () => {
  for (const [settings, expected, model] of [
    [{}, "demucs", "htdemucs"],
    [{ separationModel: "htdemucs_ft" }, "demucs", "htdemucs_ft"],
    [{ separationModel: "bs-roformer", roformerRoot: "models/roformer" }, "roformer", "bs-roformer"],
    [{ separation_model: "band-roformer" }, "roformer", "bs-roformer"]
  ]) {
    const calls = [];
    const signal = new AbortController().signal;
    const dependencies = Object.fromEntries(["demucs", "roformer"].map(name => [name, async options => {
      calls.push(name);
      assert.equal(options.settings.separationModel, model);
      assert.equal(options.settings.roformerRoot, settings.roformerRoot);
      assert.equal(options.signal, signal);
      return { vocalPath: "lead.wav", accompanimentPath: "backing.wav", separatorModelSha256: "model-hash" };
    }]));
    const result = await separateSharedSongStems({ settings, signal }, dependencies);
    assert.deepEqual(calls, [expected]);
    assert.equal(result.separator.model, model);
    assert.equal(result.separator.modelSha256, "model-hash");
    assert.equal(result.vocalPath, "lead.wav");
  }
});

test("an unavailable requested separator fails instead of silently using a different model", async () => {
  await assert.rejects(separateSharedSongStems({ settings: { separationModel: "bs-roformer" } }, {
    demucs: async () => assert.fail("must not fall back"),
    roformer: async () => { throw new Error("RoFormer missing"); }
  }), /RoFormer missing/);
});
