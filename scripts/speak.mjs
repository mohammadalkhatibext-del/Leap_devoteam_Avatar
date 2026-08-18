/**
 * End-to-end check of the answer -> speech path, with no mic and no avatar.
 *
 *   node scripts/speak.mjs "ما هي ديفوتيم؟"
 *
 * Asks Claude, synthesises each sentence as it streams, and writes the spoken answer
 * to out/answer.wav. What it is really measuring is **time to first audio** — the gap
 * between a visitor finishing their question and the avatar's mouth starting to move.
 * That number, not the total, is what makes a booth feel alive or broken.
 *
 * It runs on the booth's SAVED settings — the same engine, voice, model and answer
 * length a visitor would get — so the number it prints is the number the stand will
 * produce. Running it against a hard-coded default would measure a booth nobody has.
 * The two legs it cannot see are the microphone hang-up (a fixed 650 ms, see
 * booth/src/mic.js) and speech-to-text (~300 ms on a booth-length clip); add ~1 s to
 * what this prints for the figure a visitor actually experiences.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// This script's whole claim is that the number it prints is the number the stand will
// produce. An environment variable shadowing .env breaks that claim silently — it did,
// once, and this script cheerfully reported a model upgrade that was not in effect.
const { loadEnvAndReport } = await import("../server/env.mjs");
loadEnvAndReport(path.join(ROOT, ".env"));

const { ask } = await import("../server/claude.mjs");
const { prewarmEngine, SpeechQueue, toWav, SAMPLE_RATE } = await import(
  "../server/tts.mjs"
);
const { getSettings } = await import("../server/settings.mjs");
const { voiceFor, modelFor, TTS_ENGINES } = await import("../server/tts-engines.mjs");

const question = process.argv.slice(2).join(" ") || "ما هي ديفوتيم؟";

const settings = await getSettings();
const engine = settings.ttsEngine;
const language = /[؀-ۿ]/.test(question) ? "ar" : "en";
const voice = voiceFor(settings, engine, language);
const model = modelFor(settings, engine);

console.log(`\nmodel:  ${settings.answerModel}`);
console.log(`voice:  ${TTS_ENGINES[engine]?.label ?? engine} · ${voice} @ ${SAMPLE_RATE} Hz`);
if (model) console.log(`        ${model}`);

// Warm the connection first, exactly as the booth does at startup. Without this the
// first measurement includes DNS, TLS and the vendor's cold start — which is real, but
// it is a cost the booth has already paid before any visitor arrives, so counting it
// here would overstate what a visitor waits by up to two seconds.
await prewarmEngine({ [language]: voice }, engine, model);
console.log(`        connection warm\n`);

const t0 = Date.now();
let firstAudioMs = null;
const clips = []; // answer sentences, kept in order by the queue's own index

const queue = new SpeechQueue(
  (pcm, { index, text }) => {
    firstAudioMs ??= Date.now() - t0;
    clips[index] = pcm;
    const secs = (pcm.length / 2 / SAMPLE_RATE).toFixed(1);
    console.log(`  [${index + 1}] ${secs}s  ${text}`);
  },
  { engine, voice, language, model },
);

console.log(`Q  ${question}\n`);

const result = await ask(question, { onSentence: (s) => queue.push(s) });
await queue.drain();

const pcm = Buffer.concat(clips.filter(Boolean));
const outDir = path.join(ROOT, "out");
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, "answer.wav");
await writeFile(outFile, toWav(pcm, SAMPLE_RATE));

const spokenSecs = pcm.length / 2 / SAMPLE_RATE;
console.log(`\n  wrote ${path.relative(ROOT, outFile)} — ${spokenSecs.toFixed(1)}s of speech`);
console.log(`  grounded: ${result.grounded ? `yes (${result.citations.length} citations)` : "NO CITATIONS"}`);
console.log(
  `\n  time to FIRST AUDIO: ${firstAudioMs}ms` +
    `   (first token ${result.timing.firstTokenMs}ms, first sentence ${result.timing.firstSentenceMs}ms,` +
    ` full answer ${result.timing.totalMs}ms)`,
);
console.log(`  add ~1s for the mic hang-up and speech-to-text a visitor also waits through.\n`);
