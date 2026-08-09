/**
 * End-to-end check of the answer -> speech path, with no mic and no avatar.
 *
 *   node scripts/speak.mjs "ما هي ديفوتيم؟"
 *
 * Asks Claude, synthesises each sentence as it streams, and writes the spoken answer
 * to out/answer.wav. What it is really measuring is **time to first audio** — the gap
 * between a visitor finishing their question and the avatar's mouth starting to move.
 * That number, not the total, is what makes a booth feel alive or broken.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.loadEnvFile(path.join(ROOT, ".env"));

const { ask } = await import("../server/claude.mjs");
const { ensureTts, prewarmFillers, filler, SpeechQueue, toWav, SAMPLE_RATE, DEFAULT_VOICE } =
  await import("../server/tts.mjs");

const question = process.argv.slice(2).join(" ") || "ما هي ديفوتيم؟";

console.log(`\nvoice: ${DEFAULT_VOICE} @ ${SAMPLE_RATE} Hz`);
console.log(await ensureTts({ log: (m) => console.log(`  ${m}`) }));
console.log(`  prewarmed ${await prewarmFillers()} filler clips`);

const t0 = Date.now();
let firstAudioMs = null;
const clips = []; // answer sentences, kept in order by the queue's own index

// The booth speaks this the moment the question ends, while Claude is still working.
const ack = filler();
if (ack) {
  firstAudioMs = Date.now() - t0;
  console.log(`  [ack] ${(ack.pcm.length / 2 / SAMPLE_RATE).toFixed(1)}s  ${ack.text}`);
}

const queue = new SpeechQueue((pcm, { index, text }) => {
  firstAudioMs ??= Date.now() - t0;
  clips[index] = pcm;
  const secs = (pcm.length / 2 / SAMPLE_RATE).toFixed(1);
  console.log(`  [${index + 1}] ${secs}s  ${text}`);
});

console.log(`\nQ  ${question}\n`);

const result = await ask(question, { onSentence: (s) => queue.push(s) });
await queue.drain();

const pcm = Buffer.concat([ack?.pcm, ...clips].filter(Boolean));
const outDir = path.join(ROOT, "out");
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, "answer.wav");
await writeFile(outFile, toWav(pcm, SAMPLE_RATE));

const spokenSecs = pcm.length / 2 / SAMPLE_RATE;
console.log(`\n  wrote ${path.relative(ROOT, outFile)} — ${spokenSecs.toFixed(1)}s of speech`);
console.log(`  grounded: ${result.grounded ? `yes (${result.citations.length} citations)` : "NO CITATIONS"}`);
console.log(
  `\n  time to FIRST AUDIO: ${firstAudioMs}ms   ` +
    `(Claude first token ${result.timing.firstTokenMs}ms, full answer ${result.timing.totalMs}ms)`,
);
console.log(
  `  Without sentence streaming the mouth would not move until ${result.timing.totalMs}ms + a full TTS pass.\n`,
);
