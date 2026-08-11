/**
 * What can my HeyGen key actually do?  →  node scripts/check-heygen.mjs
 *
 * "HeyGen" is three different products with three different keys, and they look
 * identical in .env. This tells you which one you have, because the failure mode is
 * otherwise baffling: a key that is genuinely valid, that HeyGen's dashboard shows as
 * active, and that returns a bare HTML 404 from the endpoints the booth needs.
 *
 *   1. Video generation API  (api.heygen.com/v2/*)      — makes MP4s. Useless here:
 *                                                          the booth needs realtime.
 *   2. Interactive/Streaming (api.heygen.com/v1/streaming.*)
 *                                                        — realtime, needs to be
 *                                                          enabled on the account.
 *   3. LiveAvatar            (api.liveavatar.com/v1/*)  — realtime, SEPARATE signup
 *                                                          and a separate key. This
 *                                                          is what harness/src/
 *                                                          adapters/heygen.js targets.
 *
 * Only 2 and 3 can drive an avatar at a booth. A key for 1 answers 200 on /v2/avatars
 * and 404 on everything realtime — HeyGen returns an HTML 404 rather than a JSON 403
 * when a product is not on the account, so "404" here means "not entitled", not
 * "wrong URL". That distinction is the whole reason this script exists.
 *
 * Every call below is free. Nothing here starts a session.
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
  fail(`\n  ✗ No .env found at ${ENV}\n`);
}

const key = process.exitCode ? null : process.env.HEYGEN_API_KEY;
const avatarId = process.env.HEYGEN_AVATAR_ID;

if (!process.exitCode && !key) fail(`\n  ✗ .env was read, but HEYGEN_API_KEY is empty.\n`);

/** HeyGen serves an HTML 404 page for products the account is not entitled to. */
const isHtml = (t) => t.trimStart().startsWith("<");

if (key) {
  console.log(`\n  .env       ${ENV}`);
  console.log(`  key        ${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`);
  console.log(`  avatar     ${avatarId || "(HEYGEN_AVATAR_ID not set)"}`);
  if (key !== key.trim()) console.log(`\n  ⚠ key has leading/trailing whitespace`);

  const can = { video: false, streaming: false, liveavatar: false };

  /* ------------------------------------------------- 1. video generation API */

  const av = await fetch("https://api.heygen.com/v2/avatars", { headers: { "X-Api-Key": key } });
  const avBody = await av.json().catch(() => ({}));
  const avatars = avBody?.data?.avatars ?? [];
  const interactive = avBody?.data?.interactive_avatars ?? [];
  can.video = av.ok;
  console.log(`\n  Video generation API (api.heygen.com/v2)`);
  console.log(`    ${av.ok ? "✓" : "✗"} /v2/avatars — HTTP ${av.status}` + (av.ok ? `, ${avatars.length} avatars` : ""));

  /* ---------------------------------------------- 2. interactive / streaming */

  console.log(`\n  Interactive / Streaming API (api.heygen.com/v1/streaming.*)`);
  console.log(`    ${interactive.length ? "✓" : "✗"} interactive_avatars on this account: ${interactive.length}`);
  for (const p of ["/v1/streaming.create_token", "/v1/streaming-auth/token"]) {
    const r = await fetch(`https://api.heygen.com${p}`, {
      method: "POST",
      headers: { "X-Api-Key": key, "Content-Type": "application/json" },
      body: "{}",
    });
    const t = await r.text();
    const html = isHtml(t);
    if (r.ok) can.streaming = true;
    console.log(
      `    ${r.ok ? "✓" : "✗"} POST ${p} — HTTP ${r.status}` +
        (html ? "  (HTML page — product not enabled on this account)" : `  ${t.slice(0, 90).replace(/\s+/g, " ")}`),
    );
  }

  /* --------------------------------------------------------- 3. LiveAvatar */

  console.log(`\n  LiveAvatar (api.liveavatar.com — separate product, separate key)`);
  const la = await fetch("https://api.liveavatar.com/v1/sessions/token", {
    method: "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "lite", avatar_id: avatarId }),
  });
  const laBody = await la.json().catch(() => ({}));
  can.liveavatar = la.ok && !!laBody?.data?.session_token;
  console.log(
    `    ${can.liveavatar ? "✓" : "✗"} POST /v1/sessions/token — HTTP ${la.status}  ` +
      `${JSON.stringify(laBody).slice(0, 90)}`,
  );

  /* ------------------------------------------------------ avatar id sanity */

  if (avatarId && can.video) {
    const hit = avatars.find((a) => a.avatar_id === avatarId);
    const ihit = interactive.find((a) => (a.avatar_id ?? a.id) === avatarId);
    console.log(`\n  HEYGEN_AVATAR_ID ${avatarId}`);
    console.log(`    ${hit ? `✓ in the video avatar list — "${hit.avatar_name}"` : "✗ not in the video avatar list"}`);
    console.log(`    ${ihit ? "✓ in the interactive avatar list" : "✗ not in the interactive avatar list"}`);
    if (!hit && !ihit) {
      console.log(`    An id from a docs example or another account looks exactly like a`);
      console.log(`    real one and fails only at session time. Pick one from this account.`);
    }
  }

  /* ---------------------------------------------------------- the verdict */

  console.log(`\n  ${"─".repeat(66)}`);
  if (can.liveavatar || can.streaming) {
    console.log(`  ✓ This key can drive a realtime avatar.`);
    console.log(`    ${can.liveavatar ? "LiveAvatar" : "Interactive/Streaming"} is available — the booth can use it.\n`);
  } else if (can.video) {
    fail(
      `  ✗ This key is a VIDEO GENERATION key. It cannot drive a booth avatar.`,
      ``,
      `    It is not invalid — /v2/avatars answered 200 — it simply belongs to the`,
      `    product that renders MP4s offline. The booth needs a realtime stream, and`,
      `    every realtime endpoint returned an HTML 404, which is how HeyGen says`,
      `    "not on this account" rather than "wrong URL".`,
      ``,
      `    To get one that works, one of:`,
      `      • Enable the Interactive Avatar / Streaming API on this HeyGen account`,
      `        (pay-as-you-go credits), then re-run this script — the key may be the`,
      `        same one, with the endpoints simply starting to answer.`,
      `      • Sign up separately at liveavatar.com for a LiveAvatar key, which is`,
      `        what harness/src/adapters/heygen.js was written against.`,
      ``,
      `    Until then Anam and Akool are the working renderers.\n`,
    );
  } else {
    fail(
      `  ✗ This key was rejected everywhere, including /v2/avatars.`,
      `    Check it was copied whole, from the right account, and not regenerated.\n`,
    );
  }
}
