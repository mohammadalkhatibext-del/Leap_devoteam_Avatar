/**
 * Try every voice the admin page offers, and report which actually produce audio.
 *
 *   node scripts/voice-check.mjs          # all Arabic + English
 *   node scripts/voice-check.mjs ar       # one language
 *
 * Why this exists: the picker is populated from Microsoft's published voice
 * catalogue, but we reach those voices through the unofficial edge-tts endpoint. The
 * catalogue is therefore a list of voices that *should* exist, not a list that is
 * known to work — and an operator discovering a dead voice at a booth is the worst
 * possible time to find out. This turns the list into a tested one.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
process.loadEnvFile(path.join(ROOT, ".env"));

const PORT = Number(process.env.TTS_PORT || 8765);
const BASE = `http://127.0.0.1:${PORT}`;

// Short, real phrases — a voice that mangles Arabic script would still "pass" on a
// single word, and the point is whether it can speak a booth sentence.
const PROBE = {
  ar: "ديفوتيم شركة استشارات تقنية.",
  en: "Devoteam is a technology consultancy.",
};

const only = process.argv[2];

const health = await fetch(`${BASE}/health`).catch(() => null);
if (!health?.ok) {
  console.error(`\n  TTS sidecar is not running on :${PORT}.\n  Start it:  python server/tts_service.py\n`);
  process.exit(1);
}

const { voices } = await fetch(`${BASE}/voices`).then((r) => r.json());
const list = voices.filter((v) => !only || v.language === only);

console.log(`\nTesting ${list.length} voices through the edge-tts endpoint…\n`);

/** Bounded concurrency: enough to be quick, not enough to look like abuse. */
const LIMIT = 6;
const results = [];
let cursor = 0;

async function worker() {
  while (cursor < list.length) {
    const v = list[cursor++];
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}/tts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: PROBE[v.language], voice: v.id }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        results.push({ ...v, ok: false, why: `${res.status} ${detail.slice(0, 90)}` });
        continue;
      }
      const bytes = (await res.arrayBuffer()).byteLength;
      const secs = bytes / 2 / 24000;
      // A 200 with almost no audio is a silent failure — the voice answered but said
      // nothing, which at a booth looks exactly like the avatar being broken.
      results.push(
        secs < 0.4
          ? { ...v, ok: false, why: `returned only ${secs.toFixed(2)}s of audio` }
          : { ...v, ok: true, secs, ms: Date.now() - t0 },
      );
    } catch (err) {
      results.push({ ...v, ok: false, why: err.message });
    }
  }
}

await Promise.all(Array.from({ length: LIMIT }, worker));
results.sort((a, b) => a.id.localeCompare(b.id));

for (const lang of ["ar", "en"]) {
  const group = results.filter((r) => r.language === lang);
  if (!group.length) continue;
  const bad = group.filter((r) => !r.ok);
  console.log(`── ${lang.toUpperCase()}  ${group.length - bad.length}/${group.length} working`);
  for (const r of bad) console.log(`   FAIL  ${r.id.padEnd(30)} ${r.why}`);
  if (!bad.length) console.log("   all working");
  console.log();
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `${failed.length} voice(s) are listed but do not work — avoid them in the admin picker.\n`
    : "Every listed voice works.\n",
);
