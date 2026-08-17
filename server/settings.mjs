import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, "data", "settings.json");

/**
 * The models that may write an answer, with what each was measured at.
 *
 * A closed list rather than a text box: a typo'd model id does not fail here, it fails
 * on the first visitor's question as a dead screen at LEAP. The numbers are time to
 * first token against this corpus (~31k cached tokens), median of four runs — see the
 * "Speed" section of README.md for how they were taken.
 */
export const ANSWER_MODELS = [
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    note: "~2.0 s to first word. Holds the word budget and the Arabic register. The default.",
    supportsEffort: true,
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    note: "~1.1 s to first word — a second quicker, but it overruns the answer length and writes numbers as digits. Judge it by ear before an event.",
    supportsEffort: false,
  },
];

/**
 * Everything a booth operator can change without touching code.
 *
 * The audience for these fields is a Devoteam staffer on a stand, not a developer:
 * the admin page shows them in plain language, and nothing here requires knowing what
 * a system prompt is. Defaults are the values that were measured or decided during
 * Phase 0/1, so an untouched booth behaves exactly as tested.
 */
export const DEFAULTS = {
  profileName: "Devoteam LEAP",

  /**
   * Which renderer drives the face: "anam" | "simli" | "akool".
   *
   * Not cosmetic. Anam and Simli lip-sync the Arabic audio we generate; Akool has no
   * audio input and speaks with its own voice, so switching to it silently replaces
   * the voice ranked in SCORING.md Step 1. server/providers.mjs holds the detail and
   * the admin page states it in the picker.
   */
  avatarProvider: "anam",

  /** Simli: face id and lip-sync model. Empty means follow SIMLI_FACE_ID from .env. */
  simliFaceId: "",
  simliModel: "fasttalk",

  /** Akool: avatar and its own voice, since ours is not used there. */
  akoolAvatarId: "",
  akoolVoiceId: "",
  akoolLanguage: "ar",

  /**
   * How long an Akool session is opened for, in seconds.
   *
   * This is a **cost** setting, not a comfort one. Akool pre-charges the whole
   * requested window and refunds the remainder only once the session ends, so an
   * idle open session costs exactly what a busy one does. Five minutes covers a
   * booth conversation with room to spare; ten minutes simply doubles the bill for
   * the same visitor.
   */
  akoolSessionSeconds: 300,

  /**
   * `releaseAvatarWhenIdle` was here. It closed the session on idle for Akool only,
   * on the reasoning that Anam and Simli are not billed by wall-clock. That reasoning
   * was too narrow — those two still hold a concurrency slot and a live WebRTC stream
   * for a screen nobody is standing at. Closing on idle is now unconditional and the
   * timeout is `idleDisconnectMinutes` below, so there is no longer a switch to get
   * wrong.
   */

  /**
   * Anam avatar. Empty means "follow ANAM_AVATAR_ID from .env" — deliberately not
   * seeded from the environment, because doing so freezes whatever .env said the
   * first time settings were ever saved, and from then on editing .env silently does
   * nothing. Empty-until-chosen keeps one source of truth: .env until an operator
   * picks a face in the admin page, that face afterwards.
   * `npm run check:anam` lists the ids the current key can actually use.
   */
  avatarId: "",

  /**
   * Which engine turns the answer into speech: "edge" | "azure" | "elevenlabs" | "openai".
   *
   * ElevenLabs, on measurement rather than taste. On one Arabic sentence, time to a
   * finished clip: ElevenLabs Flash v2.5 ~290 ms, Turbo v2.5 ~280 ms, OpenAI
   * gpt-4o-mini-tts ~3420 ms. Since the booth synthesises the FIRST sentence before
   * the avatar can open its mouth, that difference is ~3 s of a visitor staring at a
   * motionless face on every single question. edge-tts is also disqualified for LEAP
   * on its own terms — undocumented endpoint. server/tts-engines.mjs holds the detail.
   */
  ttsEngine: "elevenlabs",

  /**
   * Which engine turns the visitor's speech into text: "deepgram" | "openai".
   *
   * OpenAI: one request instead of Deepgram's two, and on a booth-length clip (~3 s)
   * it returns in ~280 ms. Language falls out of the script of the transcript, which
   * between Arabic and English cannot be ambiguous.
   */
  sttEngine: "openai",

  /**
   * Which Claude model writes the answer.
   *
   * Measured on the booth corpus, time to first token: Sonnet 5 ~1.9–2.3 s, Haiku 4.5
   * ~1.0–1.4 s. Haiku is genuinely a second faster and is kept selectable for it — but
   * it is the default nowhere, because on the same three Arabic questions it ran 62,
   * 32 and 19 words against a 22-word budget and wrote "11,000" in digits where the
   * prompt asks for words, which an Arabic TTS voice can read wrong. The second Haiku
   * saves is smaller than the three seconds the TTS engine above already recovered.
   */
  answerModel: "claude-sonnet-5",

  // One voice per language. Used by the two Microsoft engines (edge and Azure), which
  // share a voice catalogue — a voice picked on one works unchanged on the other.
  voiceAr: "ar-SA-HamedNeural",
  voiceEn: "en-US-GuyNeural",

  /**
   * Which gender the booth speaks in: "male" | "female".
   *
   * One switch rather than four voice ids, because the thing an operator actually
   * decides is "the avatar on screen is a woman" — and the voice has to agree with the
   * face in both languages at once. Setting it picks a matched ElevenLabs pair
   * (see ELEVEN_VOICE_PAIRS in server/tts-engines.mjs): male is Mohammed Almansari in
   * Arabic and Sully in English, female is Abrar Sabbah and Jessa.
   *
   * **Female, because the avatar that actually ships is female.** ANAM_AVATAR_ID in
   * .env is 278fec65…, which `GET /v1/avatars` names **Dania** — not the "Faisal -
   * Cultural Guide" the comment beside it claimed for months. Faisal is a real avatar
   * on the same account (bba96e80…) and switching to him is one dropdown in Settings,
   * but this default has to describe the booth as configured. A woman's face speaking
   * with a man's voice is the single most visible way this booth can be wrong: a
   * visitor notices it before they hear a word of the answer.
   *
   * Change these two together or not at all.
   *
   * The two fields below still win when set, so an operator who wants a specific
   * voice is never boxed in by the toggle.
   */
  voiceGender: "female",

  /**
   * ElevenLabs keeps its own pair, because its voice ids are nothing like the
   * Microsoft ones and a native Arabic voice plus a native English voice beats one
   * multilingual voice stretched across both. Empty means "follow the voiceGender
   * pair above, then ELEVENLABS_VOICE_AR / _EN from .env" — the same
   * empty-until-chosen rule as the Anam avatar, so nothing here freezes a choice the
   * operator has not made.
   */
  elevenVoiceAr: "",
  elevenVoiceEn: "",

  /**
   * ElevenLabs model. Latency is a feature at a booth — the visitor is standing there.
   * Flash v2.5 by default on measurement: ~290 ms to a finished Arabic sentence
   * against ~1130 ms for Multilingual v2, which was the previous .env value. That is
   * most of a second returned on every sentence of every answer. Empty follows
   * ELEVENLABS_MODEL_ID from .env.
   */
  elevenModel: "eleven_flash_v2_5",

  /** OpenAI ships one voice for both languages; there is no per-language choice. */
  openaiVoice: "alloy",

  /**
   * How long an answer should be, in words.
   *
   * The Arabic voice speaks about 1.4 words a second (WORDS_PER_SECOND in
   * server/system-prompt.mjs), so 22 words is roughly sixteen seconds out loud — about
   * as long as someone standing in a noisy hall will listen. Treat it as a budget the
   * answer runs slightly over rather than a ceiling: measured, a 22-word setting
   * produces around 27 words. That overrun used to be nearly double until the length
   * rule was restated next to the question; see buildLengthDirective.
   */
  answerWords: 22,

  greetFirstAnswer: true,

  /** Minutes of silence before the conversation clears itself for the next visitor. */
  idleResetMinutes: 5,

  /**
   * Wait for a deliberate tap before opening a renderer session at all.
   *
   * The booth used to connect on page load, which meant a screen nobody was standing
   * at held a live avatar session all day — every vendor charges for that somehow, and
   * Anam caps concurrent sessions, so an idle stand could lock out the machine that
   * actually had a visitor. A tap is also the honest gate for the microphone: a face
   * that goes live the instant the page opens has no moment a visitor consented to.
   */
  requireTapToStart: true,

  /**
   * Minutes of silence before the renderer session is dropped and the face goes away.
   *
   * Distinct from idleResetMinutes, which only clears the conversation text. This one
   * ends the vendor session, so it is the setting that decides what an empty stand
   * costs. The next visitor's tap reconnects in a few seconds — paid while they are
   * still walking up, which is the cheapest place to spend it.
   *
   * Applies to every renderer. The old behaviour released only Akool, on the reasoning
   * that Anam and Simli are not billed by wall-clock; but concurrency limits and a
   * stand left streaming a face to nobody are reasons enough on their own.
   */
  idleDisconnectMinutes: 2,

  /**
   * How each renderer's video is framed on the stage.
   *
   * Not one global value, because the vendors do not ship the same shape of video.
   * Anam sends a portrait already cropped to head and shoulders, which wants filling.
   * **Simli sends a 512×512 square** (measured in the browser), and forcing a square
   * into a portrait stage with `cover` scales it up until the width overflows — so the
   * head is cropped on all four sides. That is the "does not fit right" complaint, and
   * it is a shape mismatch rather than a zoom level.
   *
   *   fit     "cover" fills the stage and crops whatever does not fit; "contain" fits
   *           the whole frame inside and lets the stage's own dark ground show at the
   *           edges. Square sources want `contain`; portrait sources want `cover`.
   *   zoom    Scales after fitting. Below 1 pulls the picture further inside the stage,
   *           above 1 pushes past the edges. Leave at 1 unless a specific avatar needs it.
   *   focusY  The vertical point held steady while it scales, in percent from the top,
   *           so a face stays a face rather than drifting off as it shrinks. It is also
   *           the crop anchor under `cover` — 22% keeps forehead, which matters because
   *           a centre crop of a portrait loses the top of the head before the floor.
   */
  stageFraming: {
    anam: { fit: "cover", zoom: 1, focusY: 22 },
    simli: { fit: "contain", zoom: 1, focusY: 50 },
    akool: { fit: "cover", zoom: 1, focusY: 22 },
  },

  /**
   * Free text the operator can add — house rules, an event-specific note, something
   * to emphasise this week. Appended to the system prompt verbatim.
   */
  customInstructions: "",

  /**
   * Extra facts that are not in the knowledge base yet (a new award, a stand
   * location, today's demo schedule). Added as one more citable document, so
   * answers using it are still grounded and attributable.
   */
  extraKnowledge: "",

  /**
   * What the booth does when the live pipeline fails — the STRATEGY.md §5 position.
   * `speak` keeps the avatar talking with a fixed line; `text` is the honest fallback
   * when audio itself is broken.
   */
  fallback: {
    enabled: true,
    mode: "speak", // "speak" | "text"
    messageAr:
      "أعتذر، النظام ما يقدر يجاوب الحين. تفضلوا، أحد زملائي هنا في الجناح يسعده مساعدتكم.",
    messageEn:
      "I'm sorry — I can't answer right now. One of my colleagues here at the stand would be glad to help you.",
  },
};

let cache = null;

/** Deep-merge stored values over defaults so a new field never breaks an old file. */
function merge(base, saved) {
  const out = { ...base };
  for (const [k, v] of Object.entries(saved ?? {})) {
    if (!(k in base)) continue; // ignore unknown keys rather than trusting them
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(base[k], v) : v;
  }
  return out;
}

export async function getSettings() {
  if (cache) return cache;
  try {
    cache = merge(DEFAULTS, JSON.parse(await readFile(FILE, "utf8")));
  } catch {
    cache = { ...DEFAULTS }; // no file yet — first run
  }
  return cache;
}

/** Validate and persist a partial update; returns the full saved settings. */
export async function saveSettings(patch) {
  const next = merge(await getSettings(), patch);

  // Clamp the two numbers an operator could set to something that breaks the booth.
  next.answerWords = Math.min(120, Math.max(10, Number(next.answerWords) || DEFAULTS.answerWords));
  next.idleResetMinutes = Math.min(
    60,
    Math.max(1, Number(next.idleResetMinutes) || DEFAULTS.idleResetMinutes),
  );

  next.idleDisconnectMinutes = Math.min(
    60,
    Math.max(1, Number(next.idleDisconnectMinutes) || DEFAULTS.idleDisconnectMinutes),
  );

  // Akool's own ceiling is 3600 s. A value above it is rejected by their API at
  // session-create time — i.e. a dead booth — so clamp rather than forward it.
  next.akoolSessionSeconds = Math.min(
    3600,
    Math.max(60, Number(next.akoolSessionSeconds) || DEFAULTS.akoolSessionSeconds),
  );

  // Framing is written straight into a CSS transform, so a stray value does not throw —
  // it silently renders a face at 40x or upside down, on the one screen nobody is
  // watching. Clamp to the range a stage can actually show.
  for (const [id, frame] of Object.entries(next.stageFraming ?? {})) {
    const fallback = DEFAULTS.stageFraming[id] ?? { fit: "cover", zoom: 1, focusY: 22 };
    frame.zoom = Math.min(2, Math.max(0.4, Number(frame.zoom) || fallback.zoom));
    frame.focusY = Math.min(100, Math.max(0, Number(frame.focusY) ?? fallback.focusY));
    if (frame.fit !== "cover" && frame.fit !== "contain") frame.fit = fallback.fit;
  }

  // A model id that does not exist fails on the first visitor's question, at the booth,
  // as a dead screen. Only the two that were measured are selectable.
  if (!ANSWER_MODELS.some((m) => m.id === next.answerModel)) {
    next.answerModel = DEFAULTS.answerModel;
  }
  if (next.voiceGender !== "male" && next.voiceGender !== "female") {
    next.voiceGender = DEFAULTS.voiceGender;
  }

  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf8");
  cache = next;
  return next;
}

export async function resetSettings() {
  cache = { ...DEFAULTS };
  await mkdir(path.dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(cache, null, 2), "utf8");
  return cache;
}
