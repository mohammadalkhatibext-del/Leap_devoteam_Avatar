import { SimliClient, LogLevel } from "simli-client";
import { chunkPcm, resamplePcm } from "../wav.js";

/**
 * Simli — audio-to-video, which is passthrough by definition: Simli has no TTS of its
 * own, so the only thing it ever does is lip-sync audio we hand it. That makes it the
 * cleanest comparison in the bake-off; there is no "agent mode" to accidentally fall
 * into, unlike Anam and HeyGen.
 *
 * Shape of the flow:
 *   POST /compose/token  (x-simli-api-key)  -> session_token   [server side]
 *   new SimliClient(token, video, audio, …) -> WebRTC over LiveKit
 *   sendAudioData(Uint8Array)               -> PCM16 16 kHz mono
 *
 * Two things differ from the other adapters and both matter when reading scores:
 *
 * 1. 16 kHz is mandatory (not a preference). Our fixtures are 24 kHz because HeyGen
 *    LITE mandates *that*, so this adapter resamples. See resamplePcm in wav.js for
 *    why it is a windowed-sinc rather than plain decimation. Simli is therefore the
 *    one renderer not hearing the fixture bit-for-bit — note it when scoring.
 *
 * 2. Simli returns the audio to us over WebRTC and plays it through its own <audio>
 *    element, rather than us playing the fixture locally. So what you hear is what
 *    Simli thinks it lip-synced, which is exactly the thing being judged.
 *
 * Docs: https://docs.simli.com/api-reference/javascript
 *       https://docs.simli.com/api-reference/simli-webrtc  (16 kHz PCM16, 6000-byte chunks)
 */
const SIMLI_RATE = 16000;
/** 6000 bytes is Simli's recommended chunk; at 16 kHz 16-bit that is exactly 187.5 ms. */
const CHUNK_MS = 187.5;

function createSimliAdapter({ name, model }) {
  return {
    name,
    client: null,
    /** Resolved once Simli acknowledges the connection, so speak() can't race start(). */
    ready: false,

    async connect(videoElementId, { log }) {
      const res = await fetch("/api/simli/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || body.detail || JSON.stringify(body));

      const token = body.session_token;
      if (!token) throw new Error(`no session token in response: ${JSON.stringify(body)}`);
      log(`token acquired (model: ${model}), connecting…`);

      const video = document.getElementById(videoElementId);
      // Simli sends audio back as a WebRTC track and needs a real element to play it.
      const audio = document.getElementById("avatar-audio");
      if (!audio) throw new Error('missing <audio id="avatar-audio"> in the page');

      // LogLevel has no WARN — the enum is DEBUG/INFO/ERROR/CRITICAL. ERROR keeps the
      // SDK quiet so the harness log stays readable; the "error" event below still fires.
      this.client = new SimliClient(token, video, audio, null, LogLevel.ERROR, "livekit");

      this.client.on("error", (detail) => log(`simli error: ${detail}`, true));
      this.client.on("stop", () => { this.ready = false; log("simli session stopped"); });

      await this.client.start();
      this.ready = true;
      log("video attached");
    },

    /**
     * Resample off the clock. main.js calls this before it starts timing, so the
     * latency column stays a measure of Simli rather than of our filter.
     */
    prepare(pcm, sampleRate, { log }) {
      if (sampleRate === SIMLI_RATE) return { pcm, sampleRate };

      const t0 = performance.now();
      const out = resamplePcm(pcm, sampleRate, SIMLI_RATE);
      log(`resampled ${sampleRate} → ${SIMLI_RATE} Hz in ${Math.round(performance.now() - t0)} ms (untimed)`);
      return { pcm: out, sampleRate: SIMLI_RATE };
    },

    async speak(pcm, sampleRate, { log }) {
      if (!this.ready) throw new Error("session not connected");
      if (sampleRate !== SIMLI_RATE) {
        // Unreachable via the harness (prepare ran first); a guard so a future caller
        // can't quietly feed Simli the wrong rate and get pitch-shifted lip-sync.
        throw new Error(`Simli requires ${SIMLI_RATE} Hz; got ${sampleRate} Hz`);
      }

      const chunks = chunkPcm(pcm, SIMLI_RATE, CHUNK_MS);
      for (const chunk of chunks) {
        // sendAudioData buffers internally and paces delivery; sending the whole
        // utterance up front is what lets us measure time-to-first-frame.
        this.client.sendAudioData(chunk);
      }
      log(`sent ${chunks.length} chunks`);
    },

    interrupt() {
      // Drops whatever is still buffered — Simli's equivalent of "stop talking now".
      this.client?.ClearBuffer();
    },

    async disconnect() {
      await this.client?.stop();
      this.client = null;
      this.ready = false;
    },
  };
}

/**
 * Simli exposes two lip-sync models on the same face. They are a real fork in the
 * bake-off — same audio, same avatar, different mouth — so both get their own row
 * rather than us guessing which one to trust on Arabic.
 */
export const simliFasttalkAdapter = createSimliAdapter({
  name: "Simli (fasttalk)",
  model: "fasttalk",
});

export const simliArtalkAdapter = createSimliAdapter({
  name: "Simli (artalk)",
  model: "artalk",
});
