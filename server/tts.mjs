import { synth, SAMPLE_RATE, DEFAULT_TTS_ENGINE } from "./tts-engines.mjs";

export { SAMPLE_RATE };

/**
 * The male ElevenLabs voice, as a last-resort parameter default.
 *
 * It used to be a Microsoft voice id, from when edge-tts and Azure were selectable.
 * Both are gone, and a Microsoft id handed to ElevenLabs is not a wrong voice — it is
 * a 404 and a silent avatar, the worst way for a stale default to fail.
 */
export const DEFAULT_VOICE = process.env.TTS_VOICE || "2bnoa3wtrtcUW41TrSJM";

const clipCache = new Map();

/**
 * Arabic (or English) text -> raw 16-bit mono PCM at 24 kHz.
 *
 * The engine is a parameter rather than a module-level constant because a booth
 * operator can change it mid-event from the settings page, and the next question has
 * to use the new one without a restart. `cache: true` memoises — only worth it for
 * fixed phrases, and the key carries the engine so switching engines never replays a
 * cached clip in the previous engine's voice.
 */
export async function speak(
  text,
  { engine = DEFAULT_TTS_ENGINE, voice = DEFAULT_VOICE, language = "ar", model, cache = false } = {},
) {
  // The model rides in the cache key alongside the engine and voice: switching
  // models changes how a line sounds, so a cached clip from the previous model
  // would otherwise be replayed as if nothing had changed.
  const key = `${engine} ${model ?? ""} ${voice} ${text}`;
  if (cache && clipCache.has(key)) return clipCache.get(key);

  const pcm = await synth(text, { engine, voice, language, model });
  if (cache) clipCache.set(key, pcm);
  return pcm;
}

/**
 * REMOVED: the spoken "لحظة من فضلك" / "One moment, please" acknowledgement.
 *
 * It existed to cover the gap between a visitor finishing their question and the
 * avatar's first real word, which used to be around eight seconds — long enough that
 * silence read as a crash. That gap is now roughly three, from three changes that
 * removed the cause rather than masking it: ElevenLabs Flash in place of OpenAI TTS
 * (~3.4 s to ~0.3 s per sentence), a clause-level first flush in server/claude.mjs
 * (~1.7 s), and a shorter microphone hang-up in booth/src/mic.js (~0.45 s).
 *
 * Do not reintroduce it without re-measuring first. A filler is a real cost, not just
 * a patch: it puts a sentence the visitor did not ask for in front of every answer,
 * which at a booth is the difference between an assistant and a hold queue. The state
 * is still legible without it — the badge reads "thinking" and the dot animates, which
 * is honest about the wait without spending a second and a half of the visitor's
 * attention saying nothing.
 *
 * Warm the engine at startup instead: see prewarmEngine below.
 */

/**
 * Make the first visitor's question cost the same as the tenth.
 *
 * Not a filler — nothing rendered here is ever played. The point is the connection:
 * a cold process pays DNS, TLS and the vendor's own cold start on its first synthesis,
 * which measured as high as 2.2 s against a steady-state 0.3 s. Doing that once at
 * boot moves the cost off the first visitor, who is usually the one being demoed to.
 *
 * @param {{ar?: string, en?: string}} voices  voice id per language
 * @param {string} engine  which TTS engine to warm
 */
export async function prewarmEngine(voices = {}, engine = DEFAULT_TTS_ENGINE, model) {
  const jobs = [];
  for (const [language, text] of [["ar", "جاهز."], ["en", "Ready."]]) {
    // No cross-engine fallback. DEFAULT_VOICE is an *ElevenLabs* voice id, and handing
    // "ar-SA-HamedNeural" to ElevenLabs is a hard 400 — which as a warm-up step means
    // a booth that logs a scary error at startup for a voice nobody asked it to use.
    // A language with no voice configured simply has nothing to warm.
    const voice = voices[language];
    if (!voice) continue;
    jobs.push(speak(text, { engine, voice, language, model, cache: true }));
  }
  // Warming must never be able to take the booth down: it runs at startup and after
  // every settings save, and a wrong voice id is exactly the thing an operator is in
  // the middle of correcting. The real synthesis path reports its own failures.
  const done = await Promise.allSettled(jobs);
  return done.filter((d) => d.status === "fulfilled").length;
}

/**
 * Keeps spoken output in the order it was written, without making synthesis serial.
 *
 * Claude streams sentence 2 while sentence 1 is still being synthesised. Waiting for
 * each clip before requesting the next would add a full TTS round-trip of silence
 * between every sentence — audible, and exactly the dead air a booth visitor reads as
 * "it's broken". So every `push()` fires its request immediately and the results are
 * released through a promise chain, which means clips can be *made* in parallel but
 * are always *delivered* in order.
 */
export class SpeechQueue {
  #tail = Promise.resolve();
  #voice;
  #engine;
  #language;
  #model;

  /** @param {(pcm: Buffer, meta: {index: number, text: string}) => any} onClip */
  constructor(
    onClip,
    { voice = DEFAULT_VOICE, engine = DEFAULT_TTS_ENGINE, language = "ar", model } = {},
  ) {
    this.onClip = onClip;
    this.#voice = voice;
    this.#engine = engine;
    this.#language = language;
    this.#model = model;
    this.count = 0;
  }

  push(text) {
    const index = this.count++;

    // Start synthesising now, but attach the failure handler in the SAME tick.
    // Deferring it to the `.then` below is what crashed the whole dev server: this
    // promise can reject while the queue is still playing an earlier clip, and until
    // something is attached to it Node counts that as an unhandled rejection and
    // kills the process. A dead TTS engine must degrade to silent subtitles, never
    // take the booth down with it.
    const pending = speak(text, {
      engine: this.#engine,
      voice: this.#voice,
      language: this.#language,
      model: this.#model,
    }).catch((err) => {
      console.error(`  [tts] sentence ${index} failed: ${err.message}`);
      return null;
    });

    this.#tail = this.#tail
      .then(async () => {
        const pcm = await pending;
        if (pcm) await this.onClip(pcm, { index, text });
      })
      .catch((err) => {
        // One failed sentence must not silence the rest of the answer.
        console.error(`  [tts] sentence ${index} delivery failed: ${err.message}`);
      });

    return this.#tail;
  }

  /** Resolves when every pushed sentence has been delivered. */
  drain() {
    return this.#tail;
  }
}

/** Minimal RIFF/WAVE wrapper — for writing clips to disk when testing. */
export function toWav(pcm, rate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
