/** Base64 -> bytes, without blowing the call stack on large buffers. */
export function fromBase64(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Bytes -> base64, chunked for the same reason. */
export function toBase64(bytes) {
  let binary = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}

/**
 * Split PCM into ~`ms` slices on a sample boundary.
 * The renderer starts animating before the whole utterance has arrived, which is the
 * entire reason the booth feels responsive rather than turn-based.
 */
export function chunkPcm(pcm, sampleRate, ms = 200) {
  const bytesPerChunk = Math.floor((sampleRate * 2 * ms) / 1000) & ~1; // even = whole samples
  const chunks = [];
  for (let i = 0; i < pcm.length; i += bytesPerChunk) {
    chunks.push(pcm.subarray(i, Math.min(i + bytesPerChunk, pcm.length)));
  }
  return chunks;
}

export const durationMs = (pcm, sampleRate) => (pcm.length / 2 / sampleRate) * 1000;

/**
 * Resample 16-bit mono PCM between rates, band-limited.
 *
 * Our TTS produces 24 kHz because that is what Anam and the Phase 0 fixtures use;
 * Simli mandates exactly 16 kHz. Something has to convert, so the conversion has to
 * be honest — a naive "drop every third sample" decimation folds everything above
 * 8 kHz back down as aliasing, and in Arabic that lands squarely on the sibilants
 * (س ش ص ث). Judging a renderer's mouth shapes on audio our own resampler corrupted
 * would make the comparison meaningless.
 *
 * Windowed-sinc interpolation, low-pass cutoff set by the lower of the two rates,
 * which band-limits and interpolates in one pass.
 */
export function resamplePcm(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;

  // Read through a DataView: `pcm` may be a view whose byteOffset does not satisfy
  // Int16Array's 2-byte alignment requirement.
  const src = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const inLen = Math.floor(pcm.byteLength / 2);
  const outLen = Math.floor((inLen * toRate) / fromRate);
  const step = fromRate / toRate;

  // Cutoff in cycles per *input* sample. 0.95 leaves a transition band rather than
  // ringing right at the edge.
  const fc = 0.5 * Math.min(1, toRate / fromRate) * 0.95;
  const half = Math.max(4, Math.ceil(12 / (2 * fc)));

  const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
  const out = new Uint8Array(outLen * 2);
  const dst = new DataView(out.buffer);

  for (let i = 0; i < outLen; i++) {
    const center = i * step;
    const first = Math.ceil(center - half);
    const last = Math.floor(center + half);

    let acc = 0;
    let norm = 0;
    for (let j = first; j <= last; j++) {
      if (j < 0 || j >= inLen) continue;
      const t = j - center;
      // Blackman window — kills the sidelobes that would show as a faint lisp.
      const w =
        0.42 + 0.5 * Math.cos((Math.PI * t) / half) + 0.08 * Math.cos((2 * Math.PI * t) / half);
      const h = 2 * fc * sinc(2 * fc * t) * w;
      acc += src.getInt16(j * 2, true) * h;
      norm += h;
    }

    // Normalising by the realised tap sum keeps the level flat at the clip edges.
    const v = norm > 0 ? acc / norm : 0;
    dst.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(v))), true);
  }

  return out;
}
