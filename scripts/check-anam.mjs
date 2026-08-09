/**
 * Is my Anam key actually working?  →  node scripts/check-anam.mjs
 *
 * Exists because the harness's failure modes point at the wrong culprit. Anam's
 * token endpoint returns **200 for an avatarId that does not exist** — it only
 * validates the avatar when the video stream starts. So the usual reading of
 * "connect failed" is backwards:
 *
 *   400  → never Anam. Our own guard in harness/vite.config.mjs: the key is not
 *          in the environment at all (wrong folder, or the server wasn't restarted).
 *   401  → Anam rejected the key value itself.
 *   200  → the key is fine. A black video after this is the avatarId, not the key.
 *
 * Prints a fingerprint rather than the key, so the output is safe to paste into
 * a chat when asking for help.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV = path.join(ROOT, ".env");

// Node on Windows aborts with a libuv assertion if process.exit() runs while the
// fetch's handles are still closing, so every exit here goes through exitCode and
// lets the loop drain on its own.
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

const key = process.exitCode ? null : process.env.ANAM_API_KEY;
const avatarId = process.env.ANAM_AVATAR_ID;

if (!process.exitCode && !key) fail(`\n  ✗ .env was read, but ANAM_API_KEY is empty.\n`);

if (key) {
  // A fingerprint, not the key: enough to compare against the dashboard, useless if leaked.
  console.log(`\n  .env       ${ENV}`);
  console.log(`  key        ${key.slice(0, 6)}…${key.slice(-4)} (${key.length} chars)`);
  console.log(`  avatarId   ${avatarId || "(not set)"}`);

  // The two ways a correct key still gets rejected — both invisible when you look at it.
  if (key !== key.trim()) console.log(`\n  ⚠ key has leading/trailing whitespace`);
  if (/^bearer\s/i.test(key)) {
    console.log(`\n  ⚠ key starts with "Bearer " — paste only the key itself; the`);
    console.log(`    code adds the Bearer prefix. This alone causes a 401.`);
  }

  const res = await fetch("https://api.anam.ai/v1/auth/session-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personaConfig: { name: "Devoteam LEAP", avatarId, enableAudioPassthrough: true },
    }),
  });
  const body = await res.json().catch(() => ({}));

  if (res.ok && body.sessionToken) {
    console.log(`\n  ✓ HTTP 200 — key works, token minted.`);

    // The token endpoint accepts any avatarId, so verifying it means asking the
    // account what it actually owns. Anam's two ID types look identical — both bare
    // UUIDs, both shown in the dashboard, and a persona carries the *same display
    // name* as its avatar — so pasting the wrong one is the default mistake, and it
    // only surfaces later as "Invalid entity ID" when the video stream starts.
    const list = async (p) => {
      const r = await fetch(`https://api.anam.ai/v1/${p}`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      return r.ok ? ((await r.json()).data ?? []) : [];
    };
    const [avatars, personas] = await Promise.all([list("avatars"), list("personas")]);

    const isAvatar = avatars.some((a) => a.id === avatarId);
    const persona = personas.find((p) => p.id === avatarId);

    if (isAvatar) {
      const name = avatars.find((a) => a.id === avatarId).displayName;
      console.log(`  ✓ avatarId is a real avatar on this account — "${name}"\n`);
    } else if (persona) {
      fail(
        `\n  ✗ ANAM_AVATAR_ID is a PERSONA id, not an avatar id.`,
        `    "${persona.name}" — personas and avatars are different objects that`,
        `    share a display name, which is why this is so easy to mix up.\n`,
        `    Fix .env:`,
        `      ANAM_AVATAR_ID=${persona.avatar?.id ?? "(this persona has no avatar)"}\n`,
        `    Then restart the dev server.\n`,
      );
    } else {
      fail(
        `\n  ✗ ANAM_AVATAR_ID "${avatarId}" is not an avatar on this account.`,
        `    Avatars available to this key:\n`,
        ...avatars.map((a) => `      ${a.id}  ${a.displayName}`),
        `\n    Set one as ANAM_AVATAR_ID in .env, then restart the dev server.\n`,
      );
    }
  } else if (res.status === 401) {
    fail(
      `\n  ✗ HTTP 401 — ${JSON.stringify(body)}`,
      `\n    Anam rejected the key. Check, in this order:`,
      `      1. Copied whole and from the right account — lab.anam.ai`,
      `      2. Not revoked or regenerated since you pasted it`,
      `      3. No "Bearer " prefix and no stray quotes in .env\n`,
    );
  } else {
    fail(
      `\n  ✗ HTTP ${res.status} — ${JSON.stringify(body)}`,
      `\n    Unexpected — paste this output when asking for help.\n`,
    );
  }
}
