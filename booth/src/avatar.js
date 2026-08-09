import { createClient } from "@anam-ai/js-sdk";
import { chunkPcm, toBase64 } from "./audio.js";

/**
 * Anam, in audio-passthrough mode: we supply the samples, Anam only lip-syncs.
 *
 * The booth deliberately keeps ONE audio stream open per answer rather than one per
 * sentence. An answer is a single utterance that happens to be synthesised in pieces;
 * opening and closing a sequence per sentence would tell the renderer the speech ended
 * four times in fifteen seconds, and the avatar would settle back to idle between
 * clauses. Passing `endSequence()` only when the answer is genuinely finished is what
 * keeps the delivery continuous.
 *
 * Docs: https://anam.ai/docs/javascript-sdk/examples/custom-tts
 */
export const avatar = {
  client: null,
  stream: null,
  rate: null,
  speaking: false,

  async connect(videoElementId, { log }) {
    const res = await fetch("/api/anam/token", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || JSON.stringify(body));

    const token = body.sessionToken ?? body.session_token;
    if (!token) throw new Error(`no session token: ${JSON.stringify(body)}`);

    log("token acquired, connecting…");
    // No mic input: the browser captures audio itself for STT, and the avatar is
    // driven purely by the PCM we push.
    this.client = createClient(token, { disableInputAudio: true });
    await this.client.streamToVideoElement(videoElementId);
    log("avatar ready");
  },

  /** Open the audio sequence for one answer. */
  begin(sampleRate, { log }) {
    if (!this.stream || this.rate !== sampleRate) {
      this.stream = this.client.createAgentAudioInputStream({
        encoding: "pcm_s16le",
        sampleRate,
        channels: 1,
      });
      this.rate = sampleRate;
      log(`audio stream open @ ${sampleRate} Hz`);
    }
    this.speaking = true;
  },

  /** Push one synthesised clip into the open sequence. */
  push(pcm) {
    if (!this.stream) return;
    for (const chunk of chunkPcm(pcm, this.rate, 200)) {
      this.stream.sendAudioChunk(toBase64(chunk));
    }
  },

  /** Mark the answer finished so the avatar can return to a natural idle. */
  end() {
    this.stream?.endSequence();
    this.speaking = false;
  },

  interrupt() {
    this.client?.interruptPersona();
    this.speaking = false;
  },

  async disconnect() {
    this.client?.stopStreaming();
    this.client = null;
    this.stream = null;
    this.rate = null;
    this.speaking = false;
  },
};
