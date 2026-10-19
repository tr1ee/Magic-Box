/** Provider boundary for local conversational TTS.
 *
 * The runtime currently ships one production provider (pinned CosyVoice3).
 * Keeping the selection contract explicit makes a later Qwen3-TTS A/B test
 * compare the same prompt, fixtures, device, and playback metrics instead of
 * scattering provider-specific conditionals through the WebSocket service.
 */

export const TTS_PROVIDER_IDS = Object.freeze({
  COSYVOICE3: "cosyvoice3-stream-local",
  QWEN3: "qwen3-tts-stream-local"
});

import { createCosyVoice3Provider } from "./cosyvoice3-provider.mjs";
import { Qwen3TtsProvider } from "./qwen3tts-provider.mjs";

const providers = new Map([
  [TTS_PROVIDER_IDS.COSYVOICE3, Object.freeze({
    id: TTS_PROVIDER_IDS.COSYVOICE3,
    engine: "cosyvoice3",
    status: "ready",
    supportsPersistentText: true,
    supportsCancellation: true,
    supportsLanguages: ["zh", "en", "ja", "ko", "de", "es", "fr", "it", "ru"]
  })],
  [TTS_PROVIDER_IDS.QWEN3, Object.freeze({
    id: TTS_PROVIDER_IDS.QWEN3,
    engine: "qwen3-tts",
    status: "ready",
    supportsPersistentText: true,
    supportsCancellation: true,
    supportsLanguages: ["zh", "en", "ja", "ko", "de", "es", "fr", "it", "ru", "pt"]
  })]
]);

export function getTtsProvider(providerId = TTS_PROVIDER_IDS.COSYVOICE3) {
  return providers.get(String(providerId || "")) || providers.get(TTS_PROVIDER_IDS.COSYVOICE3);
}

export function listTtsProviders() {
  return [...providers.values()].map((provider) => ({ ...provider, supportsLanguages: [...provider.supportsLanguages] }));
}

export function createTtsProvider(providerId = TTS_PROVIDER_IDS.COSYVOICE3, options = {}) {
  return String(providerId) === TTS_PROVIDER_IDS.QWEN3
    ? new Qwen3TtsProvider(options)
    : createCosyVoice3Provider(options);
}
