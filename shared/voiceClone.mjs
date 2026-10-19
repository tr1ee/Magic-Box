export const voiceLanguages = [
  { id: "auto", label: "Auto" },
  { id: "zh", label: "Chinese" },
  { id: "en", label: "English" },
  { id: "ja", label: "Japanese" }
];

export const openVoiceEngineId = "openvoice-v2-local";
export const gptSoVitsEngineId = "gpt-sovits-local";
export const seedVcEngineId = "seed-vc-svc-local";
export const vtvSeedEngineId = "seed-vc-svc-v1";
export const vtvRvcEngineId = "rvc-v2-finetuned";
export const vtvYingMusicEngineId = "yingmusic-svc-zero-shot-v1";
export const vtvSongEngineIds = Object.freeze([vtvSeedEngineId, vtvRvcEngineId, vtvYingMusicEngineId]);
export const voicePreparationEngineId = "voice-preparation-local";
export const cosyVoiceStreamingEngineId = "cosyvoice3-stream-local";
export const whisperTurboStreamingEngineId = "whisper-turbo-stream-local";

export const streamingVoiceLanguages = [
  { id: "zh", label: "Chinese" },
  { id: "en", label: "English" },
  { id: "ja", label: "Japanese" },
  { id: "ko", label: "Korean" },
  { id: "de", label: "German" },
  { id: "es", label: "Spanish" },
  { id: "fr", label: "French" },
  { id: "it", label: "Italian" },
  { id: "ru", label: "Russian" }
];

export const voiceEngines = [
  { id: openVoiceEngineId, label: "OpenVoice V2" },
  { id: gptSoVitsEngineId, label: "GPT-SoVITS" }
];

export const voiceStyles = [
  "neutral",
  "calm",
  "excited",
  "happy",
  "sad",
  "angry",
  "whisper",
  "serious"
];

const styleAliasPairs = [
  ["neutral", "neutral"],
  ["calm", "calm"],
  ["excited", "excited"],
  ["happy", "happy"],
  ["sad", "sad"],
  ["angry", "angry"],
  ["whisper", "whisper"],
  ["serious", "serious"],
  ["\u5e73\u9759", "calm"],
  ["\u5e73\u9759\u7684", "calm"],
  ["\u51b7\u9759", "calm"],
  ["\u6fc0\u52a8", "excited"],
  ["\u6fc0\u52a8\u7684", "excited"],
  ["\u5174\u594b", "excited"],
  ["\u5f00\u5fc3", "happy"],
  ["\u5f00\u5fc3\u7684", "happy"],
  ["\u5feb\u4e50", "happy"],
  ["\u60b2\u4f24", "sad"],
  ["\u60b2\u4f24\u7684", "sad"],
  ["\u96be\u8fc7", "sad"],
  ["\u6124\u6012", "angry"],
  ["\u6124\u6012\u7684", "angry"],
  ["\u751f\u6c14", "angry"],
  ["\u4f4e\u58f0", "whisper"],
  ["\u4f4e\u58f0\u7684", "whisper"],
  ["\u8033\u8bed", "whisper"],
  ["\u4e25\u8083", "serious"],
  ["\u4e25\u8083\u7684", "serious"],
  ["\u843d\u3061\u7740\u3044\u305f", "calm"],
  ["\u5b09\u3057\u3044", "happy"],
  ["\u8208\u596e\u3057\u305f", "excited"],
  ["\u60b2\u3057\u3044", "sad"],
  ["\u6012\u3063\u305f", "angry"]
];

export const voiceStyleAliases = Object.fromEntries(styleAliasPairs);

export function normalizeVoiceLanguage(value, { allowAuto = true } = {}) {
  const normalized = String(value || "").trim().toLowerCase();
  const allowed = allowAuto ? ["auto", "zh", "en", "ja"] : ["zh", "en", "ja"];
  return allowed.includes(normalized) ? normalized : (allowAuto ? "auto" : "en");
}

export function defaultVoiceEngineForLanguage(value) {
  const language = normalizeVoiceLanguage(value, { allowAuto: false });
  return language === "zh" || language === "ja" ? gptSoVitsEngineId : openVoiceEngineId;
}

export function normalizeVoiceEngine(value, { language = "en" } = {}) {
  const engine = String(value || "").trim().toLowerCase();
  if (engine === openVoiceEngineId || engine === gptSoVitsEngineId) {
    return engine;
  }
  return defaultVoiceEngineForLanguage(language);
}

export function voiceEngineSupportsV2v(value) {
  return normalizeVoiceEngine(value) === openVoiceEngineId;
}

export function normalizeV2vEngine(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === seedVcEngineId || normalized === vtvSeedEngineId) return normalized;
  if (vtvSongEngineIds.includes(normalized)) return normalized;
  return openVoiceEngineId;
}

export function normalizeVtvSongEngineId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === seedVcEngineId) return vtvSeedEngineId;
  if (vtvSongEngineIds.includes(normalized)) return normalized;
  throw new Error(`Unknown Song VTV engine: ${normalized || "empty"}.`);
}

export function normalizeVtvSongEngineSelection(settings = {}) {
  const raw = settings?.vtvEngineSelection && typeof settings.vtvEngineSelection === "object"
    ? settings.vtvEngineSelection
    : null;
  const requestedMode = String(raw?.mode || settings?.engineMode || "single").trim().toLowerCase();
  const mode = requestedMode === "compare" ? "compare" : "single";
  const rawIds = Array.isArray(raw?.engineIds)
    ? raw.engineIds
    : (Array.isArray(settings?.engineIds) ? settings.engineIds : [raw?.primaryEngineId || settings?.conversionEngine || vtvSeedEngineId]);
  const engineIds = [...new Set(rawIds.map(normalizeVtvSongEngineId))];
  const selected = engineIds.length ? engineIds : [vtvSeedEngineId];
  if (mode === "compare" && selected.length < 2) {
    throw new Error("Song VTV compare mode requires at least two selected engines.");
  }
  const primaryEngineId = normalizeVtvSongEngineId(raw?.primaryEngineId || selected[0]);
  return {
    mode,
    engineIds: mode === "compare" ? selected.slice(0, 3) : [primaryEngineId],
    primaryEngineId,
    allowFallback: raw?.allowFallback === true || settings?.allowFallback === true
  };
}

export function sanitizeUnicodeText(value) {
  const input = String(value ?? "");
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += input[index] + input[index + 1];
        index += 1;
      } else {
        output += "\ufffd";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      output += "\ufffd";
      continue;
    }
    output += input[index];
  }
  return output;
}

export function inferVoiceLanguageFromText(value) {
  const input = sanitizeUnicodeText(value);
  if (/[\u3040-\u30ff]/u.test(input)) {
    return "ja";
  }
  if (/[\u3400-\u9fff\uf900-\ufaff]/u.test(input)) {
    return "zh";
  }
  return "en";
}

export function resolveVoiceLanguage({ requestedLanguage, profileLanguage, text } = {}) {
  const requested = normalizeVoiceLanguage(requestedLanguage);
  if (requested !== "auto") {
    return requested;
  }
  if (String(text || "").trim()) {
    return inferVoiceLanguageFromText(text);
  }
  const profile = normalizeVoiceLanguage(profileLanguage);
  if (profile !== "auto") {
    return profile;
  }
  return inferVoiceLanguageFromText(text);
}

export function normalizeVoiceStyle(value) {
  const key = String(value || "").trim().toLowerCase();
  return voiceStyleAliases[key] || voiceStyleAliases[String(value || "").trim()] || null;
}

export function parseEmotionSegments(text) {
  const input = sanitizeUnicodeText(text);
  const warnings = [];
  const segments = [];
  const tagPattern = /\(([^()\r\n]{1,48})\)/gu;
  let currentStyle = "neutral";
  let lastIndex = 0;
  let match;

  function pushSegment(rawText) {
    const cleanText = String(rawText || "").trim();
    if (!cleanText) {
      return;
    }
    segments.push({
      style: currentStyle,
      text: cleanText
    });
  }

  while ((match = tagPattern.exec(input)) !== null) {
    pushSegment(input.slice(lastIndex, match.index));
    const rawTag = match[1].trim();
    const normalized = normalizeVoiceStyle(rawTag);
    if (normalized) {
      currentStyle = normalized;
    } else {
      currentStyle = "neutral";
      warnings.push(`Unsupported style tag "${rawTag}" was treated as neutral.`);
    }
    lastIndex = tagPattern.lastIndex;
  }

  pushSegment(input.slice(lastIndex));

  return {
    segments,
    warnings
  };
}

export function splitVoiceSynthesisClauses(value) {
  const normalized = sanitizeUnicodeText(value).replace(/\r\n?/gu, "\n").trim();
  if (!normalized) {
    return [];
  }

  const rawParts = (normalized.match(/[^.!?;,\u3002\uff01\uff1f\uff1b\uff0c\n]+[.!?;,\u3002\uff01\uff1f\uff1b\uff0c]*|\n+/gu) || [])
    .map((part) => part.trim())
    .filter(Boolean);
  const parts = rawParts.length ? rawParts : [normalized];
  const unitCount = (part) => (String(part || "").match(/[\p{L}\p{N}]/gu) || []).length;
  const hasExpressiveRepetition = /([\p{L}\p{N}])\1{2,}/u.test(normalized);
  // Expressive chants need a little less minimum context than ordinary prose:
  // four CJK units already produce a stable utterance. Keep a repeated chant
  // as its own clause at a comma so GPT-SoVITS cannot finish the chant while
  // silently dropping the short prose that follows it.
  const minimumSafeUnits = hasExpressiveRepetition ? 4 : 6;
  const totalUnits = unitCount(normalized);
  const maximumSoftClauseUnits = hasExpressiveRepetition
    ? 18
    : (totalUnits > 48 ? 28 : Number.POSITIVE_INFINITY);
  const join = (left, right) => {
    const separator = left
      && right
      && /[A-Za-z0-9][.!?;]?$/u.test(left)
      && /^[A-Za-z0-9]/u.test(right)
      && !/\d+\.$/u.test(left)
      ? " "
      : "";
    return `${left || ""}${separator}${right || ""}`;
  };
  if (!hasExpressiveRepetition && totalUnits > 48) {
    const commaParts = normalized.split(/(?<=[,，])/u).filter(Boolean);
    if (commaParts.length > 1) {
      const targetUnits = Math.ceil(totalUnits / 2);
      const balanced = [];
      let current = "";
      for (const part of commaParts) {
        if (
          current
          && unitCount(current) >= minimumSafeUnits
          && balanced.length === 0
          && (
            unitCount(current) >= targetUnits
            || unitCount(current) + unitCount(part) > targetUnits
          )
        ) {
          balanced.push(current);
          current = part;
        } else {
          current = join(current, part);
        }
      }
      if (current) balanced.push(current);
      if (balanced.length > 1 && balanced.every((part) => unitCount(part) >= minimumSafeUnits)) {
        return balanced;
      }
    }
  }
  const sentences = [];
  let pending = "";
  for (const part of parts) {
    const endsWithSoftBoundary = /[,\uff0c]$/u.test(part);
    const isStandaloneExpressiveChant = endsWithSoftBoundary
      && unitCount(part) >= 4
      && /([\p{L}\p{N}])\1{2,}/u.test(part);
    if (isStandaloneExpressiveChant) {
      if (pending) {
        sentences.push(pending);
        pending = "";
      }
      sentences.push(part);
      continue;
    }
    if (unitCount(part) < 4 || endsWithSoftBoundary) {
      const candidate = join(pending, part);
      if (endsWithSoftBoundary && pending && unitCount(candidate) >= maximumSoftClauseUnits) {
        sentences.push(candidate);
        pending = "";
      } else {
        pending = candidate;
      }
      continue;
    }
    sentences.push(pending ? join(pending, part) : part);
    pending = "";
  }
  if (pending) {
    if (sentences.length) {
      sentences[sentences.length - 1] = join(sentences.at(-1), pending);
    } else {
      sentences.push(pending);
    }
  }

  const safeSentences = [];
  pending = "";
  for (const sentence of sentences) {
    const candidate = pending ? join(pending, sentence) : sentence;
    if (unitCount(candidate) < minimumSafeUnits) {
      pending = candidate;
      continue;
    }
    safeSentences.push(candidate);
    pending = "";
  }
  if (pending) {
    if (safeSentences.length) {
      safeSentences[safeSentences.length - 1] = join(safeSentences.at(-1), pending);
    } else {
      safeSentences.push(pending);
    }
  }
  return safeSentences.length ? safeSentences : sentences.length ? sentences : [normalized];
}

export function textPreview(value, maxLength = 120) {
  const compact = sanitizeUnicodeText(value).replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trim()}...`;
}
