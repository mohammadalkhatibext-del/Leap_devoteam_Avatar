import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, "data", "settings.json");

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
   * Close the renderer session when a visitor walks away, instead of holding it open
   * for the next one.
   *
   * Only matters for renderers billed by session wall-clock — Akool. Reconnecting
   * costs a few seconds at the start of the next conversation; leaving it open costs
   * money for every minute nobody is standing there, which at an exhibition is most
   * of them. Off by default so Anam and Simli keep their instant-start behaviour.
   */
  releaseAvatarWhenIdle: false,

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
   * Which engine turns the answer into speech: "elevenlabs" | "openai".
   *
   * The booth default is the managed provider pair that matches the operator flow on
   * the admin page: the provider is selected first, then the voice styling is chosen.
   */
  ttsEngine: "elevenlabs",

  /** Which engine turns the visitor's speech into text: "deepgram" | "openai". */
  sttEngine: "deepgram",

  // One voice per language. Used by the two Microsoft engines (edge and Azure), which
  // share a voice catalogue — a voice picked on one works unchanged on the other.
  voiceAr: "ar-SA-HamedNeural",
  voiceEn: "en-US-GuyNeural",

  /**
   * ElevenLabs keeps its own pair, because its voice ids are nothing like the
   * Microsoft ones and a native Arabic voice plus a native English voice beats one
   * multilingual voice stretched across both. Empty means "follow
   * ELEVENLABS_VOICE_AR / _EN from .env" — the same empty-until-chosen rule as the
   * Anam avatar, so editing .env keeps working until an operator makes a choice here.
   */
  elevenVoiceAr: "",
  elevenVoiceEn: "",

  /**
   * ElevenLabs model. Latency is a feature at a booth — the visitor is standing
   * there — so this is worth auditioning, not just leaving at the quality default.
   * Empty follows ELEVENLABS_MODEL_ID from .env.
   */
  elevenModel: "",

  /** OpenAI ships one voice for both languages; the booth default follows the male preset. */
  openaiVoice: "ash",

  /**
   * How long an answer should be, in words. The Arabic voice speaks about two words
   * per second, so 35 words is roughly fifteen seconds — about as long as someone
   * standing in a noisy hall will listen.
   */
  answerWords: 35,

  greetFirstAnswer: true,

  /** Minutes of silence before the conversation clears itself for the next visitor. */
  idleResetMinutes: 5,

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

  // Akool's own ceiling is 3600 s. A value above it is rejected by their API at
  // session-create time — i.e. a dead booth — so clamp rather than forward it.
  next.akoolSessionSeconds = Math.min(
    3600,
    Math.max(60, Number(next.akoolSessionSeconds) || DEFAULTS.akoolSessionSeconds),
  );

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
