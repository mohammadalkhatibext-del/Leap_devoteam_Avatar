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
   * Defaults to edge because it is the only one that needs no key at all — but it
   * reaches Microsoft's voices through an undocumented endpoint and must not run at
   * LEAP. Azure serves the identical voice catalogue legitimately, so moving to it
   * changes nothing a visitor hears. server/tts-engines.mjs holds the detail.
   */
  ttsEngine: "edge",

  /** Which engine turns the visitor's speech into text: "deepgram" | "openai". */
  sttEngine: "deepgram",

  // One voice per language. Used by the two Microsoft engines (edge and Azure), which
  // share a voice catalogue — a voice picked on one works unchanged on the other.
  voiceAr: "ar-SA-HamedNeural",
  voiceEn: "en-US-GuyNeural",

  /**
   * The multilingual engines take a single voice for both languages instead of one
   * per language, so they get their own fields rather than overloading the two above.
   * Empty ElevenLabs id means "follow ELEVENLABS_VOICE_ID from .env" — same
   * empty-until-chosen rule as the Anam avatar, and for the same reason.
   */
  elevenVoiceId: "",
  openaiVoice: "alloy",

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
