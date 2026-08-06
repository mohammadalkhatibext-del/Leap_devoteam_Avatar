#!/usr/bin/env node
/**
 * Phase 0 — render the Arabic fixture phrases once per TTS candidate.
 *
 * The point: generate the audio ONCE, then feed the identical files to every
 * avatar renderer. Same audio in = a controlled comparison of lip-sync alone.
 *
 *   node scripts/render-tts.mjs azure
 *   node scripts/render-tts.mjs azure --voice ar-SA-ZariyahNeural
 *   node scripts/render-tts.mjs elevenlabs
 *   node scripts/render-tts.mjs azure --rate 16000     # only if Anam rejects 24k
 *
 * Output: fixtures/audio/<provider>/<voice>/<id>.wav  (16-bit mono PCM)
 *
 * Default 24 kHz: HeyGen LiveAvatar LITE requires exactly PCM 16-bit 24 kHz, and
 * Anam's stream takes the rate as a parameter ("should match TTS provider output").
 * So 24 kHz feeds both from ONE render — which keeps the comparison honest, since
 * every renderer hears byte-identical audio. Only re-render at 16000 if Anam turns
 * out to reject 24k; resampling in the browser would add our own artifacts to a
 * test that is specifically about audio quality.
 *
 * Requires Node 18+ (native fetch). No dependencies.
 */

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Node 20.6+ reads .env natively. Absent file is fine — env vars may come from the shell.
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

/* ------------------------------------------------------------------ config */

const argv = process.argv.slice(2);
const provider = argv[0];
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (!provider || !["azure", "elevenlabs"].includes(provider)) {
  console.error("Usage: node scripts/render-tts.mjs <azure|elevenlabs> [--voice <id>] [--rate 24000|16000]");
  process.exit(1);
}

const SAMPLE_RATE = Number(flag("rate", 24000));
if (![16000, 24000].includes(SAMPLE_RATE)) {
  console.error("--rate must be 16000 or 24000 (the two rates the renderers accept).");
  process.exit(1);
}

/* --------------------------------------------------------------- providers */

const providers = {
  /**
   * Azure Speech REST API. The F0 free tier covers 0.5M characters/month —
   * these 12 phrases are ~900 characters, so this is free and stays free.
   * riff-24khz-16bit-mono-pcm returns a complete WAV (header included).
   */
  azure: {
    defaultVoice: "ar-SA-HamedNeural",
    env: ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"],
    async synth(text, voice) {
      const key = process.env.AZURE_SPEECH_KEY;
      const region = process.env.AZURE_SPEECH_REGION;
      // Escape for XML — Arabic text is fine, but a stray & or < breaks SSML.
      const escaped = text.replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c],
      );
      const ssml =
        `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ar-SA">` +
        `<voice name="${voice}">${escaped}</voice></speak>`;

      const res = await fetch(
        `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
        {
          method: "POST",
          headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": `riff-${SAMPLE_RATE / 1000}khz-16bit-mono-pcm`,
            "User-Agent": "devoteam-leap-phase0",
          },
          body: ssml,
        },
      );
      if (!res.ok) throw new Error(`Azure ${res.status}: ${await res.text()}`);
      return { bytes: Buffer.from(await res.arrayBuffer()), isWav: true };
    },
  },

  /**
   * ElevenLabs TTS. pcm_24000 returns RAW PCM with no header, so we wrap it.
   * eleven_multilingual_v2 is the quality tier; eleven_flash_v2_5 is the
   * low-latency tier you'd actually ship. Render both if you have credits —
   * they sound different, and the shipped one is what matters.
   */
  elevenlabs: {
    defaultVoice: process.env.ELEVENLABS_VOICE_ID || "",
    env: ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"],
    async synth(text, voice) {
      const modelId = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=pcm_${SAMPLE_RATE}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": process.env.ELEVENLABS_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text, model_id: modelId }),
        },
      );
      if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
      return { bytes: Buffer.from(await res.arrayBuffer()), isWav: false };
    },
  },
};

/* -------------------------------------------------------------- wav header */

/** Wrap raw 16-bit mono PCM in a minimal RIFF/WAVE header. */
function wrapPcmAsWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2; // mono, 16-bit
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // channels = 1
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/* ------------------------------------------------------------------- main */

const cfg = providers[provider];
const voice = flag("voice", cfg.defaultVoice);

const missing = cfg.env.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing env: ${missing.join(", ")}\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}
if (!voice) {
  console.error(`No voice specified. Pass --voice <id>.`);
  process.exit(1);
}

const { phrases } = JSON.parse(
  await readFile(path.join(ROOT, "fixtures", "phrases.ar.json"), "utf8"),
);

// Rate is in the folder name so a 16k re-render never silently overwrites the 24k set.
const slug = `${voice}@${SAMPLE_RATE / 1000}k`;
const outDir = path.join(ROOT, "fixtures", "audio", provider, slug);
await mkdir(outDir, { recursive: true });

console.log(`\n${provider} / ${voice} @ ${SAMPLE_RATE} Hz → fixtures/audio/${provider}/${slug}/\n`);

let chars = 0;
for (const p of phrases) {
  process.stdout.write(`  ${p.id}  ${p.tests.slice(0, 52).padEnd(54)}`);
  try {
    const { bytes, isWav } = await cfg.synth(p.ar, voice);
    const wav = isWav ? bytes : wrapPcmAsWav(bytes);
    await writeFile(path.join(outDir, `${p.id}.wav`), wav);
    chars += p.ar.length;
    console.log(`ok  ${(wav.length / 1024).toFixed(0)} KB`);
  } catch (err) {
    console.log(`FAIL`);
    console.error(`       ${err.message}\n`);
  }
}

// Keep the manifest beside the audio so the scoring session knows what it's hearing.
await writeFile(
  path.join(outDir, "manifest.json"),
  JSON.stringify({ provider, voice, sampleRate: SAMPLE_RATE, renderedAt: new Date().toISOString(), phrases }, null, 2),
);

console.log(`\n${chars} characters billed. Azure F0 allows 500,000/month.\n`);
