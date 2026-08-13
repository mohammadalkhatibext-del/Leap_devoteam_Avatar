/**
 * Bilingual speech-to-text via Deepgram.
 *
 * Push-to-talk against the prerecorded endpoint rather than a streaming socket, and
 * that is a deliberate trade. A booth visitor speaks one question and stops; there is
 * no long-running dictation to stream, so streaming would buy partial transcripts we
 * would only throw away — while costing a WebSocket relay, reconnect handling, and
 * endpointing logic. The browser detects the end of speech and posts one clip. The
 * cost is ~300 ms on a short utterance, which sits underneath the filler clip the
 * avatar is already speaking, so the visitor never perceives it.
 *
 * The key stays here. It is never sent to the browser — same rule as the Anam token.
 */

import { VOCABULARY } from "./vocabulary.mjs";

const ENDPOINT = "https://api.deepgram.com/v1/listen";

/**
 * Two single-language configs, run together — measured, not assumed
 * (`node scripts/stt-check.mjs`, and the language matrix behind it):
 *
 *              Arabic clip     English clip
 *   nova-3 ar     1.00            silent
 *   nova-2 en     silent          1.00
 *
 * Each model is confident on its own language and returns *nothing* on the other,
 * which is what makes "run both, take the higher confidence" a reliable language
 * detector rather than a guess.
 *
 * Do not replace this with one clever call. `detect_language=true` labels the Arabic
 * clip **Turkish** and transcribes nothing; `language=multi` does not cover Arabic at
 * all and returns Devanagari at 0.53. Both were tried. The two-call version costs a
 * fraction of a cent and is the only configuration that actually works.
 */
const CONFIGS = [
  { language: "ar", model: process.env.DEEPGRAM_MODEL_AR || "nova-3" },
  { language: "en", model: process.env.DEEPGRAM_MODEL_EN || "nova-2" },
];

async function once(audio, contentType, { model, language }, key) {
  const params = new URLSearchParams({
    model,
    language,
    smart_format: "true", // punctuation — Claude reads a punctuated question better
    punctuate: "true",
  });

  // Keyterm prompting is nova-3 only; nova-2 rejects the parameter rather than
  // ignoring it, which would fail the English half of every question.
  //
  // Measured weaker here than the same list is on the OpenAI path: it left
  // "ديفوتين" uncorrected on the fixture that fails. Kept because it is the
  // documented mechanism, it costs nothing on a request already being made, and it
  // did no harm — but if a booth is being tuned for hearing, OpenAI is the engine
  // carrying the win. See server/vocabulary.mjs.
  if (model.startsWith("nova-3")) for (const term of VOCABULARY) params.append("keyterm", term);

  const res = await fetch(`${ENDPOINT}?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": contentType },
    body: audio,
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Deepgram ${res.status} (${language}): ${body.err_msg || JSON.stringify(body).slice(0, 200)}`);
  }

  const alt = body.results?.channels?.[0]?.alternatives?.[0];
  return {
    language,
    transcript: (alt?.transcript ?? "").trim(),
    confidence: alt?.confidence ?? 0,
  };
}

/**
 * Transcribe one utterance and report which language it was spoken in.
 *
 * @param {Buffer|Uint8Array} audio     Encoded audio (webm/opus, wav, mp3 — Deepgram sniffs it)
 * @param {object}  [opts]
 * @param {string}  [opts.contentType]  MIME type of `audio`
 * @returns {Promise<{transcript: string, confidence: number, language: "ar"|"en"|null, ms: number}>}
 */
export async function transcribe(audio, { contentType = "audio/wav" } = {}) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY not set in .env");

  const startedAt = Date.now();

  // In parallel: two requests take the wall time of one.
  const settled = await Promise.allSettled(
    CONFIGS.map((cfg) => once(audio, contentType, cfg, key)),
  );

  const heard = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  if (!heard.length) throw new Error(settled[0].reason?.message ?? "Deepgram failed");

  // Empty transcripts score 0, so the language that actually heard something wins.
  const best = heard.reduce((a, b) => (b.confidence > a.confidence ? b : a));

  return {
    transcript: best.transcript,
    confidence: best.confidence,
    language: best.transcript ? best.language : null,
    ms: Date.now() - startedAt,
    // Useful when a transcript looks wrong: shows what the other language heard.
    considered: heard.map((h) => ({ language: h.language, confidence: h.confidence })),
  };
}
