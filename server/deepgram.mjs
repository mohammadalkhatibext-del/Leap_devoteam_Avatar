/**
 * Arabic speech-to-text via Deepgram.
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

const ENDPOINT = "https://api.deepgram.com/v1/listen";

/**
 * `nova-3` + `ar`, measured against the fixture clips (`node scripts/stt-check.mjs`).
 *
 * Do not switch this to `language=multi` on the theory that multilingual handles the
 * Arabic-plus-English code-switching in visitor questions. It does not cover Arabic at
 * all: the same clip comes back as Devanagari and romanised nonsense at 0.5 confidence,
 * where `ar` returns the sentence at 1.00. `nova-2` and `base` reject Arabic outright.
 *
 * Known limitation, accepted: Latin-script tech terms come back transliterated into
 * Arabic script — "AWS" as "اي دبليو ايس", "Kubernetes" as "كوبرنتيز". Claude reads
 * those correctly, and the system prompt tells it to expect them.
 */
const DEFAULT_MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
const DEFAULT_LANGUAGE = process.env.DEEPGRAM_LANGUAGE || "ar";

/**
 * @param {Buffer|Uint8Array} audio     Encoded audio (webm/opus, wav, mp3 — Deepgram sniffs it)
 * @param {object}  [opts]
 * @param {string}  [opts.contentType]  MIME type of `audio`
 * @returns {Promise<{transcript: string, confidence: number, language: string|null, ms: number}>}
 */
export async function transcribe(audio, { contentType = "audio/wav" } = {}) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY not set in .env");

  const params = new URLSearchParams({
    model: DEFAULT_MODEL,
    language: DEFAULT_LANGUAGE,
    smart_format: "true", // punctuation — Claude reads a punctuated question better
    punctuate: "true",
  });

  const startedAt = Date.now();
  const res = await fetch(`${ENDPOINT}?${params}`, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": contentType },
    body: audio,
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Deepgram ${res.status}: ${body.err_msg || JSON.stringify(body).slice(0, 300)}`);
  }

  const alt = body.results?.channels?.[0]?.alternatives?.[0];
  return {
    transcript: (alt?.transcript ?? "").trim(),
    confidence: alt?.confidence ?? 0,
    language: body.results?.channels?.[0]?.detected_language ?? null,
    ms: Date.now() - startedAt,
  };
}
