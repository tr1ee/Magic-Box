import { StreamingTtsEngine } from "./interface.mjs";

export class CosyVoice3StreamingProvider extends StreamingTtsEngine {
  constructor(options = {}) {
    super({ ...options, id: "cosyvoice3-stream-local" });
  }
}

export function createCosyVoice3Provider(options = {}) {
  return new CosyVoice3StreamingProvider(options);
}
