import { coalesceSpeechSegments, splitSpeechSegments } from "../shared/speech-planner.mjs";

function liveVoiceUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/assistant/live-voice`;
}

function turnId() {
  return globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function base64FromBytes(bytes) {
  let value = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) value += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  return btoa(value);
}

export class LiveVoiceClient {
  constructor({ onEvent = () => {}, onError = () => {}, onPlayback = () => {} } = {}) {
    this.onEvent = onEvent;
    this.onError = onError;
    this.onPlayback = onPlayback;
    this.socket = null;
    this.connecting = null;
    this.audioContext = null;
    this.playback = null;
    this.playbackSink = null;
    this.micStream = null;
    this.micSource = null;
    this.micNode = null;
    this.micSink = null;
    this.activeTurnId = "";
    this.activeMode = "";
    this.generation = 0;
    this.lastSequence = 0;
    this.ready = false;
    this.settingsKey = "";
    this.pendingText = "";
    this.pendingCommit = false;
    this.activeReplyId = "";
    this.segmentQueue = [];
    this.inFlightSegments = 0;
    this.segmentCount = 0;
    this.replyCommitRequested = false;
    this.replyCommitSent = false;
    this.segmentCommittedAt = new Map();
    this.lastCommitAt = 0;
    this.firstCommitChars = 0;
    this.firstPcmReceived = false;
    this.replyStartedAt = 0;
    this.playbackWaiter = null;
    this.micFrameCount = 0;
    this.micCaptureTimer = null;
    this.voiceFeatures = {};
    this.traceEnabled = false;
    this.persistentTtsSession = false;
    this.fadeTimer = null;
    this.bargeInMonitor = false;
    this.bargeInFrames = 0;
    this.bargeInTriggered = false;
    this.operationVersion = 0;
    this.closed = false;
  }

  sendPlaybackTelemetry(event, fields = {}) {
    if (!this.traceEnabled || !this.activeTurnId || this.socket?.readyState !== WebSocket.OPEN) return;
    this.send({ type: "playback.telemetry", turnId: this.activeTurnId, event, sampleRate: this.audioContext?.sampleRate || 0, ...fields });
  }

  sendTrace(event, fields = {}) {
    if (!this.traceEnabled || !this.activeTurnId || this.socket?.readyState !== WebSocket.OPEN) return;
    this.send({ type: "trace.event", turnId: this.activeTurnId, event, ...fields });
  }

  async ensureAudio() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: 24000, latencyHint: "interactive" });
      await this.audioContext.audioWorklet.addModule("/assistant-pcm-worklet.js");
      this.playback = new AudioWorkletNode(this.audioContext, "magicbox-pcm-playback", { outputChannelCount: [1] });
      this.playbackSink = this.audioContext.createGain();
      this.playback.connect(this.playbackSink).connect(this.audioContext.destination);
      this.playback.port.onmessage = (event) => {
        if (event.data?.generation !== this.generation) return;
        if (event.data?.type === "started") {
          this.onPlayback({ speaking: true, generation: this.generation });
          this.sendPlaybackTelemetry("playback.started", { bufferDepthMs: event.data.bufferedMs });
        }
        if (event.data?.type === "underrun") {
          this.onPlayback({ underruns: event.data.count, bufferedMs: event.data.bufferedMs, targetBufferMs: event.data.targetBufferMs, generation: this.generation });
          this.sendPlaybackTelemetry("playback.underrun", { bufferDepthMs: event.data.bufferedMs, underrunCount: event.data.count });
        }
        if (event.data?.type === "diagnostic") {
          // Flow control is required even when optional trace recording is off.
          if (this.activeTurnId && this.socket?.readyState === WebSocket.OPEN) {
            this.send({ type: "playback.progress", turnId: this.activeTurnId, playedMs: event.data.playheadMs || 0 });
          }
          const diagnostic = { ...event.data, type: "playback.diagnostic" };
          this.onPlayback(diagnostic);
          this.onEvent(diagnostic);
          this.sendPlaybackTelemetry("playback.buffer_depth", {
            bufferDepthMs: event.data.bufferedMs,
            underrunCount: event.data.underruns,
            underrunDurationMs: event.data.starvationDurationMs,
            playheadMs: event.data.playheadMs,
            semanticSilence: event.data.semanticSilence === true
          });
        }
        if (event.data?.type === "buffer_low" || event.data?.type === "buffer_empty" || event.data?.type === "non_silent_started" || event.data?.type === "non_silent_ended") {
          this.sendPlaybackTelemetry(`playback.${event.data.type}`, {
            bufferDepthMs: event.data.bufferedMs,
            playheadMs: event.data.playheadMs,
            semanticSilence: event.data.semanticSilence === true
          });
        }
        if (event.data?.type === "output_completed") {
          const bytes = new Uint8Array(event.data.pcm || new ArrayBuffer(0));
          this.sendPlaybackTelemetry("playback.output_completed", {
            outputPcmBase64: base64FromBytes(bytes),
            outputSamples: Number(event.data.outputSamples) || 0,
            sampleRate: Number(event.data.sampleRate) || this.audioContext?.sampleRate || 0
          });
        }
        if (event.data?.type === "completed") {
          this.onPlayback({ speaking: false, completed: true, underruns: event.data.underruns, starvationDurationMs: event.data.starvationDurationMs, maxStarvationMs: event.data.maxStarvationMs, generation: this.generation });
          this.finishPlayback();
          this.sendPlaybackTelemetry("playback.finished", { underrunCount: event.data.underruns, underrunDurationMs: event.data.starvationDurationMs });
        }
      };
    }
    if (this.audioContext.state === "suspended") await this.audioContext.resume();
  }

  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("The local voice connection is not ready.");
    this.socket.send(JSON.stringify(message));
  }

  async connect(settings) {
    if (this.closed) throw new DOMException("Voice session closed.", "AbortError");
    const key = `${settings.profileId}:${settings.speed}:${settings.styleStrength}:${settings.voicePipelineVersion || 4}`;
    if (this.ready && this.settingsKey === key && this.socket?.readyState === WebSocket.OPEN) {
      await this.ensureAudio();
      if (this.closed) throw new DOMException("Voice session closed.", "AbortError");
      return;
    }
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      await this.ensureAudio();
      if (this.closed) throw new DOMException("Voice session closed.", "AbortError");
      if (this.socket) this.socket.close(1000, "Reconnecting");
      const socket = new WebSocket(liveVoiceUrl());
      socket.binaryType = "arraybuffer";
      this.socket = socket;
      await new Promise((resolve, reject) => {
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          reject(error);
        };
        const timeout = window.setTimeout(() => fail(new Error("The local voice models took too long to prepare.")), 180000);
        socket.onopen = () => {
          this.send({
            type: "session.start",
            profileId: settings.profileId,
            speed: settings.speed,
            expressiveness: settings.styleStrength,
            protocolVersion: 4
          });
        };
        socket.onmessage = (event) => {
          if (this.closed || this.socket !== socket) return;
          if (event.data instanceof ArrayBuffer) {
            this.handleAudio(event.data);
            return;
          }
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === "session.ready") {
            if (!settled) {
              settled = true;
              window.clearTimeout(timeout);
              resolve();
            }
            this.ready = true;
            this.settingsKey = key;
            this.voiceFeatures = message.features || {};
            this.persistentTtsSession = this.voiceFeatures.persistentTtsSession === true || Number(message.protocolVersion) >= 5;
            this.traceEnabled = this.voiceFeatures.traceV2 === true;
            this.playback?.port.postMessage({
              type: "configure",
              statefulResampler: this.voiceFeatures.statefulResampler === true,
              inputSampleRate: Number(message.outputFormat?.sampleRate) || 24000,
              captureOutput: this.traceEnabled
            });
          } else if (message.type === "error") {
            const voiceError = new Error(message.message || "Local voice failed.");
            voiceError.code = message.code || "live_voice_failed";
            this.onError(voiceError, message);
            if (message.turnId && message.turnId === this.activeTurnId) {
              this.finishPlayback(voiceError);
              this.generation += 1;
              this.lastSequence = 0;
              this.playback?.port.postMessage({ type: "flush", generation: this.generation });
              this.onPlayback({ speaking: false, failed: true, generation: this.generation });
            }
            if (message.turnId && message.turnId === this.activeTurnId && this.activeMode === "input") {
              this.releaseMicrophone();
              this.activeMode = "";
            }
            if (!this.ready) {
              fail(voiceError);
            }
          }
          if (message.type !== "error" && message.generation && message.turnId === this.activeTurnId) {
            this.generation = message.generation;
            if (message.type === "tts.reply.ready" || message.type === "tts.ready") {
              this.lastSequence = 0;
              this.playback?.port.postMessage({ type: "flush", generation: this.generation });
            }
          }
          if (message.type === "tts.segment.completed" && message.turnId === this.activeTurnId) {
            this.inFlightSegments = Math.max(0, this.inFlightSegments - 1);
            this.drainSegmentQueue();
          }
          if (message.type === "tts.text.accepted" && message.turnId === this.activeTurnId) {
            this.inFlightSegments = Math.max(0, this.inFlightSegments - 1);
            this.drainSegmentQueue();
          }
          if ((message.type === "tts.reply.completed" || message.type === "tts.completed") && message.turnId === this.activeTurnId) this.playback?.port.postMessage({ type: "complete", generation: this.generation });
          if ((message.type === "input.ended" || message.type === "transcript.final") && message.turnId === this.activeTurnId && this.activeMode === "input") {
            this.releaseMicrophone();
            if (message.type === "transcript.final") this.activeMode = "";
          }
          this.onEvent(message);
        };
        socket.onerror = () => {
          const error = new Error("The local voice socket could not connect.");
          fail(error);
          if (this.socket === socket && this.activeTurnId) {
            this.finishPlayback(error);
            this.onError(error);
            this.cancel("socket-error");
          }
        };
        socket.onclose = () => {
          const error = new Error("The local voice connection closed. Please start again.");
          if (this.socket === socket) {
            this.ready = false;
            this.socket = null;
            if (this.activeTurnId) {
              this.finishPlayback(error);
              this.onError(error);
              this.cancel("socket-closed");
            }
          }
          fail(error);
        };
      });
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  handleAudio(buffer) {
    if (buffer.byteLength < 8 || !this.playback) return;
    const view = new DataView(buffer);
    const generation = view.getUint32(0, true);
    const sequence = view.getUint32(4, true);
    if (generation !== this.generation || sequence <= this.lastSequence) return;
    this.lastSequence = sequence;
    const v4 = buffer.byteLength >= 16;
    const segmentSequence = v4 ? view.getUint32(8, true) : 0;
    const boundaryPauseMs = v4 ? view.getUint16(12, true) : 0;
    const first = v4 ? Boolean(view.getUint16(14, true) & 1) : false;
    const pcm = buffer.slice(v4 ? 16 : 8);
    if (!this.firstPcmReceived) {
      this.firstPcmReceived = true;
      const now = performance.now();
      this.onPlayback({
        firstPcm: true,
        firstAudioLatencyMs: this.replyStartedAt ? Math.round(now - this.replyStartedAt) : null,
        segmentFirstAudioLatencyMs: this.segmentCommittedAt.has(segmentSequence) ? Math.round(now - this.segmentCommittedAt.get(segmentSequence)) : null,
        segmentSequence,
        generation
      });
    }
    this.playback.port.postMessage({ type: "audio", generation, pcm, segmentSequence, boundaryPauseMs, first }, [pcm]);
    this.sendPlaybackTelemetry("playback.frame_enqueued", { audioFrameSeq: sequence, clientMonotonicMs: performance.now() });
  }

  async startTts(settings, { replyId = "" } = {}) {
    this.cancel("restart");
    const operationVersion = this.operationVersion;
    await this.connect(settings);
    if (this.closed || this.operationVersion !== operationVersion) throw new DOMException("Voice start cancelled.", "AbortError");
    this.activeTurnId = turnId();
    this.activeReplyId = replyId || turnId();
    this.activeMode = "tts";
    this.segmentQueue = [];
    this.inFlightSegments = 0;
    this.segmentCount = 0;
    this.replyCommitRequested = false;
    this.replyCommitSent = false;
    this.segmentCommittedAt.clear();
    this.lastCommitAt = 0;
    this.firstCommitChars = 0;
    this.firstPcmReceived = false;
    this.replyStartedAt = performance.now();
    this.sendTrace("chat.request", { profileId: settings.profileId });
    this.send({
      type: "tts.reply.start", turnId: this.activeTurnId, replyId: this.activeReplyId,
      profileId: settings.profileId, speed: settings.speed, expressiveness: settings.styleStrength,
      playbackPaced: true
    });
    if (this.pendingText) {
      const text = this.pendingText;
      this.pendingText = "";
      this.appendText(text);
    }
    if (this.pendingCommit) {
      this.pendingCommit = false;
      this.commitText();
    }
    return this.activeTurnId;
  }

  appendSegment(text, { boundary = "strong", segmentId = "" } = {}) {
    const value = String(text || "").trim();
    if (!value) return 0;
    this.segmentCount += 1;
    const sequence = this.segmentCount;
    const now = performance.now();
    if (!this.firstCommitChars) {
      this.firstCommitChars = value.length;
      this.sendTrace("chat.first_token", { firstCommitChars: value.length });
    } else if (this.lastCommitAt) {
      this.sendTrace("chat.token_gap", { tokenGapMs: Math.round(now - this.lastCommitAt), nextCommitChars: value.length });
    }
    this.segmentQueue.push({
      type: this.persistentTtsSession ? "tts.text.append" : "tts.segment", turnId: this.activeTurnId, replyId: this.activeReplyId,
      segmentId: segmentId || `${this.activeReplyId}:${sequence}`, sequence, commitSeq: sequence, text: value, boundary
    });
    this.segmentCommittedAt.set(sequence, now);
    this.lastCommitAt = now;
    this.sendTrace("planner.flush_emitted", { commitSeq: sequence, textChars: value.length, boundary });
    this.drainSegmentQueue();
    return sequence;
  }

  drainSegmentQueue() {
    if (!this.activeTurnId || this.socket?.readyState !== WebSocket.OPEN) return;
    const maxInFlight = this.persistentTtsSession ? 1 : 3;
    while (this.inFlightSegments < maxInFlight && this.segmentQueue.length) {
      const segment = this.segmentQueue.shift();
      this.send(segment);
      this.inFlightSegments += 1;
    }
    if (this.replyCommitRequested && !this.replyCommitSent && this.segmentQueue.length === 0) {
      this.replyCommitSent = true;
      this.send(this.persistentTtsSession
        ? { type: "tts.input.finish", turnId: this.activeTurnId, replyId: this.activeReplyId, commitSeq: this.segmentCount }
        : { type: "tts.reply.commit", turnId: this.activeTurnId, replyId: this.activeReplyId, segmentCount: this.segmentCount });
    }
  }

  commitReply() {
    this.replyCommitRequested = true;
    this.drainSegmentQueue();
  }

  appendText(text) {
    if (!text) return;
    this.pendingText += text;
  }

  commitText() {
    if (!this.activeTurnId) {
      this.pendingCommit = true;
      return;
    }
    const text = this.pendingText;
    this.pendingText = "";
    const segments = coalesceSpeechSegments(splitSpeechSegments(text, { final: true }));
    for (const segment of segments) this.appendSegment(segment.text, { boundary: segment.boundary });
    this.commitReply();
  }

  waitForPlayback(turnId = this.activeTurnId, timeoutMs = 180000) {
    if (!turnId || turnId !== this.activeTurnId) return Promise.reject(new Error("The voice turn is no longer active."));
    if (this.playbackWaiter) return this.playbackWaiter.promise;
    let resolveWaiter;
    let rejectWaiter;
    const promise = new Promise((resolve, reject) => { resolveWaiter = resolve; rejectWaiter = reject; });
    const timeout = window.setTimeout(() => this.finishPlayback(new Error("Voice playback timed out.")), timeoutMs);
    this.playbackWaiter = { turnId, promise, resolve: resolveWaiter, reject: rejectWaiter, timeout };
    return promise;
  }

  finishPlayback(error = null) {
    const waiter = this.playbackWaiter;
    if (!waiter) return;
    window.clearTimeout(waiter.timeout);
    this.playbackWaiter = null;
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  async startInput(settings) {
    const monitorOnly = this.activeMode === "tts" && this.voiceFeatures.bargeIn === true;
    if (!monitorOnly) this.cancel("microphone");
    const operationVersion = this.operationVersion;
    await this.connect(settings);
    if (this.closed || this.operationVersion !== operationVersion) throw new DOMException("Microphone start cancelled.", "AbortError");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      video: false
    });
    if (this.closed || this.operationVersion !== operationVersion) {
      for (const item of stream.getTracks?.() || []) item.stop();
      throw new DOMException("Microphone start cancelled.", "AbortError");
    }
    const track = stream.getAudioTracks?.()[0];
    if (!track || track.readyState === "ended") {
      for (const item of stream.getTracks?.() || []) item.stop();
      throw new Error("Windows did not provide an active microphone track.");
    }
    this.micStream = stream;
    this.micSource = this.audioContext.createMediaStreamSource(this.micStream);
    this.micNode = new AudioWorkletNode(this.audioContext, "magicbox-mic-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.micSink = this.audioContext.createGain();
    this.micSink.gain.value = 0;
    this.micFrameCount = 0;
    this.bargeInMonitor = monitorOnly;
    this.bargeInFrames = 0;
    this.bargeInTriggered = false;
    this.micNode.port.onmessage = (event) => {
      if (event.data?.type === "rms" && this.bargeInMonitor) {
        this.micFrameCount += 1;
        const rms = Number(event.data.rms) || 0;
        this.bargeInFrames = rms >= 0.035 ? this.bargeInFrames + 1 : 0;
        if (!this.bargeInTriggered && this.bargeInFrames >= 5) {
          this.bargeInTriggered = true;
          this.onEvent({ type: "barge_in.detected", confirmationMs: 100, rms });
          this.cancel("barge-in");
          void this.startInput(settings).catch((error) => this.onError(error, { type: "error", code: "barge_in_failed" }));
        }
        return;
      }
      if (event.data?.type === "pcm" && this.socket?.readyState === WebSocket.OPEN) {
        if (this.bargeInMonitor) return;
        this.micFrameCount += 1;
        this.socket.send(event.data.pcm);
      }
    };
    if (!monitorOnly) {
      this.activeTurnId = turnId();
      this.activeMode = "input";
    } else {
      this.activeMode = "barge-in-monitor";
    }
    try {
      if (!monitorOnly) this.send({ type: "input.start", turnId: this.activeTurnId });
      this.micSource.connect(this.micNode).connect(this.micSink).connect(this.audioContext.destination);
    } catch (error) {
      this.releaseMicrophone();
      this.activeMode = "";
      throw error;
    }
    track.addEventListener?.("ended", () => {
      if (this.activeMode !== "input") return;
      const error = new Error("The selected Windows microphone disconnected.");
      this.onError(error, { type: "error", code: "microphone_disconnected", turnId: this.activeTurnId });
      this.cancel("microphone-disconnected");
    }, { once: true });
    this.micCaptureTimer = window.setTimeout(() => {
      if ((this.activeMode !== "input" && this.activeMode !== "barge-in-monitor") || this.micFrameCount > 0) return;
      const error = new Error("The microphone opened but produced no audio. Check the selected Windows input device.");
      this.onError(error, { type: "error", code: "microphone_no_frames", turnId: this.activeTurnId });
      this.cancel("microphone-no-frames");
    }, 2500);
    return this.activeTurnId;
  }

  canBargeIn() {
    return this.activeMode === "tts" && this.voiceFeatures.bargeIn === true;
  }

  stopInput() {
    if (this.activeMode === "barge-in-monitor") {
      this.releaseMicrophone();
      return;
    }
    if (this.activeTurnId) this.send({ type: "input.stop", turnId: this.activeTurnId });
    this.releaseMicrophone();
  }

  releaseMicrophone() {
    if (this.micCaptureTimer) window.clearTimeout(this.micCaptureTimer);
    this.micCaptureTimer = null;
    this.micNode?.port.postMessage({ type: "stop" });
    this.micNode?.disconnect();
    this.micSink?.disconnect();
    this.micSource?.disconnect();
    for (const track of this.micStream?.getTracks?.() || []) track.stop();
    this.micNode = null;
    this.micSink = null;
    this.micSource = null;
    this.micStream = null;
    this.micFrameCount = 0;
    this.bargeInMonitor = false;
    this.bargeInFrames = 0;
    this.bargeInTriggered = false;
  }

  cancel(reason = "client") {
    this.operationVersion += 1;
    if (this.fadeTimer) window.clearTimeout(this.fadeTimer);
    const oldGeneration = this.generation;
    this.playback?.port.postMessage({ type: "fadeOut", generation: oldGeneration, durationMs: 50 });
    this.finishPlayback(new DOMException("Voice playback was cancelled.", "AbortError"));
    this.releaseMicrophone();
    if (this.activeTurnId && this.socket?.readyState === WebSocket.OPEN) {
      this.send({ type: "turn.cancel", turnId: this.activeTurnId, reason });
    }
    this.generation += 1;
    this.lastSequence = 0;
    this.activeReplyId = "";
    this.segmentQueue = [];
    this.inFlightSegments = 0;
    this.segmentCount = 0;
    this.replyCommitRequested = false;
    this.replyCommitSent = false;
    this.segmentCommittedAt.clear();
    this.firstPcmReceived = false;
    this.replyStartedAt = 0;
    const cancelledGeneration = this.generation;
    this.fadeTimer = window.setTimeout(() => {
      if (this.generation === cancelledGeneration) this.playback?.port.postMessage({ type: "flush", generation: cancelledGeneration });
      this.fadeTimer = null;
    }, 55);
    this.sendPlaybackTelemetry("playback.cancelled");
    this.onPlayback({ speaking: false, cancelled: true, generation: this.generation });
    this.activeTurnId = "";
    this.activeMode = "";
    this.pendingText = "";
    this.pendingCommit = false;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.cancel("session-close");
    if (this.socket?.readyState === WebSocket.OPEN) this.send({ type: "session.close" });
    this.socket?.close(1000, "Session closed");
    this.socket = null;
    this.ready = false;
    await this.audioContext?.close?.();
    this.audioContext = null;
  }
}
