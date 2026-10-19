import { VtvEngineError } from "./engine-errors.mjs";

export function createGpuLeaseManager({ maxResidentGpuWorkers = 1 } = {}) {
  const limit = Math.max(1, Math.round(Number(maxResidentGpuWorkers) || 1));
  let active = 0;
  let sequence = 0;
  const waiters = [];

  function pump() {
    while (active < limit && waiters.length) {
      const waiter = waiters.shift();
      if (waiter.signal?.aborted) {
        waiter.reject(new VtvEngineError("ENGINE_CANCELLED", "GPU lease acquisition was cancelled.", { engineId: waiter.engineId }));
        continue;
      }
      active += 1;
      let released = false;
      waiter.resolve({
        id: `gpu-lease-${++sequence}`,
        jobId: waiter.jobId,
        engineId: waiter.engineId,
        release() {
          if (released) return;
          released = true;
          active = Math.max(0, active - 1);
          pump();
        }
      });
    }
  }

  return {
    acquire({ jobId = "", engineId = "", signal = null } = {}) {
      return new Promise((resolve, reject) => {
        const waiter = { jobId, engineId, signal, resolve, reject };
        if (signal?.aborted) {
          reject(new VtvEngineError("ENGINE_CANCELLED", "GPU lease acquisition was cancelled.", { engineId }));
          return;
        }
        waiters.push(waiter);
        pump();
      });
    },
    snapshot() {
      return { maxResidentGpuWorkers: limit, active, queued: waiters.length };
    }
  };
}
