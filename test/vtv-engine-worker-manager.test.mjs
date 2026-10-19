import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEngineWorkerManager } from "../server/voice/vtv/engine-worker-manager.mjs";

const workerEntry = path.resolve("test", "fixtures", "vtv-worker-fixture.mjs");

async function waitForStopped(manager) {
  const deadline = Date.now() + 3000;
  while (manager.snapshot().running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("completed worker requests remove abort listeners and remain reusable", async () => {
  const manager = createEngineWorkerManager({
    engineId: "fixture",
    executable: process.execPath,
    workerEntry,
    cwd: process.cwd(),
    logPath: path.join(os.tmpdir(), `vtv-worker-${process.pid}-reuse.log`)
  });
  const controller = new AbortController();
  try {
    assert.equal((await manager.request({ command: "echo", value: "first" }, { signal: controller.signal })).value, "first");
    controller.abort();
    assert.equal((await manager.request({ command: "echo", value: "second" })).value, "second");
  } finally {
    await manager.stop();
  }
});

test("worker timeout terminates the process instead of leaving GPU work orphaned", async () => {
  const manager = createEngineWorkerManager({
    engineId: "fixture-timeout",
    executable: process.execPath,
    workerEntry,
    cwd: process.cwd(),
    requestTimeoutMs: 120
  });
  await assert.rejects(manager.request({ command: "hang" }), (error) => error.code === "ENGINE_TIMEOUT");
  await waitForStopped(manager);
  assert.equal(manager.snapshot().running, false);
});

test("aborting a request terminates the worker instead of leaving GPU work orphaned", async () => {
  const manager = createEngineWorkerManager({
    engineId: "fixture-abort",
    executable: process.execPath,
    workerEntry,
    cwd: process.cwd()
  });
  const controller = new AbortController();
  const request = manager.request({ command: "hang" }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(request, (error) => error.code === "ENGINE_CANCELLED");
  await waitForStopped(manager);
  assert.equal(manager.snapshot().running, false);
});

test("worker progress heartbeats reset the inactivity timeout", async () => {
  const manager = createEngineWorkerManager({
    engineId: "fixture-heartbeat",
    executable: process.execPath,
    workerEntry,
    cwd: process.cwd(),
    requestTimeoutMs: 120
  });
  try {
    const progress = [];
    const result = await manager.request({ command: "heartbeat" }, { onProgress: (event) => progress.push(event.count) });
    assert.equal(result.value, "alive");
    assert.deepEqual(progress, [1, 2, 3, 4]);
  } finally {
    await manager.stop();
  }
});

test("malformed worker stdout terminates the process and rejects pending work", async () => {
  const manager = createEngineWorkerManager({
    engineId: "fixture-malformed",
    executable: process.execPath,
    workerEntry,
    cwd: process.cwd()
  });
  await assert.rejects(manager.request({ command: "malformed" }), (error) => error.code === "ENGINE_WORKER_PROTOCOL_ERROR");
  await waitForStopped(manager);
  assert.equal(manager.snapshot().running, false);
});
