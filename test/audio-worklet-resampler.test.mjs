import assert from "node:assert/strict";
import test from "node:test";
import { StreamingResampler } from "../public/assistant-pcm-worklet.js";

function signal(length, rate = 24000) {
  return Int16Array.from({ length }, (_item, index) => Math.round(
    Math.sin(index * 2 * Math.PI * 440 / rate) * 12000
    + Math.sin(index * 2 * Math.PI * 173 / rate) * 3000
  ));
}

function run(input, inputRate, outputRate, chunkSizes) {
  const resampler = new StreamingResampler(inputRate, outputRate);
  const chunks = [];
  let offset = 0;
  let chunkIndex = 0;
  while (offset < input.length) {
    const size = chunkSizes[chunkIndex % chunkSizes.length];
    const end = Math.min(input.length, offset + size);
    chunks.push(resampler.process(input.subarray(offset, end)));
    offset = end;
    chunkIndex += 1;
  }
  chunks.push(resampler.flush());
  const output = new Int16Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let target = 0;
  for (const chunk of chunks) {
    output.set(chunk, target);
    target += chunk.length;
  }
  return { output, accounting: resampler.accounting() };
}

for (const [inputRate, outputRate] of [[24000, 24000], [24000, 44100], [24000, 48000], [16000, 48000]]) {
  test(`stateful resampling ${inputRate} -> ${outputRate} is independent of PCM chunk boundaries`, () => {
    const input = signal(inputRate * 2 + 137, inputRate);
    const single = run(input, inputRate, outputRate, [input.length]);
    const fixed20ms = run(input, inputRate, outputRate, [Math.round(inputRate * 0.02)]);
    const jittered = run(input, inputRate, outputRate, [1, 2, 7, 19, 127, 239, 997]);
    assert.deepEqual(fixed20ms.output, single.output);
    assert.deepEqual(jittered.output, single.output);
    assert.equal(jittered.accounting.totalInputSamples, input.length);
    assert.equal(jittered.accounting.totalOutputSamples, Math.round(input.length * outputRate / inputRate));
    assert.equal(jittered.accounting.sampleDrift, 0);
  });
}

test("identity resampling preserves every PCM sample", () => {
  const input = Int16Array.from([-32768, -1234, 0, 1234, 32767]);
  assert.deepEqual(run(input, 24000, 24000, [1]).output, input);
});

