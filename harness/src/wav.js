/**
 * Minimal WAV reader. Walks RIFF chunks properly rather than assuming a 44-byte
 * header — Azure's output can carry extra chunks (LIST/fact) before `data`, and
 * a fixed offset would slice audio into the middle of a sample.
 */
export function parseWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const tag = (off) => String.fromCharCode(...new Uint8Array(arrayBuffer, off, 4));

  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a RIFF/WAVE file");

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset + 8 <= view.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      data = new Uint8Array(arrayBuffer, body, Math.min(size, view.byteLength - body));
    }

    offset = body + size + (size % 2); // RIFF chunks are word-aligned
  }

  if (!fmt || !data) throw new Error("missing fmt or data chunk");
  if (fmt.format !== 1 || fmt.bitsPerSample !== 16 || fmt.channels !== 1) {
    throw new Error(
      `expected 16-bit mono PCM, got format=${fmt.format} bits=${fmt.bitsPerSample} ch=${fmt.channels}`,
    );
  }

  return { pcm: data, sampleRate: fmt.sampleRate, durationMs: (data.length / 2 / fmt.sampleRate) * 1000 };
}

/**
 * Split PCM into ~`ms` slices on a sample boundary.
 * HeyGen recommends ~1 s chunks and caps a packet at 1 MB; chunking also lets the
 * renderer start animating before the whole utterance has arrived, which is what
 * we're measuring.
 */
export function chunkPcm(pcm, sampleRate, ms = 200) {
  const bytesPerChunk = Math.floor((sampleRate * 2 * ms) / 1000) & ~1; // even = whole samples
  const chunks = [];
  for (let i = 0; i < pcm.length; i += bytesPerChunk) {
    chunks.push(pcm.subarray(i, Math.min(i + bytesPerChunk, pcm.length)));
  }
  return chunks;
}

/** Base64 without blowing the call stack on large buffers. */
export function toBase64(bytes) {
  let binary = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    binary += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(binary);
}
