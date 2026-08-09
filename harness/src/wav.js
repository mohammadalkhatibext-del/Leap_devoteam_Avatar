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

/**
 * Resample 16-bit mono PCM between rates, band-limited.
 *
 * Needed because the renderers disagree and no single fixture rate satisfies both:
 * HeyGen LITE demands exactly 24 kHz, Simli demands exactly 16 kHz. Something has to
 * convert, so the conversion has to be honest — a naive "drop every third sample"
 * decimation folds everything above 8 kHz back down as aliasing, and in Arabic that
 * lands squarely on the sibilants (س ش ص ث) whose mouth shapes phrases 04 and 07 exist
 * to test. Scoring a renderer down for a mouth shape our own resampler corrupted would
 * invalidate the bake-off.
 *
 * So: windowed-sinc interpolation with the low-pass cutoff set by the *lower* of the
 * two rates, which band-limits and interpolates in one pass.
 */
export function resamplePcm(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;

  // Read through a DataView: `pcm` is a view into the file's ArrayBuffer and its
  // byteOffset is not guaranteed to satisfy Int16Array's 2-byte alignment.
  const src = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const inLen = Math.floor(pcm.byteLength / 2);
  const outLen = Math.floor((inLen * toRate) / fromRate);
  const step = fromRate / toRate;

  // Cutoff in cycles per *input* sample. Downsampling must cut at the output Nyquist;
  // upsampling needs no extra filtering. 0.95 leaves a little transition band rather
  // than ringing right at the edge.
  const fc = 0.5 * Math.min(1, toRate / fromRate) * 0.95;
  // Kernel width in input samples: enough taps for ~12 sinc lobes at this cutoff.
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
      // Blackman window over the kernel span — kills the sidelobes that would
      // otherwise show up as a faint lisp on fricatives.
      const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / half) + 0.08 * Math.cos((2 * Math.PI * t) / half);
      const h = 2 * fc * sinc(2 * fc * t) * w;
      acc += src.getInt16(j * 2, true) * h;
      norm += h;
    }

    // Normalising by the realised tap sum keeps the level flat at the clip edges,
    // where the kernel is truncated.
    const v = norm > 0 ? acc / norm : 0;
    dst.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(v))), true);
  }

  return out;
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
