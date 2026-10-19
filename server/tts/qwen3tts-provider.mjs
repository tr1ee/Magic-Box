import { StreamingTtsEngine } from "./interface.mjs";

/**
 * Local Qwen 1.7B adapter. Installation and listening approval are checked
 * by the runtime selector before the worker is launched.
 */
export class Qwen3TtsProvider extends StreamingTtsEngine {
  constructor(options = {}) {
    super({ ...options, id: "qwen3-tts-stream-local" });
  }

  async health() {
    return { id: this.id, status: "ready", supportsPersistentText: true, supportsCancellation: true, codecMode: "complete-sentence", schedulerMode: "passage-prefetch" };
  }

}
