/**
 * Is my Simli key + face actually working?  →  node scripts/check-simli.mjs
 *
 * Simli is the opposite of Anam in one useful way and the same in one dangerous way.
 *
 *   Useful:    /compose/token with apiVersion "v2" really does validate the faceId,
 *              returning 400 INVALID_FACE_ID. So unlike Anam, a green result here
 *              means the face is genuinely on this account — not merely well-formed.
 *
 *   Dangerous: Simli returns a `session_token` field EVEN ON FAILURE. A 401 with a
 *              bad key still hands back a token-shaped string. Any check written as
 *              `if (body.session_token) ok()` passes with a completely invalid key,
 *              and you don't find out until the video never arrives. Always read the
 *              status code, never the token's presence.
 *
 * Prints a fingerprint rather than the key, so the output is safe to paste into chat.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV = path.join(ROOT, ".env");

// Node on Windows aborts with a libuv assertion if process.exit() runs while the
// fetch's handles are still closing, so every exit here goes through exitCode.
const fail = (...lines) => {
  console.error(lines.join("\n"));
  process.exitCode = 1;
};

try {
  process.loadEnvFile(ENV);
} catch {
  fail(
    `\n  ✗ No .env found at ${ENV}`,
    `    It belongs at the repo root — not in harness/.`,
    `    On Windows, check Explorer didn't save it as ".env.txt"`,
    `    (File > Save as > "All files", or: ren .env.txt .env)\n`,
  );
}

const key = process.exitCode ? null : process.env.SIMLI_API_KEY;
const faceId = process.env.SIMLI_FACE_ID;

if (!process.exitCode && !key) fail(`\n  ✗ .env was read, but SIMLI_API_KEY is empty.\n`);
if (key && !faceId) {
  fail(
    `\n  ✗ SIMLI_FACE_ID is not set in .env.`,
    `    Preset faces: https://docs.simli.com/api-reference/preset-faces\n`,
  );
}

if (key && faceId) {
  console.log(`\n  .env       ${ENV}`);
  console.log(`  key        ${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`);
  console.log(`  faceId     ${faceId}`);

  // The two ways a correct key still gets rejected — both invisible when you look at it.
  if (key !== key.trim()) console.log(`\n  ⚠ key has leading/trailing whitespace`);
  if (/^bearer\s/i.test(key)) {
    console.log(`\n  ⚠ key starts with "Bearer " — Simli authenticates with the`);
    console.log(`    x-simli-api-key header, so paste only the key itself.`);
  }

  const res = await fetch("https://api.simli.ai/compose/token", {
    method: "POST",
    headers: { "x-simli-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      faceId,
      apiVersion: "v2", // the version that validates faceId — see header comment
      handleSilence: true,
      maxSessionLength: 600,
      maxIdleTime: 300,
    }),
  });
  const body = await res.json().catch(() => ({}));

  if (res.ok) {
    console.log(`\n  ✓ HTTP 200 — key works and the face is valid on this account.`);
    console.log(`  ✓ token minted (${String(body.session_token ?? "").length} chars)`);

    // Both models accept the same face; which one lip-syncs Arabic better is exactly
    // what the harness is for, so confirm up front that both are actually reachable.
    for (const model of ["fasttalk", "artalk"]) {
      const r = await fetch("https://api.simli.ai/compose/token", {
        method: "POST",
        headers: { "x-simli-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({ faceId, apiVersion: "v2", model }),
      });
      console.log(`  ${r.ok ? "✓" : "✗"} model "${model}" — HTTP ${r.status}`);
    }
    console.log(`\n  Next: npm run harness  →  pick "Simli" in the renderer dropdown.\n`);
  } else if (body.detail === "INVALID_API_KEY" || res.status === 401) {
    fail(
      `\n  ✗ HTTP ${res.status} — ${body.detail ?? JSON.stringify(body)}`,
      `\n    Simli rejected the key. Check, in this order:`,
      `      1. Copied whole and from the right account — app.simli.com`,
      `      2. Not revoked or regenerated since you pasted it`,
      `      3. No quotes and no trailing spaces in .env\n`,
    );
  } else if (body.detail === "INVALID_FACE_ID") {
    fail(
      `\n  ✗ HTTP ${res.status} — INVALID_FACE_ID`,
      `\n    The key is fine; "${faceId}" is not a face this account can use.`,
      `    Simli's preset faces (usable by any account) are listed at:`,
      `      https://docs.simli.com/api-reference/preset-faces`,
      `    Custom faces trained on this account: GET https://api.simli.ai/faces\n`,
    );
  } else {
    fail(
      `\n  ✗ HTTP ${res.status} — ${JSON.stringify(body)}`,
      `\n    Unexpected — paste this output when asking for help.\n`,
    );
  }
}
