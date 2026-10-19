import assert from "node:assert/strict";
import { VoiceReplySession } from "../server/live_voice.mjs";

const reply = new VoiceReplySession();
for (let turn = 0; turn < 300; turn += 1) {
  reply.reset();
  for (let sequence = 1; sequence <= 8; sequence += 1) {
    assert.equal(reply.append(sequence, 60, 1200), true);
    reply.acknowledge(60, 1200);
  }
  assert.equal(reply.unackedCommits, 0);
  assert.equal(reply.unackedTextChars, 0);
  assert.equal(reply.estimatedAudioAheadMs, 0);
}
console.log("Voice long-session logical stress passed (300 turns, no retained commit state).");
