const STRONG_PUNCTUATION = /[.!?。！？]/u;
const WEAK_PUNCTUATION = /[,;:，；：、]/u;
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_WORD = /[\p{Script=Latin}\p{Number}]+(?:['’][\p{Script=Latin}\p{Number}]+)*/gu;
const USEFUL_CONTENT = /[\p{Letter}\p{Number}]/u;

function spokenIdentifier(value) {
  return String(value || "")
    .replace(/([\p{Ll}\p{Number}])([\p{Lu}])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function codeCue(text) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)
    ? "代码已显示在屏幕上。"
    : "Code is shown on screen.";
}

function naturalizeLine(line) {
  let value = String(line || "").trim();
  if (!value) return "";
  if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(value)) return "";
  value = value
    .replace(/^\s{0,3}#{1,6}\s*/u, "")
    .replace(/^\s*>+\s?/u, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+/u, "")
    .replace(/^\s*\[[ xX]\]\s+/u, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^)]+\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<https?:\/\/[^>]+>/gu, " ")
    .replace(/(?:https?:\/\/|www\.)\S+/giu, " ")
    .replace(/\[(?:S|source)\s*\d+\]/giu, " ")
    .replace(/【\s*\d+\s*†[^】]*】/gu, " ")
    .replace(/\[\^\d+\]/gu, " ")
    .replace(/`([^`\n]+)`/gu, (_match, identifier) => spokenIdentifier(identifier))
    .replace(/[*_~]+/gu, " ")
    .replace(/^\s*\|/u, "")
    .replace(/\|\s*$/u, "")
    .replace(/\s*\|\s*/gu, "，")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]+/gu, " ")
    .replace(/([!?！？。,.，])\1+/gu, "$1")
    .replace(/\.{3,}/gu, "。")
    .replace(/\s+([,.;:!?，。；：！？])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
  return USEFUL_CONTENT.test(value) ? value : "";
}

export function naturalizeSpeechText(input, { final = true } = {}) {
  let text = String(input || "").replace(/\r\n?/gu, "\n").replace(/\u0000/gu, "");
  const hadCode = /```|~~~/u.test(text);
  text = text.replace(/(?:```|~~~)[^\n]*\n[\s\S]*?(?:(?:```|~~~)|$)/gu, (block) => codeCue(block));
  if (final && hadCode && !/Code is shown on screen|代码已显示在屏幕上/u.test(text)) text += `\n${codeCue(input)}`;
  const lines = text.split("\n");
  const phrases = [];
  for (const line of lines) {
    const phrase = naturalizeLine(line);
    if (phrase) phrases.push(phrase);
  }
  return phrases.map((phrase, index) => index === phrases.length - 1 || /[。！？.!?;；:：]$/u.test(phrase) ? phrase : `${phrase}${CJK_CHARACTER.test(phrase) ? "。" : "."}`).join(" ")
    .replace(/([。！？.!?])。/gu, "$1")
    .replace(/。\s*([。！？!?])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function speechMetrics(value) {
  const text = String(value || "");
  let cjk = 0;
  for (const character of text) if (CJK_CHARACTER.test(character)) cjk += 1;
  return { cjk, latinWords: text.match(LATIN_WORD)?.length || 0 };
}

function reaches(metrics, cjk, latinWords) {
  return metrics.cjk >= cjk || metrics.latinWords >= latinWords;
}

function cleanSegment(value) {
  const text = String(value || "").replace(/^\s+/u, "").replace(/\s+$/u, "");
  return USEFUL_CONTENT.test(text) ? text : "";
}

function boundaryFor(character, forced = false, final = false) {
  if (final) return "final";
  if (forced) return "forced";
  return WEAK_PUNCTUATION.test(character) ? "weak" : "strong";
}

function findBoundary(text, { first, idle, final }) {
  const limits = first
    ? { minCjk: 20, maxCjk: 32, minWords: 8, maxWords: 16 }
    : { minCjk: 36, maxCjk: 72, minWords: 16, maxWords: 36 };
  let weakBoundary = -1;
  let safeBoundary = -1;
  let hardBoundary = -1;
  let cursor = 0;
  for (const character of text) {
    cursor += character.length;
    const prefix = text.slice(0, cursor);
    const metrics = speechMetrics(prefix);
    const decimalPoint = character === "." && /\d/u.test(text[cursor - 2] || "") && /\d/u.test(text[cursor] || "");
    if (STRONG_PUNCTUATION.test(character) && !decimalPoint) {
      if (first || reaches(metrics, limits.minCjk, limits.minWords)) return { index: cursor, boundary: boundaryFor(character) };
      safeBoundary = cursor;
    }
    if (WEAK_PUNCTUATION.test(character) && reaches(metrics, limits.minCjk, limits.minWords)) weakBoundary = cursor;
    if (/\s/u.test(character) && reaches(metrics, limits.minCjk, limits.minWords)) safeBoundary = cursor;
    if (reaches(metrics, limits.maxCjk, limits.maxWords)) {
      hardBoundary = cursor;
      break;
    }
  }
  if (weakBoundary > 0 && (hardBoundary > 0 || idle || final)) return { index: weakBoundary, boundary: "weak" };
  if (hardBoundary > 0) return { index: safeBoundary > 0 ? safeBoundary : hardBoundary, boundary: "forced" };
  if ((idle || final) && USEFUL_CONTENT.test(text)) return { index: text.length, boundary: boundaryFor(text.at(-1), idle && !final, final) };
  return null;
}

export function coalesceSpeechSegments(segments, { minCjk = 36, minWords = 18, maxCjk = 88, maxWords = 44 } = {}) {
  const output = [];
  let current = null;
  const flush = () => {
    if (!current?.text) return;
    output.push(current);
    current = null;
  };
  for (const segment of segments || []) {
    const text = cleanSegment(segment?.text);
    if (!text) continue;
    if (!current) {
      current = { ...segment, text };
    } else {
      const separator = /\s$/u.test(current.text) || /^[,.;:!?，。；：！？、]/u.test(text) ? "" : " ";
      const combined = `${current.text}${separator}${text}`;
      const combinedMetrics = speechMetrics(combined);
      if (reaches(combinedMetrics, maxCjk, maxWords)) {
        flush();
        current = { ...segment, text };
      } else {
        current = { ...segment, text: combined };
      }
    }
    const metrics = speechMetrics(current.text);
    if (reaches(metrics, minCjk, minWords) && ["strong", "final"].includes(current.boundary)) flush();
  }
  flush();
  return output;
}

export function splitSpeechSegments(input, { final = true, first = true } = {}) {
  let pending = naturalizeSpeechText(input, { final });
  const segments = [];
  let isFirst = first;
  while (pending) {
    const boundary = findBoundary(pending, { first: isFirst, idle: final, final });
    if (!boundary) break;
    const text = cleanSegment(pending.slice(0, boundary.index));
    pending = pending.slice(boundary.index).trimStart();
    if (!text) continue;
    segments.push({ text, boundary: pending ? boundary.boundary : final ? "final" : boundary.boundary });
    isFirst = false;
  }
  return segments;
}

export function punctuationPauseMs(boundary) {
  if (boundary === "final") return 40;
  if (boundary === "strong") return 35;
  if (boundary === "weak") return 15;
  return 0;
}

export class StreamingSpeechPlanner {
  constructor() {
    this.reset();
  }

  reset() {
    this.raw = "";
    this.committedNatural = "";
    this.sequence = 0;
    this.finished = false;
  }

  append(delta = "") {
    if (this.finished) return [];
    this.raw += String(delta || "");
    return this.#drain({ idle: false, final: false });
  }

  flushIdle() {
    if (this.finished) return [];
    return this.#drain({ idle: true, final: false });
  }

  finish() {
    if (this.finished) return [];
    const segments = this.#drain({ idle: true, final: true });
    this.finished = true;
    return segments;
  }

  #drain({ idle, final }) {
    const natural = naturalizeSpeechText(this.raw, { final });
    let pending;
    if (natural.startsWith(this.committedNatural)) pending = natural.slice(this.committedNatural.length).trimStart();
    else {
      const tail = this.committedNatural.slice(-48);
      const anchor = tail ? natural.lastIndexOf(tail) : -1;
      pending = anchor >= 0 ? natural.slice(anchor + tail.length).trimStart() : natural;
    }
    const output = [];
    let consumedLength = natural.length - pending.length;
    while (pending) {
      const found = findBoundary(pending, { first: this.sequence === 0, idle, final });
      if (!found) break;
      const text = cleanSegment(pending.slice(0, found.index));
      const remainder = pending.slice(found.index).trimStart();
      const removedWhitespace = pending.slice(found.index).length - remainder.length;
      consumedLength += found.index + removedWhitespace;
      pending = remainder;
      if (!text) continue;
      this.sequence += 1;
      output.push({ sequence: this.sequence, text, boundary: pending ? found.boundary : final ? "final" : found.boundary });
    }
    this.committedNatural = natural.slice(0, consumedLength);
    return output;
  }
}

function safeCommitBoundary(text, { first, idle, final, options }) {
  const metrics = speechMetrics(text);
  const min = first ? options.firstMinCjk : options.minCjk;
  const max = first ? options.firstMaxCjk : options.maxCjk;
  const lookahead = final ? 0 : options.lookaheadChars;
  let candidate = -1;
  let strongCandidate = false;
  let cursor = 0;
  for (const character of text) {
    cursor += character.length;
    const prefix = text.slice(0, cursor);
    const current = speechMetrics(prefix);
    const atBoundary = STRONG_PUNCTUATION.test(character) || WEAK_PUNCTUATION.test(character);
    const urlLike = /(?:https?:\/\/|www\.)\S*$/iu.test(prefix) || /[\w.-]+@[\w.-]+$/u.test(prefix);
    const numberLike = /(?:\d[\d.,:/-]*)$/u.test(prefix);
    const shortFirstSentence = first && STRONG_PUNCTUATION.test(character) && current.latinWords >= 3;
    if (atBoundary && (reaches(current, min, options.minWords) || shortFirstSentence) && !urlLike && !numberLike) {
      candidate = cursor;
      strongCandidate = STRONG_PUNCTUATION.test(character);
      if (STRONG_PUNCTUATION.test(character) || final) break;
    }
    if (idle && /\s/u.test(character) && reaches(current, min, options.minWords) && !urlLike && !numberLike) candidate = cursor;
    if (reaches(current, max, options.maxWords)) {
      if (candidate < 0) candidate = cursor;
      break;
    }
  }
  if (candidate < 0 && (idle || final) && USEFUL_CONTENT.test(text)) candidate = final ? text.length : Math.min(text.length, Math.max(min, max));
  if (candidate <= 0) return null;
  if (!final && !strongCandidate && text.length - candidate < lookahead && text.length > max + lookahead) {
    const adjusted = Math.max(1, candidate - (lookahead - (text.length - candidate)));
    candidate = adjusted;
  }
  return { index: candidate, boundary: final ? "final" : boundaryFor(text[candidate - 1], idle, false) };
}

/**
 * Commits stable spoken text for a persistent TTS session. It deliberately
 * leaves a lookahead tail and never cuts URLs, identifiers, or numbers.
 */
export class StreamingTextCommitter {
  constructor(options = {}) {
    this.options = {
      firstMinCjk: 12,
      firstMaxCjk: 24,
      minCjk: 16,
      maxCjk: 40,
      lookaheadChars: 8,
      minWords: 6,
      maxWords: 22,
      ...options
    };
    this.adaptive = Boolean(options.adaptive);
    this.textLeadController = Boolean(options.textLeadController);
    this.audioAheadMs = 0;
    this.tokenGapMs = 0;
    this.lastAppendAt = 0;
    this.reset();
  }

  reset() {
    this.raw = "";
    this.committedNatural = "";
    this.sequence = 0;
    this.finished = false;
    this.lastAppendAt = 0;
  }

  setAdaptive(enabled = true) {
    this.adaptive = Boolean(enabled);
    return this.adaptive;
  }

  setTextLeadController(enabled = true) {
    this.textLeadController = Boolean(enabled);
    return this.textLeadController;
  }

  setAudioAheadMs(value = 0) {
    this.audioAheadMs = Math.max(0, Number(value) || 0);
  }

  setTokenGapMs(value = 0) {
    this.tokenGapMs = Math.max(0, Number(value) || 0);
  }

  append(delta = "") {
    if (this.finished) return [];
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    this.tokenGapMs = this.lastAppendAt ? Math.max(0, now - this.lastAppendAt) : 0;
    this.lastAppendAt = now;
    this.raw += String(delta || "");
    return this.#drain({ idle: false, final: false });
  }

  flushIdle() {
    if (this.finished) return [];
    return this.#drain({ idle: true, final: false });
  }

  finish() {
    if (this.finished) return [];
    const output = this.#drain({ idle: true, final: true });
    this.finished = true;
    return output;
  }

  #drain({ idle, final }) {
    const natural = naturalizeSpeechText(this.raw, { final });
    const pending = natural.startsWith(this.committedNatural)
      ? natural.slice(this.committedNatural.length).trimStart()
      : natural;
    const output = [];
    let cursor = 0;
    while (pending) {
      const found = safeCommitBoundary(pending.slice(cursor), { first: this.sequence === 0, idle, final, options: this.#effectiveOptions() });
      if (!found) break;
      const text = cleanSegment(pending.slice(cursor, cursor + found.index));
      if (!text) break;
      this.sequence += 1;
      output.push({ sequence: this.sequence, text, boundary: final ? "final" : found.boundary });
      cursor += found.index;
      while (/\s/u.test(pending[cursor] || "")) cursor += 1;
      if (cursor >= pending.length) break;
    }
    if (cursor > 0) this.committedNatural = natural.slice(0, natural.length - (pending.length - cursor));
    return output;
  }

  #effectiveOptions() {
    const leadOptions = this.textLeadController
      ? {
        ...this.options,
        firstMinCjk: Math.max(this.options.firstMinCjk, 20),
        firstMaxCjk: Math.max(this.options.firstMaxCjk, 32),
        minCjk: Math.max(this.options.minCjk, 20),
        maxCjk: Math.max(this.options.maxCjk, 56),
        lookaheadChars: Math.max(this.options.lookaheadChars, 10),
        minWords: Math.max(this.options.minWords, 8),
        maxWords: Math.max(this.options.maxWords, 28)
      }
      : this.options;
    if (!this.adaptive) return leadOptions;
    // Keep a small audio lead when generation is flowing, but commit earlier
    // when the playback buffer or token stream is close to starvation.
    const pressured = this.audioAheadMs > 0 && (this.audioAheadMs < 220 || this.tokenGapMs > 300);
    const relaxed = this.audioAheadMs >= 480 && this.tokenGapMs > 0 && this.tokenGapMs < 180;
    const delta = pressured ? -4 : relaxed ? 4 : 0;
    return {
      ...leadOptions,
      firstMinCjk: Math.max(4, leadOptions.firstMinCjk + delta),
      firstMaxCjk: Math.max(8, leadOptions.firstMaxCjk + delta),
      minCjk: Math.max(6, leadOptions.minCjk + delta),
      maxCjk: Math.max(12, leadOptions.maxCjk + delta),
      lookaheadChars: pressured ? Math.max(2, leadOptions.lookaheadChars - 2) : leadOptions.lookaheadChars
    };
  }
}
