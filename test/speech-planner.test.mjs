import assert from "node:assert/strict";
import test from "node:test";
import { coalesceSpeechSegments, StreamingSpeechPlanner, StreamingTextCommitter, naturalizeSpeechText, punctuationPauseMs, splitSpeechSegments } from "../shared/speech-planner.mjs";
import { renderSpokenText } from "../shared/spoken-text-renderer.mjs";
import { readingPassages } from "../shared/reading-plan.mjs";

test("keeps long neural reading bounded without dropping any of the article", () => {
  const text = "把一篇长文章分成自然段落，可以控制推理上下文的长度，并完整保留需要朗读的内容。".repeat(100);
  const passages = readingPassages(text);
  assert.ok(passages.length > 30);
  assert.ok(passages.every((part) => [...part].length < 110));
  assert.equal(passages.join("").replaceAll(" ", ""), text);
});

test("preserves English paragraph punctuation and decimal numbers in speech", () => {
  assert.equal(naturalizeSpeechText("Hello world.\nNext paragraph."), "Hello world. Next paragraph.");
  assert.equal(naturalizeSpeechText("First heading\nSecond line"), "First heading. Second line");
  const parts = splitSpeechSegments("The measured value is 3.14 meters. Please keep the decimal intact.");
  assert.ok(parts.some((part) => part.text.includes("3.14")));
  assert.ok(!parts.some((part) => part.text.endsWith("3.")));
});

test("naturalizes Markdown, links, citations, tables, emoji, and code", () => {
  const spoken = naturalizeSpeechText(`# Result\n- Read [the guide](https://example.com/raw) [S1] ✅\n| Name | Value |\n| --- | --- |\n| alpha | 2 |\n\`camelCase_id\`\n\`\`\`js\nconsole.log('secret');\n\`\`\``);
  assert.match(spoken, /Result/u);
  assert.match(spoken, /Read the guide/u);
  assert.match(spoken, /Name，Value/u);
  assert.match(spoken, /camel Case id/u);
  assert.match(spoken, /Code is shown on screen/u);
  assert.doesNotMatch(spoken, /https?:|\[S1\]|console\.log|```|✅/u);
});

test("commits short strong sentences without waiting for a long threshold", () => {
  const planner = new StreamingSpeechPlanner();
  assert.deepEqual(planner.append("Hello."), [{ sequence: 1, text: "Hello.", boundary: "strong" }]);
  assert.deepEqual(planner.finish(), []);
});

test("bounds punctuation-free Chinese and Latin replies", () => {
  const chinese = splitSpeechSegments("这是一个没有任何标点但是需要被稳定切分并且快速开始播放的中文回答它不应该等待整段结束", { final: true });
  assert.ok(chinese.length >= 2);
  assert.ok([...chinese[0].text].length <= 32);
  const english = splitSpeechSegments("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty", { final: true });
  assert.ok(english.length >= 2);
  assert.ok(english[0].text.split(/\s+/u).length <= 16);
});

test("idle flush commits a useful partial clause and final tails stay nonempty", () => {
  const planner = new StreamingSpeechPlanner();
  assert.deepEqual(planner.append("A useful partial clause"), []);
  assert.deepEqual(planner.flushIdle(), [{ sequence: 1, text: "A useful partial clause", boundary: "forced" }]);
  planner.append(" and a tail");
  const final = planner.finish();
  assert.equal(final.length, 1);
  assert.match(final[0].text, /and a tail/u);
  assert.equal(final[0].boundary, "final");
});

test("does not split surrogate pairs or emit punctuation-only segments", () => {
  const planner = new StreamingSpeechPlanner();
  planner.append("🙂🙂，");
  assert.deepEqual(planner.flushIdle(), []);
  const segments = planner.append("混合 Unicode 文本能够保持完整。下一句也完整。\ud83d");
  planner.append("\ude00");
  const all = [...segments, ...planner.finish()];
  assert.ok(all.every((segment) => !/[\uD800-\uDBFF]$/u.test(segment.text)));
  assert.ok(all.every((segment) => /[\p{Letter}\p{Number}]/u.test(segment.text)));
});

test("coalesces short completed sentences into natural synthesis phrases", () => {
  const segments = splitSpeechSegments("第一句很短。第二句也很短。第三句继续说明。第四句完成这段自然朗读。", { final: true });
  const coalesced = coalesceSpeechSegments(segments, { minCjk: 18, minWords: 10, maxCjk: 60, maxWords: 30 });
  assert.ok(coalesced.length < segments.length);
  assert.equal(coalesced.map((segment) => segment.text).join("" ).replaceAll(" ", ""), segments.map((segment) => segment.text).join(""));
});

test("uses only subtle joins because synthesized punctuation already carries prosody", () => {
  assert.equal(punctuationPauseMs("strong"), 35);
  assert.equal(punctuationPauseMs("weak"), 15);
  assert.equal(punctuationPauseMs("forced"), 0);
});

test("StreamingTextCommitter leaves lookahead and protects URLs while spoken renderer separates display text", () => {
  const committer = new StreamingTextCommitter({ firstMinCjk: 4, firstMaxCjk: 12, minCjk: 6, maxCjk: 18, lookaheadChars: 3 });
  const first = committer.append("我检查了文件，接下来会打开 https://example.com/path");
  assert.ok(first.length >= 1);
  assert.ok(first.every((item) => !item.text.includes("https://")));
  const rest = committer.finish();
  assert.ok([...first, ...rest].length >= 2);
  assert.match(renderSpokenText("## 结果\n- 已处理 `D:\\Images\\a.webp`\n- [详情](https://example.com)"), /结果/);
  assert.doesNotMatch(renderSpokenText("[详情](https://example.com)"), /https:\/\//u);
});

test("StreamingTextCommitter adapts commit pressure to the playback lead", () => {
  const committer = new StreamingTextCommitter({ adaptive: true, firstMinCjk: 6, firstMaxCjk: 12, minCjk: 8, maxCjk: 18, lookaheadChars: 3 });
  committer.setAdaptive(true);
  committer.setAudioAheadMs(120);
  const pressured = committer.append("这是一个需要尽快开始的连续语音句子，但是仍然要保持自然边界。");
  assert.ok(pressured.length >= 1);
  committer.reset();
  committer.setAudioAheadMs(900);
  committer.setTokenGapMs(80);
  assert.doesNotThrow(() => committer.append("这是一个有足够音频余量时可以稍微等待的连续语音句子。").concat(committer.finish()));
});
