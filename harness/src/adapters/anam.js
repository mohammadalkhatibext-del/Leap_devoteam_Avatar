import { createClient } from "@anam-ai/js-sdk";
import { chunkPcm, toBase64 } from "../wav.js";

/**
 * Anam — audio passthrough.
 * Server mints a token with personaConfig.enableAudioPassthrough = true; the client
 * disables input audio (we're not using a mic) and pushes our own PCM.
 *
 * Docs: https://anam.ai/docs/javascript-sdk/examples/custom-tts
 */
export const anamAdapter = {
  name: "Anam",
  client: null,
  stream: null,
  rate: null,

  async connect(videoElementId, { log }) {
    const res = await fetch("/api/anam/token", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || JSON.stringify(body));

    const token = body.sessionToken ?? body.session_token;
    if (!token) throw new Error(`no session token in response: ${JSON.stringify(body)}`);

    log("token acquired, connecting…");
    this.client = createClient(token, { disableInputAudio: true });
    await this.client.streamToVideoElement(videoElementId);
    log("video attached");
  },

  async speak(pcm, sampleRate, { log }) {
    // Anam takes the rate as a parameter, so we pass the fixture's own rate through
    // rather than resampling — the renderers must hear identical audio.
    if (!this.stream || this.rate !== sampleRate) {
      this.stream = this.client.createAgentAudioInputStream({
        encoding: "pcm_s16le",
        sampleRate,
        channels: 1,
      });
      this.rate = sampleRate;
      log(`audio stream opened @ ${sampleRate} Hz`);
    }

    for (const chunk of chunkPcm(pcm, sampleRate, 200)) {
      this.stream.sendAudioChunk(toBase64(chunk));
    }
    this.stream.endSequence();
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
