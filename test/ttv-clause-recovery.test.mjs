import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { convertTtsRecoveryClauses } from "../server/voice/tts-clause-recovery.mjs";
import { evaluateContentPolicy } from "../shared/voiceCloneQuality.mjs";

test("recovery retains exact clause outputs when conversion changes each duration differently", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv-recovery-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePaths = [path.join(directory, "source1"), path.join(directory, "source2")];
  await fs.writeFile(sourcePaths[0], Buffer.alloc(100, 1));
  await fs.writeFile(sourcePaths[1], Buffer.alloc(200, 2));
  const calls = [];
  const result = await convertTtsRecoveryClauses({
    sourcePaths, texts: ["你好小鸟，我叫小爱！", "你的名字叫做simple"], outputDir: path.join(directory, "output"), seed: 4103, pauseMs: 120,
    durationOf: buffer => buffer.length / 100,
    convert: async request => {
      calls.push(request);
      return { buffer: Buffer.alloc(request.index === 0 ? 180 : 150, request.index + 3) };
    },
    concatenate: async (paths, target, _signal, pauseMs) => {
      assert.equal(pauseMs, 120);
      const buffers = await Promise.all(paths.map(p => fs.readFile(p)));
      await fs.writeFile(target, Buffer.concat(buffers));
    }
  });
  assert.deepEqual(calls.map(c => [c.sourceAudioPath, c.sourceDurationSeconds, c.seed]), [[sourcePaths[0], 1, 4103], [sourcePaths[1], 2, 5100]]);
  assert.deepEqual((await Promise.all(result.clausePaths.map(p => fs.readFile(p)))).map(b => [b.length, b[0]]), [[180, 3], [150, 4]]);
  assert.equal(result.buffer.length, 330);
  assert.equal(result.conversionStrategy, "exact-clause-recovery");
});

test("cancelled or incomplete recovery never assembles partial speech", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ttv-recovery-cancel-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "source");
  await fs.writeFile(sourcePath, Buffer.alloc(100));
  const controller = new AbortController();
  await assert.rejects(convertTtsRecoveryClauses({
    sourcePaths: [sourcePath, sourcePath], texts: ["第一句", "第二句"], outputDir: path.join(directory, "output"), seed: 1,
    signal: controller.signal, durationOf: () => 1,
    convert: async () => { controller.abort(); return { buffer: Buffer.alloc(100) }; },
    concatenate: async () => assert.fail("must not assemble cancelled speech")
  }), error => error.name === "AbortError");
  await assert.rejects(convertTtsRecoveryClauses({ sourcePaths: [sourcePath, sourcePath], texts: ["缺了一句"] }), /matching/);
});

test("strict still rejects the user's historical 75% coverage after recovery", () => {
  const report = evaluateContentPolicy({
    primaryAsr: { coverage: 0.75 }, secondaryAsr: { available: true, coverage: 0.75 },
    expectedText: "你的名字叫做simple", requiredSecondary: true, qualityMode: "strict"
  });
  assert.equal(report.passed, false);
  assert.ok(report.reasons.includes("primary_asr_coverage_low"));
});
