import { SimliClient, LogLevel } from "simli-client";
import { chunkPcm, resamplePcm } from "../audio.js";

const SIMLI_RATE = 16000;
/** 6000 bytes is Simli's recommended chunk; at 16 kHz 16-bit that is exactly 187.5 ms. */
const CHUNK_MS = 187.5;

/**
 * Simli — audio-to-video, passthrough by definition: it has no TTS of its own, so the
 * only thing it ever does is lip-sync audio we hand it.
 *
 * Two differences from Anam that matter when judging it:
 *
 * 1. **16 kHz is mandatory.** Our TTS produces 24 kHz, so this adapter resamples with
 *    a windowed-sinc filter (see audio.js). Simli is therefore the one renderer not
 *    hearing our audio bit-for-bit — worth remembering before concluding its Arabic
 *    sounds different from Anam's.
 * 2. **Simli plays the audio back to us** over WebRTC through its own <audio> element,
 *    rather than us playing our clip locally. What you hear is what Simli thinks it
 *    lip-synced, which is exactly the thing being judged.
 *
 * Docs: https://docs.simli.com/api-reference/simli-webrtc
 */
export function simliAdapter() {
  return {
    mode: "pcm",
    client: null,
    ready: false,

    async connect(videoElementId, session, { log }) {
      const video = document.getElementById(videoElementId);
      const audio = document.getElementById("avatar-audio");
      if (!audio) throw new Error('missing <audio id="avatar-audio"> in the page');

      // LogLevel has no WARN — the enum is DEBUG/INFO/ERROR/CRITICAL.
      this.client = new SimliClient(session.token, video, audio, null, LogLevel.ERROR, "livekit");
      this.client.on("error", (detail) => log(`simli error: ${detail}`, true));
      this.client.on("stop", () => {
        this.ready = false;
        log("simli session stopped");
      });

      await this.client.start();
      this.ready = true;
      log("Simli ready");
    },

    begin() {
      /* Simli has no per-utterance sequence to open. */
    },

    push(pcm, { log } = {}) {
      if (!this.ready) return;
      // Our clips arrive at 24 kHz; Simli only accepts 16.
      const resampled = resamplePcm(pcm, 24000, SIMLI_RATE);
      for (const chunk of chunkPcm(resampled, SIMLI_RATE, CHUNK_MS)) {
        this.client.sendAudioData(chunk);
      }
      log?.(`sent ${Math.ceil(resampled.length / 2 / SIMLI_RATE)}s to Simli`);
    },

    end() {
      /* nothing to close per utterance */
    },

    interrupt() {
      // Drops whatever is still buffered — Simli's "stop talking now".
      this.client?.ClearBuffer();
    },

    async disconnect() {
      await this.client?.stop();
      this.client = null;
      this.ready = false;
    },
  };
}
