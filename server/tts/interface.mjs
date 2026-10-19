import { randomUUID } from "node:crypto";

export function createTtsStartRequest(input = {}) {
  return {
    replyId: String(input.replyId || randomUUID()),
    generationId: Number(input.generationId) || 0,
    profileId: String(input.profileId || ""),
    language: String(input.language || "auto"),
    speed: Number(input.speed) || 1,
    pitch: Number(input.pitch) || 0,
    styleStrength: Number(input.styleStrength) || 0.7,
    outputSampleRate: Number(input.outputSampleRate) || 24000
  };
}

export function assertTtsAppend(input = {}) {
  const seq = Number(input.seq);
  const text = String(input.text || "").trim();
  if (!Number.isInteger(seq) || seq < 1) throw new Error("TTS append sequence must be a positive integer.");
  if (!text || text.length > 1200) throw new Error("TTS append text must be non-empty and bounded.");
  return { seq, text, isFinal: input.isFinal === true };
}

export class StreamingTtsEngine {
  constructor({ id = "local-tts", send = async () => {} } = {}) {
    this.id = id;
    this.send = send;
  }

  async warm(profileId) { await this.send({ type: "profile.warm", profileId }); }

  async start(request) {
    const normalized = createTtsStartRequest(request);
    const sessionId = `tts-${randomUUID()}`;
    await this.send({ type: "tts.session.start", ttsSessionId: sessionId, ...normalized });
    return { ttsSessionId: sessionId, generationId: normalized.generationId, provider: this.id };
  }

  async append(sessionId, input) {
    const append = assertTtsAppend(input);
    await this.send({ type: "tts.text.append", ttsSessionId: sessionId, commitSeq: append.seq, text: append.text, isFinal: append.isFinal });
  }

  async finish(sessionId) { await this.send({ type: "tts.input.finish", ttsSessionId: sessionId }); }

  async cancel(sessionId, reason = "cancelled") { await this.send({ type: "tts.session.cancel", ttsSessionId: sessionId, reason }); }

  async health() { return { id: this.id, status: "ready", supportsPersistentText: true }; }
}
