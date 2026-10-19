import { naturalizeSpeechText } from "./speech-planner.mjs";

function firstSentence(text) {
  const match = String(text || "").match(/^(.{1,260}?[。！？.!?](?:\s|$))/u);
  return match?.[1]?.trim() || String(text || "").slice(0, 260).trim();
}

/** Deterministic display-to-speech projection; it never calls a model. */
export class SpokenTextRenderer {
  constructor({ mode = "spoken" } = {}) {
    this.mode = ["spoken", "full", "summary"].includes(mode) ? mode : "spoken";
  }

  render(input, { mode = this.mode, final = true } = {}) {
    const selected = ["spoken", "full", "summary"].includes(mode) ? mode : this.mode;
    const source = String(input || "");
    if (selected === "full") return source.replace(/\s+/gu, " ").trim();
    const spoken = naturalizeSpeechText(source, { final });
    return selected === "summary" ? firstSentence(spoken) : spoken;
  }

  renderDelta(delta, options = {}) {
    return this.render(delta, { ...options, final: false });
  }
}

export function renderSpokenText(input, options = {}) {
  return new SpokenTextRenderer(options).render(input, options);
}
