import test from "node:test";
import assert from "node:assert/strict";
import { currentVoiceJobWorkers, withVoiceJobWorkers } from "../server/voice/job-worker-scope.mjs";

test("job retries reuse models, serialize requests, and release them before another GPU stage", async () => {
  const events = [];
  let active = 0;
  let started = 0;
  await withVoiceJobWorkers(({ engine }) => {
    const id = ++started;
    return {
      async request(value) {
        assert.equal(active++, 0);
        await Promise.resolve();
        active--;
        events.push(["request", id, engine, value]);
        return value;
      },
      async close() { events.push(["close", id, engine]); }
    };
  }, async () => {
    const pool = currentVoiceJobWorkers();
    assert.deepEqual(await Promise.all([pool.request("gpt", 1, {}), pool.request("gpt", 2, {})]), [1, 2]);
    await pool.close("gpt");
    assert.deepEqual(events.at(-1), ["close", 1, "gpt"]);
    await pool.request("asr", 3, {});
    await pool.request("asr", 4, {});
  });
  assert.equal(started, 2);
  assert.deepEqual(events.at(-1), ["close", 2, "asr"]);
  assert.equal(currentVoiceJobWorkers(), undefined);
});

test("failed workers are evicted and job failure closes remaining models", async () => {
  let started = 0;
  const closed = [];
  await assert.rejects(withVoiceJobWorkers(() => {
    const id = ++started;
    return { async request() { if (id === 1) throw new Error("worker crash"); return id; }, async close() { closed.push(id); } };
  }, async () => {
    const pool = currentVoiceJobWorkers();
    await assert.rejects(pool.request("gpt", {}, {}), /worker crash/);
    assert.equal(await pool.request("gpt", {}, {}), 2);
    throw new Error("job cancelled");
  }), /job cancelled/);
  assert.deepEqual(closed, [1, 2]);
});

test("concurrent jobs never share workers or cleanup each other's models", async () => {
  let started = 0;
  const closed = [];
  const create = () => { const id = ++started; return { async request() { return id; }, async close() { closed.push(id); } }; };
  const results = await Promise.all([1, 2].map(() => withVoiceJobWorkers(create, async () => {
    await Promise.resolve();
    return currentVoiceJobWorkers().request("asr", {}, {});
  })));
  assert.deepEqual(results, [1, 2]);
  assert.deepEqual(closed.sort(), [1, 2]);
});
