/**
 * Is my Akool subscription actually working?  →  node scripts/check-akool.mjs
 *
 * Run this FIRST, before the booth, on a brand new Akool key. Everything on the Akool
 * path in this repo was written from documentation alone — no key existed here to test
 * against — so there are four open guesses, and this script settles all four in one
 * ~60-second session instead of discovering them one at a time in front of a visitor:
 *
 *   1. Which avatar-list endpoint a live account answers on (two documented candidates)
 *   2. What the stream credentials are actually called (`livekit_url` vs bare `url`)
 *   3. Whether session/close is the right endpoint, and which id field it wants
 *   4. Whether closing early actually refunds — the entire cost model rests on this
 *
 * WHY THE CLOSE MATTERS MORE THAN THE CONNECT
 * Akool pre-charges the whole requested window at create time and refunds the unused
 * remainder only when the session is closed. A session you opened and walked away from
 * bills in full. So this script opens the shortest window it can and closes it in a
 * `finally` — if it crashes halfway, it still closes. Check your credit balance before
 * and after: that difference is the real answer to "what does a visitor cost?", and no
 * amount of reading Akool's pricing page substitutes for it.
 *
 * Prints a fingerprint rather than the credential, so the output is safe to paste.
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

const apiKey = process.env.AKOOL_API_KEY;
const clientId = process.env.AKOOL_CLIENT_ID;
const clientSecret = process.env.AKOOL_CLIENT_SECRET;
const avatarId = process.env.AKOOL_AVATAR_ID;

if (!process.exitCode && !apiKey && !(clientId && clientSecret)) {
  fail(
    `\n  ✗ .env was read, but no Akool credential is set.`,
    `    Set either AKOOL_API_KEY, or AKOOL_CLIENT_ID + AKOOL_CLIENT_SECRET.`,
    `    Which one you get depends on your plan — either is fine.\n`,
  );
}

if (!process.exitCode) {
  console.log(`\n  .env       ${ENV}`);
  const shown = apiKey ?? clientId;
  console.log(
    `  credential ${apiKey ? "AKOOL_API_KEY" : "AKOOL_CLIENT_ID"} ` +
      `${shown.slice(0, 4)}…${shown.slice(-4)} (${shown.length} chars)`,
  );
  console.log(`  avatar     ${avatarId || "(not set — will list what the account has)"}`);

  // The two ways a correct credential still gets rejected — both invisible on screen.
  if (shown !== shown.trim()) console.log(`\n  ⚠ credential has leading/trailing whitespace`);
  if (/^bearer\s/i.test(shown)) {
    console.log(`\n  ⚠ credential starts with "Bearer " — paste only the value itself.`);
  }

  /* ------------------------------------------------------------------- 1. auth */

  let auth = null;
  if (apiKey) {
    auth = { header: "x-api-key", value: apiKey };
    console.log(`\n  → using AKOOL_API_KEY directly (no token exchange)`);
  } else {
    const r = await fetch("https://openapi.akool.com/api/open/v3/getToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, clientSecret }),
    });
    const body = await r.json().catch(() => ({}));
    const token = body?.token ?? body?.data?.token;
    if (!r.ok || !token) {
      fail(
        `\n  ✗ getToken failed — HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`,
        `\n    The clientId/clientSecret pair was rejected. Check both are from the`,
        `    same Akool account and neither has been regenerated.\n`,
      );
    } else {
      auth = { header: "Authorization", value: `Bearer ${token}` };
      console.log(`\n  ✓ getToken — exchanged for a bearer token (${token.length} chars)`);
    }
  }

  /* ------------------------------------------------- 2. which list path answers */

  if (auth) {
    console.log(`\n  Avatar list — trying both documented paths:`);
    let workingPath = null;
    for (const p of [
      "https://openapi.akool.com/api/open/v4/liveAvatar/avatar/list",
      "https://openapi.akool.com/api/open/v3/avatar/list",
    ]) {
      try {
        const r = await fetch(p, { headers: { [auth.header]: auth.value } });
        const body = await r.json().catch(() => ({}));
        const rows = body.data?.result ?? body.data?.list ?? body.data ?? [];
        const n = Array.isArray(rows) ? rows.length : 0;
        console.log(`    ${r.ok && n ? "✓" : "·"} HTTP ${r.status}  ${n} avatars  ${p.replace("https://openapi.akool.com", "")}`);
        if (r.ok && n && !workingPath) {
          workingPath = p;
          for (const a of rows.slice(0, 5)) {
            console.log(`        ${a.avatar_id ?? a._id ?? a.id}  ${a.name ?? ""}`);
          }
          if (n > 5) console.log(`        … and ${n - 5} more`);
        }
      } catch (err) {
        console.log(`    ✗ ${p} — ${err.message}`);
      }
    }
    if (workingPath) {
      console.log(`\n  → the booth uses the v4 liveAvatar path, and only that one.`);
      console.log(`    Both endpoints answer, but they are not the same list: v4 returns`);
      console.log(`    the avatars that can STREAM, v3 the general catalogue. An id from`);
      console.log(`    v3 looks perfectly valid and then fails at session/create — so if`);
      console.log(`    your AKOOL_AVATAR_ID is missing from the v4 list above, that is the`);
      console.log(`    bug, however right it looks in the Akool dashboard.`);
    } else {
      console.log(`\n  ⚠ neither path returned avatars. Not fatal — you can still paste an`);
      console.log(`    avatar id by hand — but the admin picker will stay empty.`);
    }

    /* ------------------------------------------- 3. create, inspect, and close */

    // Auth and listing are free; creating a session is not. `--no-session` stops here,
    // so a key can be validated — and a typo'd avatar id caught — for nothing, which is
    // the run you want before the first billed one rather than after it.
    const billedRun = !process.argv.includes("--no-session");

    if (!billedRun) {
      console.log(`\n  ⊘ Stopping before the session test (--no-session).`);
      console.log(`    Everything above was free. Re-run without the flag to open and`);
      console.log(`    close one real ${"60"}s session and measure the refund.\n`);
    } else if (!avatarId) {
      console.log(`\n  ⊘ Skipping the session test: AKOOL_AVATAR_ID is not set in .env.`);
      console.log(`    Pick an id from the list above, add it, and re-run.\n`);
    } else {
      // The shortest window worth asking for. This is a test, not a conversation, and
      // an un-refunded minute is the cheapest possible way to be wrong about the refund.
      const DURATION = 60;
      console.log(`\n  Creating a ${DURATION}s session on avatar ${avatarId}…`);
      console.log(`  (note your credit balance now — compare it after this exits)`);

      let sessionId = null;
      try {
        const r = await fetch("https://openapi.akool.com/api/open/v4/liveAvatar/session/create", {
          method: "POST",
          headers: { [auth.header]: auth.value, "Content-Type": "application/json" },
          body: JSON.stringify({ avatar_id: avatarId, duration: DURATION, stream_type: "livekit" }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok || (body.code && body.code !== 1000)) {
          fail(
            `\n  ✗ session/create failed — HTTP ${r.status} ${JSON.stringify(body).slice(0, 300)}`,
            `\n    Common causes: no credits on the plan, an avatar id that is not a`,
            `    *streaming* avatar, or streaming not enabled for this subscription.\n`,
          );
        } else {
          const data = body.data ?? body;
          sessionId = data._id ?? data.id ?? null;
          console.log(`  ✓ session created — id ${sessionId}`);
          console.log(`    stream_type: ${data.stream_type ?? "(absent)"}`);

          // The guess that broke the adapter once already. Print the real field names.
          const c = data.credentials ?? {};
          console.log(`    credentials fields: ${Object.keys(c).join(", ") || "(none!)"}`);
          const url = c.livekit_url ?? c.url;
          const token = c.livekit_token ?? c.token;
          console.log(`    ${url ? "✓" : "✗"} url    ${url ? `${String(url).slice(0, 40)}…` : "NOT FOUND"}`);
          console.log(`    ${token ? "✓" : "✗"} token  ${token ? `${String(token).length} chars` : "NOT FOUND"}`);
          if (!url || !token) {
            console.log(`\n    ⚠ booth/src/adapters/akool.js reads livekit_url/livekit_token`);
            console.log(`      (falling back to url/token). Neither matched — update it to`);
            console.log(`      the field names printed above or the video will never attach.`);
          }
        }
      } finally {
        // The point of the whole script. Runs even if the block above threw.
        if (sessionId) {
          console.log(`\n  Closing session ${sessionId}…`);
          const r = await fetch("https://openapi.akool.com/api/open/v4/liveAvatar/session/close", {
            method: "POST",
            headers: { [auth.header]: auth.value, "Content-Type": "application/json" },
            body: JSON.stringify({ id: sessionId, _id: sessionId }),
          }).catch((err) => ({ ok: false, status: 0, json: async () => ({ error: err.message }) }));
          const body = await r.json().catch(() => ({}));
          if (r.ok && (!body.code || body.code === 1000)) {
            console.log(`  ✓ session/close accepted — HTTP ${r.status}`);
            console.log(`\n    Now check your credit balance. If it dropped by roughly one`);
            console.log(`    minute's worth, the refund works and the booth's idle-release`);
            console.log(`    setting will genuinely save money. If it dropped by the FULL`);
            console.log(`    window, closing does not refund — turn idle-release OFF and`);
            console.log(`    set the session length to what a visit actually needs.\n`);
          } else {
            fail(
              `  ✗ session/close FAILED — HTTP ${r.status} ${JSON.stringify(body).slice(0, 300)}`,
              `\n    This session is still open and still billing until its ${DURATION}s expire.`,
              `    Close it from the Akool dashboard, then fix closeAkoolSession() in`,
              `    server/providers.mjs with the correct endpoint/field from this output —`,
              `    until it works, do NOT enable "close the session when the stand goes`,
              `    quiet", because releasing without closing costs more than not releasing.\n`,
            );
          }
        }
      }
    }
  }
}
