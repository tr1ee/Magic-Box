import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createVoiceGpuScheduler, VOICE_GPU_PRIORITIES } from "../server/voice-clone-gpu-scheduler.mjs";

test("GPU scheduler honors priority while allowing only one heavy job", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-voice-gpu-"));
  const scheduler = createVoiceGpuScheduler({ statePath: path.join(root, "scheduler.json") });
  const order = [];
  const first = scheduler.enqueue({ id: "first", priority: VOICE_GPU_PRIORITIES.fineBuild, run: async () => {
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 15));
    order.push("first-end");
  }});
  const second = scheduler.enqueue({ id: "interactive", priority: VOICE_GPU_PRIORITIES.interactiveTtv, run: async () => {
    order.push("interactive");
  }});
  while (!(["completed", "failed"].includes(first.status) && ["completed", "failed"].includes(second.status) && scheduler.snapshot().running.length === 0)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(order, ["first-start", "first-end", "interactive"]);
  assert.equal(scheduler.snapshot().running.length, 0);
});

test("GPU scheduler retries one out-of-memory failure and records recovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magicbox-voice-gpu-oom-"));
  const scheduler = createVoiceGpuScheduler({ statePath: path.join(root, "scheduler.json") });
  let attempts = 0;
  const job = scheduler.enqueue({ id: "oom", run: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("CUDA out of memory");
    return { ok: true };
  }});
  while (!["completed", "failed"].includes(job.status)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(job.status, "completed");
  assert.equal(job.attempts, 2);
  assert.equal(job.oomRecoveries, 1);
});
