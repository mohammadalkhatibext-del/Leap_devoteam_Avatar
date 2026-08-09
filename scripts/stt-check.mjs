/**
 * Check Arabic STT against the fixture audio, whose text we already know.
 *
 *   node scripts/stt-check.mjs
 *
 * This is a better test than talking at a microphone: the fixtures are known Arabic,
 * rendered by a known voice, and `fixtures/phrases.ar.json` holds the exact text each
 * clip is supposed to contain. Phrase 02 is the one that decides whether the model
 * configuration is right — it embeds AWS, Azure and Kubernetes inside an Arabic
 * sentence, and a monolingual model turns those into phonetic nonsense.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.loadEnvFile(path.join(ROOT, ".env"));

const { transcribe } = await import("../server/deepgram.mjs");

const VOICE = process.argv[2] || "ar-SA-HamedNeural@24k";
const IDS = ["01", "02", "03", "07"]; // greeting, code-switch, numbers, emphatics

const phrases = JSON.parse(
  await readFile(path.join(ROOT, "fixtures", "phrases.ar.json"), "utf8"),
).phrases;

console.log(`\nSTT check — fixtures/audio/edge/${VOICE}`);
console.log(`model=${process.env.DEEPGRAM_MODEL || "nova-3"} language=${process.env.DEEPGRAM_LANGUAGE || "multi"}\n`);

for (const id of IDS) {
  const p = phrases.find((x) => x.id === id);
  const file = path.join(ROOT, "fixtures", "audio", "edge", VOICE, `${id}.wav`);

  let audio;
  try {
    audio = await readFile(file);
  } catch {
    console.log(`  ${id}  SKIP — ${path.relative(ROOT, file)} not found\n`);
    continue;
  }

  try {
    const r = await transcribe(audio, { contentType: "audio/wav" });
    console.log(`  ${id}  ${p.tests}`);
    console.log(`      said:  ${p.ar}`);
    console.log(`      heard: ${r.transcript || "(nothing)"}`);
    console.log(`      confidence ${r.confidence.toFixed(2)}  ${r.ms}ms\n`);
  } catch (err) {
    console.log(`  ${id}  FAILED — ${err.message}\n`);
  }
}

console.log("Judge 02 yourself: the Latin-script tech terms must survive as Latin script.\n");
