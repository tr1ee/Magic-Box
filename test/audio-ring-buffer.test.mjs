import assert from "node:assert/strict";
import test from "node:test";
import { SampleRingBuffer } from "../public/assistant-pcm-worklet.js";

test("ring buffer preserves FIFO order across wrap and growth", () => {
  const ring = new SampleRingBuffer(4);
  ring.push(Int16Array.from([1, 2, 3]));
  const first = new Float32Array(2);
  assert.equal(ring.readIntoFloat32(first), 2);
  assert.deepEqual([...first].map((value) => Math.round(value * 32768)), [1, 2]);
  ring.push(Int16Array.from([4, 5, 6, 7, 8]));
  assert.equal(ring.length, 6);
  assert.deepEqual([...ring.toArray()], [3, 4, 5, 6, 7, 8]);
  const remaining = new Float32Array(8);
  assert.equal(ring.readIntoFloat32(remaining), 6);
  assert.deepEqual([...remaining.subarray(0, 6)].map((value) => Math.round(value * 32768)), [3, 4, 5, 6, 7, 8]);
  assert.equal(ring.length, 0);
});

test("ring buffer clear discards queued samples", () => {
  const ring = new SampleRingBuffer(2);
  ring.push(Int16Array.from([10, 20, 30]));
  ring.clear();
  assert.equal(ring.length, 0);
  assert.deepEqual([...ring.toArray()], []);
});

