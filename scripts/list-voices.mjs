#!/usr/bin/env node
/**
 * List the ElevenLabs voices available on your account, with their IDs.
 *
 *   node scripts/list-voices.mjs
 *
 * Copy the id of an Arabic-capable voice into ELEVENLABS_VOICE_ID in .env.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error("ELEVENLABS_API_KEY not set in .env");
  process.exit(1);
}

const res = await fetch("https://api.elevenlabs.io/v1/voices", {
  headers: { "xi-api-key": key },
});
if (!res.ok) {
  console.error(`ElevenLabs ${res.status}: ${await res.text()}`);
  process.exit(1);
}

const { voices = [] } = await res.json();
if (!voices.length) {
  console.log("\nNo voices on this account yet — add one from the Voice Library first.\n");
  process.exit(0);
}

console.log(`\n${voices.length} voice(s):\n`);
for (const v of voices) {
  const labels = Object.values(v.labels ?? {}).filter(Boolean).join(", ");
  console.log(`  ${v.voice_id}   ${v.name}`);
  if (labels) console.log(`  ${" ".repeat(v.voice_id.length)}   ${labels}`);
}

console.log(`\nPaste one into .env:  ELEVENLABS_VOICE_ID=<id>\n`);
