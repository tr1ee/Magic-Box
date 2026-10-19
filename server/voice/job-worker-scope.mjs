import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage();
export const currentVoiceJobWorkers = () => scope.getStore();

// Own workers for precisely one job. Models survive retries, but neither a
// finished job nor a different concurrent job inherits their GPU allocation.
export async function withVoiceJobWorkers(createSession, run) {
  const sessions = new Map();
  const pool = {
    async request(engine, payload, options) {
      let record = sessions.get(engine);
      if (!record) {
        record = { session: createSession({ engine, timeoutMs: options.timeoutMs }), tail: Promise.resolve() };
        sessions.set(engine, record);
      }
      const pending = record.tail.catch(() => {}).then(() => record.session.request(payload, options));
      record.tail = pending.catch(() => {});
      try { return await pending; }
      catch (error) { await pool.close(engine); throw error; }
    },
    async close(engine) {
      const record = sessions.get(engine);
      if (!record) return;
      sessions.delete(engine);
      await record.tail;
      await record.session.close();
    }
  };
  return scope.run(pool, async () => {
    try { return await run(); }
    finally { await Promise.allSettled([...sessions.keys()].map(engine => pool.close(engine))); }
  });
}
