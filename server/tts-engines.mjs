/**
 * TTS engine registry — text in, raw 24 kHz signed-16-bit mono PCM out.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * ONE OUTPUT FORMAT, EVERY VENDOR
 *
 * Every engine here returns byte-compatible PCM at 24 kHz. That is not a coincidence
 * we got lucky with — it is the reason this file can exist at all. ElevenLabs serves
 * `pcm_24000` and OpenAI serves `response_format: "pcm"` (24 kHz by definition), so
 * `SpeechQueue`, the SSE `audio` events, the Anam adapter and the Simli resampler are
 * all completely unaware of which engine ran.
 *
 * There were four vendors once. edge-tts and Azure were removed along with their
 * per-language Microsoft voice ids — edge because an undocumented endpoint had no
 * business anywhere near a show floor, and it was still reachable from the admin
 * page's "Compare Providers" button long after it stopped being selectable.
 *
 * The practical payoff: switching engines is a settings change, and comparing them
 * is a controlled experiment — identical text, identical format, only the voice
 * differs. Same discipline as the Phase 0 renderer bake-off, applied to voice.
 * ────────────────────────────────────────────────────────────────────────────────
 */

const env = (k) => process.env[k]?.trim() || "";

export const SAMPLE_RATE = 24000;

/* --------------------------------------------------------------- silence trim */

const SILENCE_THRESHOLD = 300; // out of 32767 — above the codec noise floor
const FRAME = SAMPLE_RATE / 100; // 10 ms
const PAD = (SAMPLE_RATE * 40) / 1000; // keep 40 ms so the first consonant survives

/**
 * Strip leading/trailing silence.
 *
 * Answers are synthesised one sentence at a time and played back to back, so any
 * padding a vendor adds becomes a dead gap between every sentence — several seconds
 * across a full answer, during which a photorealistic face sits motionless and reads
 * as a crash. This covers both engines, so their clips butt up against each other
 * the same way. Without it, switching engines would silently change answer pacing and
 * make the comparison unfair.
 */
function trimSilence(pcm) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  if (!samples.length) return pcm;

  const loud = (i) => {
    const end = Math.min(i + FRAME, samples.length);
    for (let j = i; j < end; j++) if (Math.abs(samples[j]) > SILENCE_THRESHOLD) return true;
    return false;
  };

  let first = -1;
  for (let i = 0; i < samples.length; i += FRAME) if (loud(i)) { first = i; break; }
  if (first === -1) return Buffer.alloc(0); // nothing but silence

  let last = first;
  for (let i = samples.length - (samples.length % FRAME); i >= 0; i -= FRAME) {
    if (loud(i)) { last = i; break; }
  }

  const lo = Math.max(0, first - PAD);
  const hi = Math.min(samples.length, last + FRAME + PAD);
  return Buffer.from(pcm.buffer, pcm.byteOffset + lo * 2, (hi - lo) * 2);
}

/* --------------------------------------------------------------- elevenlabs */

/**
 * The `/stream` endpoint, not the plain one — and the difference is not small.
 *
 * Both return the same bytes; the plain endpoint just holds them until synthesis has
 * finished. Measured on one Arabic sentence, four runs each, time to the complete clip:
 *
 *              plain              /stream + optimize=3
 *   turbo_v2_5   477–2198 ms        274–405 ms
 *   flash_v2_5   330–358 ms         256–289 ms
 *
 * Note the plain-endpoint spread on turbo — over two seconds at the tail. That tail is
 * the booth's worst case, not its average, and it lands on the first sentence of an
 * answer where a visitor is watching a still face. Streaming flattens it.
 *
 * `optimize_streaming_latency` is deprecated in ElevenLabs' docs in favour of the
 * model choice, and 3 rather than 4 deliberately: level 4 also disables the text
 * normaliser, which is what turns "11,000" and "%" into spoken words. In Arabic that
 * normaliser is doing real work and 20 ms is not worth losing it.
 */
async function elevenSynth(text, { voice, model }) {
  const key = env("ELEVENLABS_API_KEY");
  const voiceId = voice;
  if (!voiceId) throw new Error("no ElevenLabs voice — pick one in the settings page");

  // pcm_24000 returns RAW headerless PCM, already at our rate. Anything else would
  // need decoding on this side for no benefit.
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream` +
      `?output_format=pcm_24000&optimize_streaming_latency=3`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: model || env("ELEVENLABS_MODEL_ID") || "eleven_flash_v2_5",
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`ElevenLabs ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return trimSilence(Buffer.from(await res.arrayBuffer()));
}

/* ------------------------------------------------------------------- openai */

async function openaiSynth(text, { voice }) {
  const key = env("OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env("OPENAI_TTS_MODEL") || "gpt-4o-mini-tts",
      voice: voice || "alloy",
      input: text,
      // "pcm" is documented as 24 kHz 16-bit signed little-endian mono — our format
      // exactly, so no decode step and no resample.
      response_format: "pcm",
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI TTS ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return trimSilence(Buffer.from(await res.arrayBuffer()));
}

/* ----------------------------------------------------------------- registry */

/**
 * `voiceMode` tells the admin page which voice control to show:
 *
 *   "single"     one voice for both languages; the model is multilingual and the
 *                same voice speaks Arabic and English. Both remaining engines are
 *                "single", so the admin page has exactly one voice picker.
 */
export const TTS_ENGINES = {
  elevenlabs: {
    id: "elevenlabs",
    label: "ElevenLabs",
    // One voice for both languages. It used to be a native voice per language, which
    // read better side by side and worse in the room: a visitor who asks in Arabic and
    // follows up in English heard the avatar change person mid-conversation. Both Gulf
    // voices below speak English well enough that keeping one person on screen wins.
    voiceMode: "single",
    blurb:
      "One voice across both languages, and by far the fastest: ~290 ms to a finished Arabic sentence against ~3.4 s for OpenAI. Also the most natural Arabic here. The booth default.",
    requires: ["ELEVENLABS_API_KEY"],
    cost: "billed per character, live",
    synth: elevenSynth,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    voiceMode: "single",
    blurb:
      "One voice for both languages. English-first voices, and the slowest engine here by an order of magnitude: ~3.4 s per sentence, which a visitor spends watching a motionless face.",
    warn: "~3.4 s per sentence — measured. Too slow for a live booth.",
    requires: ["OPENAI_API_KEY"],
    cost: "billed per character, live",
    synth: openaiSynth,
  },
};

export const DEFAULT_TTS_ENGINE = "elevenlabs";

/**
 * The ElevenLabs voices this key can actually use, for the admin picker.
 *
 * Worth a real API call rather than a text box, because of a failure this project hit
 * on the first try: a **library** voice id is accepted everywhere in the dashboard but
 * returns `402 paid_plan_required` from the API on a free account, while **premade**
 * voices work fine. Both are bare alphanumeric ids and nothing in the id says which is
 * which — exactly the shape of the Anam avatar-vs-persona trap. Listing what the key
 * can use turns a booth-floor 402 into a dropdown.
 */
export async function listElevenVoices() {
  const key = env("ELEVENLABS_API_KEY");
  if (!key) return [];
  // v2 is what actually returns the voices added from the Voice Library. The v1
  // per-voice lookup rejects them with a 400 even while text-to-speech accepts them
  // perfectly — so v1 would report a working voice as missing.
  const res = await fetch("https://api.elevenlabs.io/v2/voices?page_size=100", {
    headers: { "xi-api-key": key },
  });
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  return (body.voices ?? []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category,
    // The labels are what make the picker usable: language decides which of the two
    // pickers a voice belongs in, and accent decides whether it belongs in Riyadh.
    language: v.labels?.language ?? "",
    accent: v.labels?.accent ?? "",
    gender: v.labels?.gender ?? "",
  }));
}

/**
 * The matched ElevenLabs voice pairs behind the `voiceGender` setting.
 *
 * A pair, not a voice, because the booth is bilingual and the mismatch an operator
 * would actually create is a male Arabic voice next to a female English one — the same
 * avatar apparently changing sex when a visitor switches language. Pinning both ends
 * of the choice to one switch makes that unrepresentable.
 *
 * Ids verified against this account's GET /v2/voices on 2026-08-13; all four are
 * `professional` category, which matters because **library** voices return
 * `402 paid_plan_required` from the synthesis API on some plans while looking identical
 * in the dashboard. The Arabic voices are the two labelled for the Gulf: Mohammed
 * Almansari is `saudi`, Abrar Sabbah is `modern standard`.
 */
export const ELEVEN_VOICES = {
  male: { id: "2bnoa3wtrtcUW41TrSJM", name: "Mohammed Almansari" },
  female: { id: "VwC51uc4PUblWEJSPzeo", name: "Abrar Sabbah" },
};

/** Voices OpenAI ships. Fixed list — there is no catalogue endpoint to query. */
export const OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];

function ttsStatus(id) {
  const e = TTS_ENGINES[id];
  if (!e) return { configured: false, missing: [], unknown: true };
  const missing = e.requires.filter((k) => !env(k));
  return { configured: missing.length === 0, missing };
}

/** Everything the admin page needs to render the engine picker honestly. */
export function listTtsEngines() {
  return Object.values(TTS_ENGINES).map((e) => ({
    id: e.id,
    label: e.label,
    voiceMode: e.voiceMode,
    blurb: e.blurb,
    warn: e.warn ?? null,
    cost: e.cost,
    ...ttsStatus(e.id),
  }));
}

/**
 * Which voice id this engine should use for this language.
 *
 * Kept here rather than in the caller because the answer is engine-shaped. Both
 * engines now take one id for both languages, so `language` is accepted and ignored
 * — the parameter stays because callers pass it and because an engine that needs it
 * again should not have to change every call site.
 */
export function voiceFor(settings, engineId, language) {
  const engine = TTS_ENGINES[engineId] ?? TTS_ENGINES[DEFAULT_TTS_ENGINE];
  if (engine.id === "elevenlabs") {
    // `language` is deliberately unused. One voice speaks both, so there is no
    // per-language choice left to fall out of step — which was the point of dropping
    // the pair: the two halves could drift apart and nothing on the page said so.
    // Order still matters: an explicit choice wins, then the gender voice, then .env.
    const voice = ELEVEN_VOICES[settings.voiceGender] ?? ELEVEN_VOICES.male;
    return settings.elevenVoice || voice.id || env("ELEVENLABS_VOICE_AR");
  }
  if (engine.id === "openai") return settings.openaiVoice || "alloy";
  return "";
}

/**
 * The ElevenLabs models that can actually speak Arabic.
 *
 * Deliberately not the full catalogue: eleven_turbo_v2, eleven_flash_v2 and
 * eleven_english_sts_v2 are English-only, and offering them in a bilingual booth's
 * picker would let an operator select a model that silently cannot say half of what
 * the booth is for. Character ceilings are per request, far above one sentence, so
 * they matter for the fixture renderer rather than for live answers.
 */
export const ELEVEN_MODELS = [
  { id: "eleven_flash_v2_5", label: "Flash v2.5", note: "~290 ms per sentence — the booth default" },
  { id: "eleven_turbo_v2_5", label: "Turbo v2.5", note: "~280 ms, slightly richer, less consistent" },
  { id: "eleven_multilingual_v2", label: "Multilingual v2", note: "~1130 ms — a second slower per sentence" },
  { id: "eleven_v3", label: "v3", note: "~2210 ms — most expressive, far too slow for a live booth" },
];

/** Which model the selected engine should run. Only ElevenLabs exposes a choice. */
export function modelFor(settings, engineId) {
  if (engineId !== "elevenlabs") return undefined;
  return settings.elevenModel || env("ELEVENLABS_MODEL_ID") || "eleven_flash_v2_5";
}

/** Synthesise one clip on a named engine. Always returns 24 kHz s16le mono PCM. */
export async function synth(
  text,
  { engine = DEFAULT_TTS_ENGINE, voice, language = "ar", model } = {},
) {
  const e = TTS_ENGINES[engine] ?? TTS_ENGINES[DEFAULT_TTS_ENGINE];
  const status = ttsStatus(e.id);
  if (!status.configured) {
    throw new Error(`${e.label} is not configured — missing ${status.missing.join(", ")} in .env`);
  }
  return e.synth(text, { voice, language, model });
}
