import fs from "node:fs/promises";
import path from "node:path";

function safeName(value, fallback = "unknown") {
  const normalized = String(value || "").replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 120) || fallback;
}

function wavFromPcm(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class VoiceTraceRecorder {
  constructor({ enabled = false, captureAudio = false, rootDir = path.resolve("artifacts", "live-voice-traces") } = {}) {
    this.enabled = Boolean(enabled);
    this.captureAudio = this.enabled && Boolean(captureAudio);
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    this.runDir = path.join(path.resolve(rootDir), stamp);
    this.tails = new Map();
    this.audio = new Map();
    this.playbackAudio = new Map();
    this.playbackIntervals = new Map();
    this.eventCounts = new Map();
    this.startedAt = performance.now();
  }

  record(event, context = {}, fields = {}) {
    if (!this.enabled) return;
    const replyId = String(context.replyId || fields.replyId || context.turnId || fields.turnId || "session");
    const filePath = path.join(this.runDir, `${safeName(replyId)}.jsonl`);
    const payload = {
      event,
      sessionId: context.sessionId || "",
      turnId: context.turnId || "",
      replyId: context.replyId || "",
      generationId: Number(context.generationId) || 0,
      ttsSessionId: context.ttsSessionId || "",
      commitSeq: Number(fields.commitSeq) || 0,
      audioFrameSeq: Number(fields.audioFrameSeq) || 0,
      inferenceInstanceId: context.inferenceInstanceId || fields.inferenceInstanceId || "",
      profileId: context.profileId || fields.profileId || "",
      speakerPromptHash: context.speakerPromptHash || fields.speakerPromptHash || "",
      referenceSetHash: context.referenceSetHash || fields.referenceSetHash || "",
      timestampEpochMs: Date.now(),
      processMonotonicMs: Number((performance.now() - this.startedAt).toFixed(3)),
      ...fields
    };
    this.eventCounts.set(event, (this.eventCounts.get(event) || 0) + 1);
    // Traces intentionally never persist text or encoded microphone/audio payloads.
    delete payload.text;
    delete payload.pcm;
    const timelineKey = String(payload.replyId || payload.turnId || "session");
    if (event === "playback.non_silent_started" || event === "non_silent_started") {
      const intervals = this.playbackIntervals.get(timelineKey) || [];
      intervals.push({ startMs: Number.isFinite(Number(fields.playheadMs)) ? Number(fields.playheadMs) : payload.processMonotonicMs });
      this.playbackIntervals.set(timelineKey, intervals);
    } else if (event === "playback.non_silent_ended" || event === "non_silent_ended") {
      const intervals = this.playbackIntervals.get(timelineKey) || [];
      const current = intervals.at(-1);
      if (current && current.endMs === undefined) {
        current.endMs = Number.isFinite(Number(fields.playheadMs)) ? Number(fields.playheadMs) : payload.processMonotonicMs;
        current.semanticSilence = fields.semanticSilence === true;
      }
      this.playbackIntervals.set(timelineKey, intervals);
    }
    const previous = this.tails.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await fs.mkdir(this.runDir, { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
    });
    this.tails.set(filePath, next);
    next.finally(() => {
      if (this.tails.get(filePath) === next) this.tails.delete(filePath);
    });
  }

  appendAudio(context, pcm) {
    if (!this.captureAudio || !pcm?.length) return;
    const key = String(context.replyId || context.turnId || "unknown");
    const chunks = this.audio.get(key) || [];
    chunks.push(Buffer.from(pcm));
    this.audio.set(key, chunks);
  }

  appendPlaybackAudio(context, pcm) {
    if (!this.captureAudio || !pcm?.length) return;
    const key = String(context.replyId || context.turnId || "unknown");
    const chunks = this.playbackAudio.get(key) || [];
    chunks.push(Buffer.from(pcm));
    this.playbackAudio.set(key, chunks);
  }

  finishPlaybackAudio(context, sampleRate = 24000) {
    if (!this.captureAudio) return;
    const key = String(context.replyId || context.turnId || "unknown");
    const chunks = this.playbackAudio.get(key);
    this.playbackAudio.delete(key);
    if (!chunks?.length) return;
    const filePath = path.join(this.runDir, `${safeName(key)}-worklet.wav`);
    const previous = this.tails.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await fs.mkdir(this.runDir, { recursive: true });
      await fs.writeFile(filePath, wavFromPcm(Buffer.concat(chunks), sampleRate));
    });
    this.tails.set(filePath, next);
  }

  finishAudio(context, sampleRate = 24000) {
    if (!this.captureAudio) return;
    const key = String(context.replyId || context.turnId || "unknown");
    const chunks = this.audio.get(key);
    this.audio.delete(key);
    if (!chunks?.length) return;
    const filePath = path.join(this.runDir, `${safeName(key)}.wav`);
    const previous = this.tails.get(filePath) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await fs.mkdir(this.runDir, { recursive: true });
      await fs.writeFile(filePath, wavFromPcm(Buffer.concat(chunks), sampleRate));
    });
    this.tails.set(filePath, next);
  }

  discardAudio(context) {
    const key = String(context.replyId || context.turnId || "unknown");
    this.audio.delete(key);
    this.playbackAudio.delete(key);
  }

  async close() {
    await Promise.allSettled([...this.tails.values()]);
    if (!this.enabled) return;
    await fs.mkdir(this.runDir, { recursive: true });
    const audibleGapMetrics = Object.fromEntries([...this.playbackIntervals.entries()].map(([replyId, intervals]) => {
      const gaps = [];
      for (let index = 1; index < intervals.length; index += 1) {
        const previous = intervals[index - 1];
        const current = intervals[index];
        if (previous.endMs === undefined || current.startMs === undefined) continue;
        gaps.push({
          gapMs: Math.max(0, Math.round(current.startMs - previous.endMs)),
          semanticSilence: previous.semanticSilence === true
        });
      }
      const midClause = gaps.filter((gap) => !gap.semanticSilence).map((gap) => gap.gapMs);
      const sorted = [...midClause].sort((left, right) => left - right);
      const percentile = (value) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * value))] : 0;
      return [replyId, {
        midClauseAudibleGapMs: midClause,
        midClauseAudibleGapP50Ms: percentile(0.5),
        midClauseAudibleGapP95Ms: percentile(0.95),
        unexpectedZeroRunMs: gaps.filter((gap) => !gap.semanticSilence).map((gap) => gap.gapMs)
      }];
    }));
    await fs.writeFile(path.join(this.runDir, "summary.json"), JSON.stringify({
      schemaVersion: 2,
      measuredAt: new Date().toISOString(),
      durationMs: Number((performance.now() - this.startedAt).toFixed(3)),
      captureAudio: this.captureAudio,
      privacy: this.captureAudio ? "assistant-pcm-opt-in" : "metrics-only",
      eventCounts: Object.fromEntries([...this.eventCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      audibleGapMetrics
    }, null, 2), "utf8");
  }
}
