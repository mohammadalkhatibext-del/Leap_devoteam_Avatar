import { createClient } from "@anam-ai/js-sdk";
import { chunkPcm, toBase64 } from "../audio.js";

/**
 * Anam — audio passthrough. We supply the samples, Anam only lip-syncs.
 *
 * ONE audio stream per answer, not per sentence. An answer is a single utterance that
 * happens to be synthesised in pieces; opening and closing a sequence per sentence
 * would tell the renderer speech ended four times in fifteen seconds, and the avatar
 * would settle back to idle between clauses.
 *
 * Docs: https://anam.ai/docs/javascript-sdk/examples/custom-tts
 */
export function anamAdapter() {
  return {
    mode: "pcm",
    client: null,
    stream: null,
    rate: null,

    async connect(videoElementId, session, { log }) {
      this.client = createClient(session.token, { disableInputAudio: true });
      await this.client.streamToVideoElement(videoElementId);
      log("Anam ready");
    },

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
    },

    push(pcm) {
      if (!this.stream) return;
      for (const chunk of chunkPcm(pcm, this.rate, 200)) {
        this.stream.sendAudioChunk(toBase64(chunk));
      }
    },

    end() {
      this.stream?.endSequence();
    },

    interrupt() {
      this.client?.interruptPersona();
    },

    async disconnect() {
      this.client?.stopStreaming();
      this.client = null;
      this.stream = null;
      this.rate = null;
    },
  };
}
