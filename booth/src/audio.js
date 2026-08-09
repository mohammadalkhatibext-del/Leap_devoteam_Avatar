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
