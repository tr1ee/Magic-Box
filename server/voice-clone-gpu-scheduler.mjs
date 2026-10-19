import fs from "node:fs/promises";
import path from "node:path";

export const VOICE_GPU_PRIORITIES = Object.freeze({
  interactiveTtv: 0,
  vtv: 1,
  preparation: 2,
  fineBuild: 3,
  regression: 4
});

const terminalStates = new Set(["completed", "failed", "cancelled", "interrupted"]);

function isOutOfMemory(error) {
  return /out of memory|cuda.*memory|cublas_status_alloc_failed|oom/iu.test(String(error?.message || error || ""));
}

export class VoiceGpuScheduler {
  constructor({ statePath, maxHeavyJobs = 1, logger = () => {}, now = () => Date.now() } = {}) {
    this.statePath = statePath || path.join(process.cwd(), "voice-gpu-scheduler.json");
    this.maxHeavyJobs = Math.max(1, Math.round(Number(maxHeavyJobs) || 1));
    this.logger = logger;
    this.now = now;
    this.queue = [];
    this.running = new Map();
    this.jobs = new Map();
    this.sequence = 0;
    this.persistTail = Promise.resolve();
  }

  async restore() {
    try {
      const stored = JSON.parse(await fs.readFile(this.statePath, "utf8"));
      for (const record of Array.isArray(stored?.jobs) ? stored.jobs : []) {
        if (terminalStates.has(record.status)) continue;
        this.jobs.set(record.id, { ...record, status: "interrupted", interruptionReason: "scheduler_restart" });
      }
      await this.persist();
    } catch {
      // First boot and malformed scheduler state are intentionally equivalent
      // to an empty queue. Durable voice jobs remain queryable in the voice DB.
    }
    return this.snapshot();
  }

  enqueue({ id, kind = "voice", priority = VOICE_GPU_PRIORITIES.vtv, run, metadata = {}, signal = null } = {}) {
    if (typeof run !== "function") throw new TypeError("VoiceGpuScheduler.enqueue requires a run function.");
    const job = {
      id: String(id || `voice-gpu-${this.now()}-${++this.sequence}`),
      kind: String(kind),
      priority: Math.max(0, Math.min(9, Math.round(Number(priority) || 0))),
      status: "queued",
      heartbeatAt: new Date(this.now()).toISOString(),
      createdAt: new Date(this.now()).toISOString(),
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      oomRecoveries: 0,
      metadata: { ...metadata }
    };
    this.jobs.set(job.id, job);
    this.queue.push({ job, run, signal });
    this.queue.sort((left, right) => left.job.priority - right.job.priority || left.job.createdAt.localeCompare(right.job.createdAt));
    void this.persist();
    void this.pump();
    return job;
  }

  async acquire({ id, kind = "voice", priority = VOICE_GPU_PRIORITIES.vtv, metadata = {}, signal = null } = {}) {
    let releaseGate;
    let startedResolve;
    const started = new Promise((resolve) => { startedResolve = resolve; });
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const job = this.enqueue({
      id,
      kind,
      priority,
      metadata,
      signal,
      run: async () => {
        startedResolve();
        await gate;
      }
    });
    let abortHandler;
    const aborted = new Promise((_, reject) => {
      abortHandler = () => {
        this.cancel(job.id);
        const error = new Error("Voice GPU resource acquisition was cancelled.");
        error.code = "VOICE_JOB_CANCELLED";
        reject(error);
      };
      signal?.addEventListener("abort", abortHandler, { once: true });
    });
    try {
      await Promise.race([started, aborted]);
      return {
        job,
        release: () => releaseGate(),
        diagnostics: { schedulerJobId: job.id, priority: job.priority }
      };
    } finally {
      signal?.removeEventListener("abort", abortHandler);
    }
  }

  async pump() {
    while (this.running.size < this.maxHeavyJobs && this.queue.length) {
      const entry = this.queue.shift();
      if (entry.signal?.aborted) {
        entry.job.status = "cancelled";
        entry.job.finishedAt = new Date(this.now()).toISOString();
        continue;
      }
      this.running.set(entry.job.id, entry);
      void this.execute(entry).finally(() => {
        this.running.delete(entry.job.id);
        void this.pump();
      });
    }
    await this.persist();
  }

  async execute(entry) {
    const { job, run, signal } = entry;
    job.status = "running";
    job.startedAt = new Date(this.now()).toISOString();
    job.attempts += 1;
    this.touch(job, { stage: "started" });
    try {
      job.result = await run({
        signal,
        heartbeat: (details = {}) => this.touch(job, details)
      });
      job.status = "completed";
      job.finishedAt = new Date(this.now()).toISOString();
    } catch (error) {
      if (signal?.aborted) {
        job.status = "cancelled";
      } else if (isOutOfMemory(error) && job.oomRecoveries < 1) {
        job.oomRecoveries += 1;
        job.status = "queued";
        job.recovery = "oom_restart_required";
        this.logger(`voice-gpu-scheduler: OOM recovery scheduled for ${job.id}`);
        this.queue.unshift(entry);
        await this.persist();
        return;
      } else {
        job.status = "failed";
        job.error = String(error?.message || error);
        job.errorCode = isOutOfMemory(error) ? "VOICE_GPU_OOM_UNRECOVERED" : String(error?.code || "VOICE_GPU_JOB_FAILED");
      }
      job.finishedAt = new Date(this.now()).toISOString();
    }
    job.heartbeatAt = new Date(this.now()).toISOString();
    await this.persist();
  }

  touch(job, details = {}) {
    if (!job) return;
    Object.assign(job, details, { heartbeatAt: new Date(this.now()).toISOString() });
    void this.persist();
  }

  cancel(id) {
    const job = this.jobs.get(String(id));
    if (!job || terminalStates.has(job.status)) return false;
    job.status = "cancelled";
    job.finishedAt = new Date(this.now()).toISOString();
    this.queue = this.queue.filter((entry) => entry.job.id !== job.id);
    void this.persist();
    return true;
  }

  snapshot() {
    return {
      schemaVersion: 1,
      maxHeavyJobs: this.maxHeavyJobs,
      queued: this.queue.map(({ job }) => ({ ...job })),
      running: Array.from(this.running.values()).map(({ job }) => ({ ...job })),
      jobs: Array.from(this.jobs.values()).map((job) => ({ ...job }))
    };
  }

  async persist() {
    const payload = JSON.stringify(this.snapshot(), null, 2);
    this.persistTail = this.persistTail.then(async () => {
      await fs.mkdir(path.dirname(this.statePath), { recursive: true });
      const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, payload, "utf8");
      await fs.rename(temporary, this.statePath);
    }).catch(() => {});
    return this.persistTail;
  }
}

export function createVoiceGpuScheduler(options = {}) {
  return new VoiceGpuScheduler(options);
}
