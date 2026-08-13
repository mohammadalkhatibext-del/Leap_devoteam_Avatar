/**
 * STT engine registry — one recorded clip in, {transcript, language, confidence} out.
 *
 * Both engines answer the same two questions the booth actually needs: what did they
 * say, and which language did they say it in. How each arrives at the language is
 * different, and worth knowing before you compare them:
 *
 *   Deepgram  Two single-language requests in parallel (ar + en); the one that hears
 *             something wins. This is not over-engineering — `deepgram.mjs` records
 *             that `detect_language=true` labelled the Arabic fixture **Turkish**, and
 *             `language=multi` does not cover Arabic at all. Two calls is the only
 *             configuration measured to work.
 *
 *   OpenAI    One request, and the language falls out of the script the model returns.
 *             Arabic and English do not share an alphabet, so "does this contain
 *             Arabic letters" is a more reliable detector here than any language-id
 *             flag — and it costs nothing.
 *
 * Keys never leave the server, same rule as the Anam and Deepgram tokens.
 */

import { transcribe as deepgramTranscribe } from "./deepgram.mjs";
import { asPrompt } from "./vocabulary.mjs";

const env = (k) => process.env[k]?.trim() || "";

const ARABIC = /[؀-ۿ]/;

/* ------------------------------------------------------------------- openai */

async function openaiTranscribe(audio, { contentType }) {
  const key = env("OPENAI_API_KEY");
  const startedAt = Date.now();

  // The API infers the container from the filename extension, so it has to match what
  // the browser actually recorded — a webm/opus clip sent as "clip.wav" is rejected.
  const ext = /wav/.test(contentType) ? "wav" : /mp4|m4a/.test(contentType) ? "mp4" : "webm";

  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentType }), `clip.${ext}`);
  form.append("model", env("OPENAI_STT_MODEL") || "gpt-4o-transcribe");
  // Booth vocabulary, so "ديفوتيم" survives. See server/vocabulary.mjs for the
  // measurement and for why no `language` field accompanies it.
  form.append("prompt", asPrompt());

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OpenAI STT ${res.status}: ${body.error?.message || JSON.stringify(body).slice(0, 200)}`);
  }

  const transcript = (body.text ?? "").trim();
  return {
    transcript,
    // No per-utterance confidence is returned, so reporting a number would be
    // inventing one. Empty means it heard nothing; that is the only signal available.
    confidence: transcript ? 1 : 0,
    language: transcript ? (ARABIC.test(transcript) ? "ar" : "en") : null,
    ms: Date.now() - startedAt,
    considered: [{ language: "script-detected", confidence: transcript ? 1 : 0 }],
  };
}

/* ----------------------------------------------------------------- registry */

export const STT_ENGINES = {
  deepgram: {
    id: "deepgram",
    label: "Deepgram",
    blurb:
      "Two parallel single-language requests (nova-3 Arabic, nova-2 English); the higher confidence wins. Measured as the only reliable Arabic configuration.",
    requires: ["DEEPGRAM_API_KEY"],
    transcribe: (audio, opts) => deepgramTranscribe(audio, opts),
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    blurb:
      "One request to gpt-4o-transcribe. Language is read from the script of the transcript, which is unambiguous between Arabic and English. No confidence score is returned.",
    requires: ["OPENAI_API_KEY"],
    transcribe: openaiTranscribe,
  },
};

export const DEFAULT_STT_ENGINE = "deepgram";

function sttStatus(id) {
  const e = STT_ENGINES[id];
  if (!e) return { configured: false, missing: [], unknown: true };
  const missing = e.requires.filter((k) => !env(k));
  return { configured: missing.length === 0, missing };
}

export function listSttEngines() {
  return Object.values(STT_ENGINES).map((e) => ({
    id: e.id,
    label: e.label,
    blurb: e.blurb,
    ...sttStatus(e.id),
  }));
}

/** Transcribe one utterance on a named engine. */
export async function transcribe(audio, { engine = DEFAULT_STT_ENGINE, contentType = "audio/webm" } = {}) {
  const e = STT_ENGINES[engine] ?? STT_ENGINES[DEFAULT_STT_ENGINE];
  const status = sttStatus(e.id);
  if (!status.configured) {
    throw new Error(`${e.label} is not configured — missing ${status.missing.join(", ")} in .env`);
  }
  return e.transcribe(audio, { contentType });
}

/**
 * Run every configured engine on the same clip, for the settings-page comparison.
 *
 * One recording, every engine — the same controlled-experiment discipline Phase 0
 * used for renderers. A failing engine returns its error rather than sinking the
 * whole comparison, because "OpenAI is misconfigured" is itself a useful result.
 */
export async function transcribeAll(audio, { contentType = "audio/webm" } = {}) {
  const ids = Object.keys(STT_ENGINES).filter((id) => sttStatus(id).configured);
  return Promise.all(
    ids.map(async (id) => {
      try {
        return { engine: id, label: STT_ENGINES[id].label, ok: true, ...(await transcribe(audio, { engine: id, contentType })) };
      } catch (err) {
        return { engine: id, label: STT_ENGINES[id].label, ok: false, error: err.message };
      }
    }),
  );
}
