import { coalesceSpeechSegments, splitSpeechSegments } from "./speech-planner.mjs";

// Reset the neural decoder at natural passage boundaries. A whole article in
// one persistent inference accumulates acoustic context and slows down heavily.
export function readingPassages(text) {
  return coalesceSpeechSegments(splitSpeechSegments(text), {
    minCjk: 48, maxCjk: 88, minWords: 28, maxWords: 48
  }).map(({ text }) => text);
}
