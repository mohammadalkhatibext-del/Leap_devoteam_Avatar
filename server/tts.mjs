import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { synth, SAMPLE_RATE, DEFAULT_TTS_ENGINE } from "./tts-engines.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVICE = path.join(ROOT, "server", "tts_service.py");

const PORT = Number(process.env.TTS_PORT || 8765);
const BASE = `http://127.0.0.1:${PORT}`;
export { SAMPLE_RATE };

/** SCORING.md Step 1 winner. Male, to match the Anam persona `Faisal - Cultural Guide`. */
export const DEFAULT_VOICE = process.env.TTS_VOICE || "ar-SA-HamedNeural";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function healthy() {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

let starting = null;

/**
 * Bring the Python TTS sidecar up if it isn't already.
 *
 * Idempotent and safe to call from anywhere: if someone already started it in their
 * own terminal (handy for watching the synthesis log), we attach to that one rather
 * than fighting over the port.
 */
export async function ensureTts({ log = () => {} } = {}) {
  if (await healthy()) return "already running";
  // A previous attempt that finished is not a reason to refuse a new one: the sidecar
  // is a separate process and can die at any point during an event. Without clearing
  // this, the booth would never recover from a crashed sidecar short of a restart.
  starting = null;
  return (starting ??= (async () => {
    log(`starting TTS sidecar on :${PORT}…`);
    const proc = spawn("python", [SERVICE, "--port", String(PORT)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (b) => log(`[tts] ${String(b).trimEnd()}`));
    proc.stderr.on("data", (b) => log(`[tts] ${String(b).trimEnd()}`));
    proc.on("exit", (code) => log(`[tts] exited (${code})`));

    // The sidecar outlives whoever started it, so nothing here may hold the parent's
    // event loop open. Unreffing the child alone is not enough — the three stdio
    // pipes are refed handles of their own, and leaving them attached is why a CLI
    // that finished its work would still hang instead of exiting.
    proc.unref?.();
    for (const s of [proc.stdout, proc.stderr, proc.stdin]) s?.unref?.();

    for (let i = 0; i < 40; i++) {
      if (await healthy()) return "started";
      await sleep(250);
    }
    throw new Error(
      `TTS sidecar did not come up on :${PORT}. Run it manually to see why:\n` +
        `  python server/tts_service.py`,
    );
  })());
}

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
    // No cross-engine fallback. DEFAULT_VOICE is a *Microsoft* voice id, and handing
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
