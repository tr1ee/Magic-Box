const WorkletProcessorBase = globalThis.AudioWorkletProcessor || class {};

export class StreamingResampler {
  constructor(inputRate, outputRate) {
    this.configure(inputRate, outputRate);
  }

  configure(inputRate, outputRate) {
    const nextInputRate = Math.max(1, Number(inputRate) || 24000);
    const nextOutputRate = Math.max(1, Number(outputRate) || nextInputRate);
    if (this.inputRate === nextInputRate && this.outputRate === nextOutputRate) return;
    this.inputRate = nextInputRate;
    this.outputRate = nextOutputRate;
    this.ratio = this.inputRate / this.outputRate;
    this.reset();
  }

  reset() {
    this.nextInputPosition = 0;
    this.previousSample = 0;
    this.hasPreviousSample = false;
    this.totalInputSamples = 0;
    this.totalOutputSamples = 0;
  }

  process(input) {
    const samples = input instanceof Int16Array ? input : new Int16Array(input || 0);
    if (!samples.length) return new Int16Array(0);
    const start = this.totalInputSamples;
    const end = start + samples.length - 1;
    const output = [];
    const epsilon = 1e-9;
    while (this.nextInputPosition <= end + epsilon) {
      const leftIndex = Math.floor(this.nextInputPosition + epsilon);
      const fraction = this.nextInputPosition - leftIndex;
      const rightIndex = leftIndex + 1;
      if (fraction > epsilon && rightIndex > end) break;
      let left;
      if (leftIndex === start - 1 && this.hasPreviousSample) left = this.previousSample;
      else if (leftIndex >= start && leftIndex <= end) left = samples[leftIndex - start];
      else break;
      const right = fraction <= epsilon
        ? left
        : rightIndex === start - 1 && this.hasPreviousSample
          ? this.previousSample
          : samples[rightIndex - start];
      output.push(Math.max(-32768, Math.min(32767, Math.round(left + ((right - left) * fraction)))));
      this.nextInputPosition += this.ratio;
    }
    this.previousSample = samples.at(-1);
    this.hasPreviousSample = true;
    this.totalInputSamples += samples.length;
    this.totalOutputSamples += output.length;
    return Int16Array.from(output);
  }

  flush() {
    if (!this.hasPreviousSample) return new Int16Array(0);
    const expected = Math.round(this.totalInputSamples * this.outputRate / this.inputRate);
    const missing = Math.max(0, expected - this.totalOutputSamples);
    const output = new Int16Array(missing);
    output.fill(this.previousSample);
    this.totalOutputSamples += output.length;
    this.nextInputPosition += output.length * this.ratio;
    return output;
  }

  accounting() {
    const expectedOutputSamples = Math.round(this.totalInputSamples * this.outputRate / this.inputRate);
    return {
      inputRate: this.inputRate,
      outputRate: this.outputRate,
      fractionalPhase: this.nextInputPosition - Math.floor(this.nextInputPosition),
      previousSample: this.previousSample,
      filterState: "linear-history-1",
      totalInputSamples: this.totalInputSamples,
      totalOutputSamples: this.totalOutputSamples,
      expectedOutputSamples,
      sampleDrift: this.totalOutputSamples - expectedOutputSamples
    };
  }
}

export class SampleRingBuffer {
  constructor(capacity = 4096) {
    this.storage = new Int16Array(Math.max(1, Number(capacity) || 4096));
    this.readIndex = 0;
    this.length = 0;
  }

  clear() {
    this.readIndex = 0;
    this.length = 0;
  }

  ensureCapacity(required) {
    if (required <= this.storage.length) return;
    let capacity = this.storage.length;
    while (capacity < required) capacity *= 2;
    const replacement = new Int16Array(capacity);
    replacement.set(this.toArray());
    this.storage = replacement;
    this.readIndex = 0;
  }

  push(samples) {
    if (!samples?.length) return;
    this.ensureCapacity(this.length + samples.length);
    let writeIndex = (this.readIndex + this.length) % this.storage.length;
    let sourceIndex = 0;
    while (sourceIndex < samples.length) {
      const count = Math.min(samples.length - sourceIndex, this.storage.length - writeIndex);
      this.storage.set(samples.subarray(sourceIndex, sourceIndex + count), writeIndex);
      writeIndex = (writeIndex + count) % this.storage.length;
      sourceIndex += count;
    }
    this.length += samples.length;
  }

  toArray() {
    const output = new Int16Array(this.length);
    const firstCount = Math.min(this.length, this.storage.length - this.readIndex);
    output.set(this.storage.subarray(this.readIndex, this.readIndex + firstCount));
    if (firstCount < this.length) output.set(this.storage.subarray(0, this.length - firstCount), firstCount);
    return output;
  }

  readIntoFloat32(output, count = output.length) {
    const readable = Math.min(this.length, output.length, Math.max(0, Number(count) || 0));
    for (let index = 0; index < readable; index += 1) {
      output[index] = this.storage[(this.readIndex + index) % this.storage.length] / 32768;
    }
    this.readIndex = (this.readIndex + readable) % this.storage.length;
    this.length -= readable;
    if (!this.length) this.readIndex = 0;
    return readable;
  }
}

class MagicBoxPcmPlaybackProcessor extends WorkletProcessorBase {
  constructor() {
    super();
    this.ring = new SampleRingBuffer(Math.round(sampleRate * 2.4));
    this.started = false;
    this.generation = 0;
    this.underruns = 0;
    this.completeRequested = false;
    this.segmentSequence = 0;
    this.targetBufferMs = 1000;
    this.maxBufferMs = 2400;
    this.tailHoldSamples = Math.round(sampleRate * 0.12);
    this.joinSamples = Math.round(sampleRate * 0.018);
    this.starvationStartedFrame = 0;
    this.starvationDurationSamples = 0;
    this.maxStarvationSamples = 0;
    this.resumeAfterUnderrun = false;
    this.lastDiagnosticFrame = 0;
    this.useStatefulResampler = false;
    this.resampler = new StreamingResampler(24000, sampleRate);
    this.queuedSamples = 0;
    this.playedSamples = 0;
    this.maxBufferedSamples = 0;
    this.fadeRemainingSamples = 0;
    this.fadeTotalSamples = 0;
    this.captureOutput = false;
    this.outputChunks = [];
    this.nonSilent = false;
    this.nonSilentThreshold = 0.003;
    this.semanticSilenceSamples = 0;
    this.lastBufferLow = false;
    this.lastBufferEmpty = false;
    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "flush") {
        this.ring.clear();
        this.started = false;
        this.completeRequested = false;
        this.generation = Number(message.generation) || 0;
        this.underruns = 0;
        this.segmentSequence = 0;
        this.targetBufferMs = 1000;
        this.starvationStartedFrame = 0;
        this.starvationDurationSamples = 0;
        this.maxStarvationSamples = 0;
        this.resumeAfterUnderrun = false;
        this.lastDiagnosticFrame = 0;
        this.resampler.reset();
        this.queuedSamples = 0;
        this.playedSamples = 0;
        this.maxBufferedSamples = 0;
        this.fadeRemainingSamples = 0;
        this.fadeTotalSamples = 0;
        this.outputChunks = [];
        this.nonSilent = false;
        this.semanticSilenceSamples = 0;
        this.lastBufferLow = false;
        this.lastBufferEmpty = false;
      } else if (message.type === "configure") {
        this.useStatefulResampler = message.statefulResampler === true;
        this.captureOutput = message.captureOutput === true;
        this.resampler.configure(Number(message.inputSampleRate) || 24000, sampleRate);
      } else if (message.type === "fadeOut" && Number(message.generation) === this.generation) {
        this.fadeTotalSamples = Math.max(1, Math.round(sampleRate * Math.max(10, Math.min(120, Number(message.durationMs) || 50)) / 1000));
        this.fadeRemainingSamples = this.fadeTotalSamples;
      } else if (message.type === "audio" && Number(message.generation) === this.generation) {
        let samples = new Int16Array(message.pcm);
        if (this.useStatefulResampler) {
          samples = this.resampler.process(samples);
        } else if (sampleRate !== 24000 && samples.length > 1) {
          const outputLength = Math.max(1, Math.round(samples.length * sampleRate / 24000));
          const resampled = new Int16Array(outputLength);
          const ratio = 24000 / sampleRate;
          for (let index = 0; index < outputLength; index += 1) {
            const position = Math.min(samples.length - 1, index * ratio);
            const left = Math.floor(position);
            const right = Math.min(samples.length - 1, left + 1);
            resampled[index] = Math.round(samples[left] + ((samples[right] - samples[left]) * (position - left)));
          }
          samples = resampled;
        }
        if (samples.length) {
          const nextSegment = Number(message.segmentSequence) || this.segmentSequence;
          if (message.first && this.segmentSequence && nextSegment !== this.segmentSequence) {
            const pauseSamples = Math.round(sampleRate * Math.max(0, Math.min(900, Number(message.boundaryPauseMs) || 0)) / 1000);
            if (pauseSamples > 0) samples = this.pauseSegment(samples, pauseSamples);
            else samples = this.joinSegment(samples);
          }
          this.segmentSequence = nextSegment;
          this.pushSamples(samples);
        }
      } else if (message.type === "complete" && Number(message.generation) === this.generation) {
        if (this.useStatefulResampler) this.pushSamples(this.resampler.flush());
        this.completeRequested = true;
      }
    };
  }

  pushSamples(samples) {
    if (!samples?.length) return;
    this.ring.push(samples);
    this.queuedSamples += samples.length;
    this.maxBufferedSamples = Math.max(this.maxBufferedSamples, this.buffered);
  }

  get buffered() {
    return this.ring.length;
  }

  flattenRemaining() {
    const flattened = this.ring.toArray();
    this.ring.clear();
    this.ring.push(flattened);
    return flattened;
  }

  joinSegment(samples) {
    const remaining = this.flattenRemaining();
    const count = Math.min(this.joinSamples, remaining.length, samples.length);
    if (!count) return samples;
    const prefixLength = remaining.length - count;
    const joined = new Int16Array(count);
    for (let index = 0; index < count; index += 1) {
      const phase = (index + 1) / (count + 1) * Math.PI / 2;
      const left = remaining[prefixLength + index] * Math.cos(phase);
      const right = samples[index] * Math.sin(phase);
      joined[index] = Math.max(-32768, Math.min(32767, Math.round(left + right)));
    }
    this.ring.clear();
    this.pushSamples(remaining.subarray(0, prefixLength));
    this.pushSamples(joined);
    return samples.subarray(count);
  }

  pauseSegment(samples, pauseSamples) {
    const remaining = this.flattenRemaining();
    const leftCount = Math.min(this.joinSamples, remaining.length);
    const rightCount = Math.min(this.joinSamples, samples.length);
    for (let index = 0; index < leftCount; index += 1) {
      const phase = (index + 1) / leftCount * Math.PI / 2;
      const target = remaining.length - leftCount + index;
      remaining[target] = Math.round(remaining[target] * Math.cos(phase));
    }
    const fadedIn = new Int16Array(samples);
    for (let index = 0; index < rightCount; index += 1) {
      const phase = (index + 1) / rightCount * Math.PI / 2;
      fadedIn[index] = Math.round(fadedIn[index] * Math.sin(phase));
    }
    this.ring.clear();
    this.pushSamples(remaining);
    this.pushSamples(new Int16Array(pauseSamples));
    this.semanticSilenceSamples += pauseSamples;
    return fadedIn;
  }

  finishOutput() {
    if (!this.captureOutput || !this.outputChunks.length) return;
    const pcm = new Int16Array(this.outputChunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of this.outputChunks) {
      pcm.set(chunk, offset);
      offset += chunk.length;
    }
    this.outputChunks = [];
    this.port.postMessage({ type: "output_completed", generation: this.generation, pcm: pcm.buffer, outputSamples: pcm.length, sampleRate }, [pcm.buffer]);
  }

  observeOutput(output) {
    let peak = 0;
    for (const value of output) peak = Math.max(peak, Math.abs(value));
    const hasSignal = peak >= this.nonSilentThreshold;
    const playheadMs = Math.round(this.playedSamples / sampleRate * 1000);
    if (hasSignal && !this.nonSilent) {
      this.nonSilent = true;
      this.port.postMessage({ type: "non_silent_started", generation: this.generation, playheadMs, bufferedMs: Math.round(this.buffered / sampleRate * 1000) });
    } else if (!hasSignal && this.nonSilent) {
      this.nonSilent = false;
      this.port.postMessage({ type: "non_silent_ended", generation: this.generation, playheadMs, semanticSilence: this.semanticSilenceSamples > 0, bufferedMs: Math.round(this.buffered / sampleRate * 1000) });
    }
    if (this.captureOutput && (this.started || this.completeRequested)) {
      const chunk = new Int16Array(output.length);
      for (let index = 0; index < output.length; index += 1) chunk[index] = Math.max(-32768, Math.min(32767, Math.round(output[index] * 32767)));
      this.outputChunks.push(chunk);
    }
    const low = this.buffered > 0 && this.buffered <= Math.round(sampleRate * this.targetBufferMs / 1000);
    const empty = this.buffered === 0;
    const bufferedMs = Math.round(this.buffered / sampleRate * 1000);
    if (low && !this.lastBufferLow) this.port.postMessage({ type: "buffer_low", generation: this.generation, playheadMs, bufferedMs, targetBufferMs: this.targetBufferMs });
    if (empty && !this.lastBufferEmpty) this.port.postMessage({ type: "buffer_empty", generation: this.generation, playheadMs, bufferedMs, targetBufferMs: this.targetBufferMs });
    this.lastBufferLow = low;
    this.lastBufferEmpty = empty;
    this.semanticSilenceSamples = Math.max(0, this.semanticSilenceSamples - output.length);
  }

  finishStarvation() {
    if (!this.starvationStartedFrame) return;
    const duration = Math.max(0, currentFrame - this.starvationStartedFrame);
    this.starvationDurationSamples += duration;
    this.maxStarvationSamples = Math.max(this.maxStarvationSamples, duration);
    this.starvationStartedFrame = 0;
  }

  postDiagnostic(force = false) {
    if (!force && currentFrame - this.lastDiagnosticFrame < sampleRate / 4) return;
    this.lastDiagnosticFrame = currentFrame;
    this.port.postMessage({
      type: "diagnostic",
      generation: this.generation,
      bufferedMs: Math.round(this.buffered / sampleRate * 1000),
      targetBufferMs: this.targetBufferMs,
      underruns: this.underruns,
      starvationDurationMs: Math.round(this.starvationDurationSamples / sampleRate * 1000),
      maxStarvationMs: Math.round(this.maxStarvationSamples / sampleRate * 1000),
      queuedSamples: this.queuedSamples,
      playedSamples: this.playedSamples,
      playheadMs: Math.round(this.playedSamples / sampleRate * 1000),
      bufferLow: this.buffered > 0 && this.buffered <= Math.round(sampleRate * this.targetBufferMs / 1000),
      bufferEmpty: this.buffered === 0,
      semanticSilence: this.semanticSilenceSamples > 0,
      maxBufferDepthMs: Math.round(this.maxBufferedSamples / sampleRate * 1000),
      resampler: this.useStatefulResampler ? this.resampler.accounting() : null
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) return true;
    output.fill(0);
    if (!this.started) {
      if (this.completeRequested && this.buffered === 0) {
        this.completeRequested = false;
        this.finishStarvation();
        this.finishOutput();
        this.port.postMessage({ type: "completed", generation: this.generation, underruns: this.underruns, starvationDurationMs: Math.round(this.starvationDurationSamples / sampleRate * 1000), maxStarvationMs: Math.round(this.maxStarvationSamples / sampleRate * 1000) });
        return true;
      }
      const targetSamples = Math.round(sampleRate * (this.resumeAfterUnderrun ? 200 : this.targetBufferMs) / 1000);
      if (this.buffered < targetSamples && !this.completeRequested) {
        this.postDiagnostic();
        return true;
      }
      this.started = true;
      this.resumeAfterUnderrun = false;
      this.finishStarvation();
      this.port.postMessage({ type: "started", generation: this.generation, bufferedMs: Math.round(this.buffered / sampleRate * 1000), targetBufferMs: this.targetBufferMs });
    }
    const playable = this.completeRequested ? this.buffered : Math.max(0, this.buffered - this.tailHoldSamples);
    const outputLimit = Math.min(output.length, playable);
    const target = this.ring.readIntoFloat32(output, outputLimit);
    if (this.fadeRemainingSamples > 0 && target > 0) {
      const start = this.fadeTotalSamples - this.fadeRemainingSamples;
      for (let index = 0; index < target; index += 1) {
        const progress = Math.min(1, (start + index) / this.fadeTotalSamples);
        output[index] *= Math.max(0, 1 - progress);
      }
      this.fadeRemainingSamples = Math.max(0, this.fadeRemainingSamples - target);
      if (!this.fadeRemainingSamples) {
        this.ring.clear();
        this.started = false;
      }
    }
    this.observeOutput(output);
    this.playedSamples += target;
    if (this.completeRequested && this.buffered === 0) {
      this.completeRequested = false;
      this.started = false;
      this.finishStarvation();
      this.finishOutput();
      this.port.postMessage({ type: "completed", generation: this.generation, underruns: this.underruns, starvationDurationMs: Math.round(this.starvationDurationSamples / sampleRate * 1000), maxStarvationMs: Math.round(this.maxStarvationSamples / sampleRate * 1000) });
    } else if (target < output.length && this.started && playable < output.length) {
      this.underruns += 1;
      this.started = false;
      this.resumeAfterUnderrun = true;
      if (!this.starvationStartedFrame) this.starvationStartedFrame = currentFrame + target;
      this.targetBufferMs = Math.min(this.maxBufferMs, Math.max(1000, this.targetBufferMs + 300));
      this.port.postMessage({ type: "underrun", generation: this.generation, count: this.underruns, bufferedMs: Math.round(this.buffered / sampleRate * 1000), targetBufferMs: this.targetBufferMs });
    }
    this.postDiagnostic();
    return true;
  }
}

class MagicBoxMicCaptureProcessor extends WorkletProcessorBase {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.sourcePosition = 0;
    this.pending = [];
    this.active = true;
    this.port.onmessage = (event) => {
      if (event.data?.type === "stop") this.active = false;
    };
  }

  process(inputs) {
    if (!this.active) return true;
    const input = inputs[0]?.[0];
    if (!input?.length) return true;
    while (this.sourcePosition < input.length) {
      const left = Math.floor(this.sourcePosition);
      const right = Math.min(input.length - 1, left + 1);
      const fraction = this.sourcePosition - left;
      const value = input[left] + ((input[right] - input[left]) * fraction);
      this.pending.push(Math.max(-32768, Math.min(32767, Math.round(value * 32767))));
      this.sourcePosition += this.ratio;
    }
    this.sourcePosition -= input.length;
    while (this.pending.length >= 320) {
      const frame = new Int16Array(this.pending.splice(0, 320));
      let energy = 0;
      for (const sample of frame) {
        const normalized = sample / 32768;
        energy += normalized * normalized;
      }
      this.port.postMessage({ type: "rms", rms: Math.sqrt(energy / frame.length), durationMs: 20 });
      this.port.postMessage({ type: "pcm", pcm: frame.buffer }, [frame.buffer]);
    }
    return true;
  }
}

if (typeof globalThis.registerProcessor === "function") {
  globalThis.registerProcessor("magicbox-pcm-playback", MagicBoxPcmPlaybackProcessor);
  globalThis.registerProcessor("magicbox-mic-capture", MagicBoxMicCaptureProcessor);
}
