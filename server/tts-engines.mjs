/**
 * TTS engine registry — text in, raw 24 kHz signed-16-bit mono PCM out.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * ONE OUTPUT FORMAT, FOUR VENDORS
 *
 * Every engine here returns byte-compatible PCM at 24 kHz. That is not a coincidence
 * we got lucky with — it is the reason this file can exist at all. Azure serves
 * `raw-24khz-16bit-mono-pcm`, ElevenLabs serves `pcm_24000`, OpenAI serves
 * `response_format: "pcm"` (24 kHz by definition), and the edge-tts sidecar decodes
 * its MP3 to the same rate. So `SpeechQueue`, the SSE `audio` events, the Anam
 * adapter and the Simli resampler are all completely unaware of which engine ran.
 *
 * The practical payoff: switching engines is a settings change, and comparing them
 * is a controlled experiment — identical text, identical format, only the voice
 * differs. Same discipline as the Phase 0 renderer bake-off, applied to voice.
 * ────────────────────────────────────────────────────────────────────────────────
 */

const env = (k) => process.env[k]?.trim() || "";

export const SAMPLE_RATE = 24000;
const TTS_PORT = Number(process.env.TTS_PORT || 8765);

/* --------------------------------------------------------------- silence trim */

const SILENCE_THRESHOLD = 300; // out of 32767 — above the codec noise floor
const FRAME = SAMPLE_RATE / 100; // 10 ms
const PAD = (SAMPLE_RATE * 40) / 1000; // keep 40 ms so the first consonant survives

/**
 * Strip leading/trailing silence, matching what the Python sidecar already does to
 * edge-tts output.
 *
 * Answers are synthesised one sentence at a time and played back to back, so any
 * padding a vendor adds becomes a dead gap between every sentence — several seconds
 * across a full answer, during which a photorealistic face sits motionless and reads
 * as a crash. The sidecar trims its own output; this covers the three HTTP engines so
 * every engine's clips butt up against each other the same way. Without it, switching
 * engines would silently change answer pacing and make the comparison unfair.
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

/* ------------------------------------------------------------------ edge-tts */

async function edgeSynth(text, { voice }) {
  const res = await fetch(`http://127.0.0.1:${TTS_PORT}/tts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, voice }),
  });
  if (!res.ok) {
    throw new Error(`edge-tts ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  // The sidecar already trimmed this one.
  return Buffer.from(await res.arrayBuffer());
}

/* -------------------------------------------------------------------- azure */

const xml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c],
  );

async function azureSynth(text, { voice, language }) {
  const key = env("AZURE_SPEECH_KEY");
  const region = env("AZURE_SPEECH_REGION") || "uaenorth";

  // The locale on <speak> has to match the voice, not the detected language — a
  // ar-SA voice inside an en-US envelope is rejected outright by the service.
  const locale = voice?.split("-").slice(0, 2).join("-") || (language === "en" ? "en-US" : "ar-SA");

  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm",
      "User-Agent": "devoteam-leap-booth",
    },
    body: `<speak version="1.0" xml:lang="${locale}"><voice name="${xml(voice)}">${xml(text)}</voice></speak>`,
  });
  if (!res.ok) {
    throw new Error(`Azure ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
  return trimSilence(Buffer.from(await res.arrayBuffer()));
}

/* --------------------------------------------------------------- elevenlabs */

async function elevenSynth(text, { voice }) {
  const key = env("ELEVENLABS_API_KEY");
  const voiceId = voice || env("ELEVENLABS_VOICE_ID");
  if (!voiceId) throw new Error("no ElevenLabs voice id — set ELEVENLABS_VOICE_ID in .env");

  // pcm_24000 returns RAW headerless PCM, already at our rate. Anything else would
  // need decoding on this side for no benefit.
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_24000`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        // multilingual_v2 covers Arabic (ar-SA/ar-AE); flash_v2_5 covers it too and is
        // roughly half the latency, which is why it is worth trying at a booth.
        model_id: env("ELEVENLABS_MODEL_ID") || "eleven_multilingual_v2",
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
 *   "microsoft"  two pickers (Arabic + English) of Microsoft neural voice ids.
 *                edge and Azure serve the same voice catalogue, so a voice chosen
 *                for one works unchanged on the other — which is exactly what makes
 *                the Azure swap a drop-in rather than a re-scoring exercise.
 *   "single"     one voice for both languages; the model is multilingual and the
 *                same voice speaks Arabic and English.
 */
export const TTS_ENGINES = {
  edge: {
    id: "edge",
    label: "edge-tts",
    voiceMode: "microsoft",
    blurb:
      "Microsoft neural voices through the undocumented Edge read-aloud endpoint. Free and needs no card — but it is evaluation-only and must not run on the show floor.",
    warn: "Undocumented endpoint. Fine for building, not for LEAP.",
    requires: [],
    cost: "free",
    synth: edgeSynth,
  },
  azure: {
    id: "azure",
    label: "Azure Speech",
    voiceMode: "microsoft",
    blurb:
      "The same neural voices as edge-tts, served legitimately. F0 free tier covers 0.5M characters/month. This is the production path.",
    requires: ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"],
    cost: "0.5M chars/month free (F0)",
    synth: azureSynth,
  },
  elevenlabs: {
    id: "elevenlabs",
    label: "ElevenLabs",
    voiceMode: "single",
    blurb:
      "One multilingual voice for both languages. Generally the most natural Arabic of the four — the only engine here that could move the voice score above the 3.5 everything else got.",
    requires: ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"],
    cost: "billed per character, live",
    synth: elevenSynth,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    voiceMode: "single",
    blurb:
      "One voice for both languages. Its voices are English-first — they speak Arabic, but the accent may read as foreign to a Saudi visitor. Judge it by ear before trusting it.",
    warn: "English-first voices. Listen for accent on Arabic.",
    requires: ["OPENAI_API_KEY"],
    cost: "billed per character, live",
    synth: openaiSynth,
  },
};

export const DEFAULT_TTS_ENGINE = "edge";

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
  const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
  if (!res.ok) return [];
  const body = await res.json().catch(() => ({}));
  return (body.voices ?? []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    category: v.category, // "premade" is always usable; "professional"/library may 402
  }));
}

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
 * Kept here rather than in the caller because the answer is engine-shaped: the
 * Microsoft engines take a different id per language, the multilingual ones take one
 * id for both. A caller that had to know which is which would have to be updated
 * every time an engine is added.
 */
export function voiceFor(settings, engineId, language) {
  const engine = TTS_ENGINES[engineId] ?? TTS_ENGINES[DEFAULT_TTS_ENGINE];
  if (engine.voiceMode === "microsoft") {
    return language === "en" ? settings.voiceEn : settings.voiceAr;
  }
  if (engine.id === "elevenlabs") return settings.elevenVoiceId || env("ELEVENLABS_VOICE_ID");
  if (engine.id === "openai") return settings.openaiVoice || "alloy";
  return "";
}

/** Synthesise one clip on a named engine. Always returns 24 kHz s16le mono PCM. */
export async function synth(text, { engine = DEFAULT_TTS_ENGINE, voice, language = "ar" } = {}) {
  const e = TTS_ENGINES[engine] ?? TTS_ENGINES[DEFAULT_TTS_ENGINE];
  const status = ttsStatus(e.id);
  if (!status.configured) {
    throw new Error(`${e.label} is not configured — missing ${status.missing.join(", ")} in .env`);
  }
  return e.synth(text, { voice, language });
}
