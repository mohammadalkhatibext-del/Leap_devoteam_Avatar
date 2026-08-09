/**
 * Push-to-talk capture with automatic end-of-speech detection.
 *
 * A booth visitor will not press a button, hold it, speak, and release — they tap
 * once and talk. So recording stops itself: after speech has actually been heard, a
 * stretch of silence ends the clip. The "after speech has been heard" part matters —
 * a visitor typically takes a second to start, and stopping on the leading silence
 * would capture nothing at all.
 *
 * There is no voice-activity model here, just short-window RMS. In a hall with
 * background noise the floor is high, so the threshold is calibrated from the room's
 * own first moments rather than hard-coded.
 */

const SILENCE_MS = 1100; // hang-up delay after the visitor stops talking
const MAX_MS = 15000; // hard cap — nobody asks a booth a 15-second question
const CALIBRATE_MS = 250; // sample the room before deciding what counts as speech
const SPEECH_MARGIN = 2.2; // speech must exceed the noise floor by this factor

export class Mic {
  #media = null;
  #recorder = null;
  #audioCtx = null;
  #raf = 0;

  get recording() {
    return !!this.#recorder && this.#recorder.state === "recording";
  }

  /**
   * Record one utterance.
   * @param {object} handlers
   * @param {(level:number)=>void} [handlers.onLevel]  0..1, for a level meter
   * @param {()=>void} [handlers.onSpeechStart]
   * @returns {Promise<Blob|null>} the clip, or null if nothing was said
   */
  async listen({ onLevel = () => {}, onSpeechStart = () => {} } = {}) {
    this.#media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });

    this.#audioCtx = new AudioContext();
    const source = this.#audioCtx.createMediaStreamSource(this.#media);
    const analyser = this.#audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    const chunks = [];
    this.#recorder = new MediaRecorder(this.#media);
    this.#recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    this.#recorder.start();

    const startedAt = performance.now();
    let noiseFloor = 0.01;
    let calibrationSamples = 0;
    let speechSeen = false;
    let lastLoudAt = startedAt;

    const stopped = new Promise((resolve) => {
      this.#recorder.onstop = () => resolve();
    });

    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const s of buf) sum += s * s;
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();
      const elapsed = now - startedAt;

      if (elapsed < CALIBRATE_MS) {
        // Rolling average of the room before anyone speaks.
        noiseFloor = (noiseFloor * calibrationSamples + rms) / (calibrationSamples + 1);
        calibrationSamples++;
      } else {
        const threshold = Math.max(noiseFloor * SPEECH_MARGIN, 0.012);
        if (rms > threshold) {
          if (!speechSeen) {
            speechSeen = true;
            onSpeechStart();
          }
          lastLoudAt = now;
        }
        // Only hang up once the visitor has actually said something.
        if (speechSeen && now - lastLoudAt > SILENCE_MS) return this.stop();
      }

      onLevel(Math.min(1, rms * 12));
      if (elapsed > MAX_MS) return this.stop();
      this.#raf = requestAnimationFrame(tick);
    };
    this.#raf = requestAnimationFrame(tick);

    await stopped;
    this.#teardown();

    if (!speechSeen || !chunks.length) return null;
    return new Blob(chunks, { type: this.#recorder?.mimeType || "audio/webm" });
  }

  stop() {
    cancelAnimationFrame(this.#raf);
    if (this.#recorder?.state === "recording") this.#recorder.stop();
  }

  #teardown() {
    cancelAnimationFrame(this.#raf);
    this.#media?.getTracks().forEach((t) => t.stop());
    this.#audioCtx?.close();
    this.#media = null;
    this.#audioCtx = null;
  }
}
