import fs from "node:fs/promises";
import path from "node:path";

// Keep exact converted clause files for ASR. Whole-utterance conversion can
// change pauses, so proportional cuts are not reliable sentence boundaries.
export async function convertTtsRecoveryClauses({
  sourcePaths, texts, outputDir, seed, pauseMs = 0, signal,
  convert, durationOf, concatenate
}) {
  if (!Array.isArray(sourcePaths) || sourcePaths.length < 2 || sourcePaths.length > 80
    || !Array.isArray(texts) || texts.length !== sourcePaths.length
    || texts.some(text => !String(text || "").trim())) {
    throw new Error("Clause recovery requires matching non-empty source clauses and texts.");
  }
  await fs.mkdir(outputDir, { recursive: true });
  const clausePaths = [];
  const clauses = [];
  for (let index = 0; index < sourcePaths.length; index++) {
    signal?.throwIfAborted();
    const sourceDurationSeconds = durationOf(await fs.readFile(sourcePaths[index]));
    const clauseSeed = seed + index * 997;
    const converted = await convert({ sourceAudioPath: sourcePaths[index], sourceDurationSeconds, seed: clauseSeed, index });
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(converted?.buffer) || !converted.buffer.length) throw new Error(`Clause ${index + 1} returned no converted audio.`);
    const durationSeconds = durationOf(converted.buffer);
    if (!(durationSeconds > 0)) throw new Error(`Clause ${index + 1} returned empty audio.`);
    const clausePath = path.join(outputDir, `clause-${index + 1}.wav`);
    await fs.writeFile(clausePath, converted.buffer);
    clausePaths.push(clausePath);
    clauses.push({ index: index + 1, seed: clauseSeed, sourceDurationSeconds, durationSeconds });
  }
  signal?.throwIfAborted();
  const joinedPath = path.join(outputDir, "joined.wav");
  await concatenate(clausePaths, joinedPath, signal, pauseMs);
  signal?.throwIfAborted();
  return { buffer: await fs.readFile(joinedPath), clausePaths, clauses, conversionStrategy: "exact-clause-recovery" };
}
