/**
 * Load .env, and say out loud when the environment is overruling it.
 *
 * `process.loadEnvFile` does not overwrite a variable that is already in `process.env`.
 * That is the behaviour we want in a container — `docker run -e` should beat a stale
 * file baked into an image — but on a laptop it is a trap with no floor. Anyone who
 * once typed `$env:OPENAI_STT_MODEL = "…"` into a terminal has silently pinned every
 * process launched from that terminal, `.env` reads correctly on disk, the editor shows
 * the right value, and nothing anywhere reports the difference.
 *
 * That is not hypothetical. It cost a model upgrade that appeared to land — the file
 * said `gpt-transcribe`, the booth kept sending `gpt-4o-transcribe`, and a verification
 * run confirmed the *old* model while reporting success. The .env header has warned
 * about this in prose for months. Prose does not run at boot.
 *
 * So: load the file, then report every key where the environment won. Not an error —
 * in a container it is the correct and intended state — but never silent again.
 */
import { readFileSync } from "node:fs";

/** Keys whose values must never be printed, however useful the diff would be. */
const SECRET = /KEY|SECRET|TOKEN|PASSWORD/i;

/**
 * Parse just enough of a .env to know which keys it declares and what it says they are.
 *
 * Deliberately minimal: this does not load anything — `loadEnvFile` does that, and two
 * parsers disagreeing about the same file would be a worse bug than the one this
 * catches. All it needs is a key/value view good enough to compare.
 */
function declaredIn(text) {
  const declared = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!m) continue; // comment, blank, or continuation
    // Last write wins, exactly as loadEnvFile treats a repeated key — see the warning
    // at the top of .env about this file having set one key four times.
    declared.set(m[1], m[2].trim().replace(/^["']|["']$/g, ""));
  }
  return declared;
}

/**
 * Load `.env` from `envPath` and return the keys the surrounding environment shadowed.
 *
 * @param {string} envPath
 * @returns {Array<{key: string, file: string, env: string, secret: boolean}>}
 */
export function loadEnv(envPath) {
  let text;
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    // No .env is expected wherever the environment supplies the keys directly.
    return [];
  }

  const declared = declaredIn(text);

  // Snapshot before loading: afterwards there is no way to tell which value won.
  const shadowed = [];
  for (const [key, fileValue] of declared) {
    const existing = process.env[key];
    if (existing !== undefined && existing !== fileValue) {
      shadowed.push({ key, file: fileValue, env: existing, secret: SECRET.test(key) });
    }
  }

  try {
    process.loadEnvFile(envPath);
  } catch {
    /* unreadable or malformed — the caller's own key checks will report the fallout */
  }

  return shadowed;
}

/**
 * The booth's own variables. Narrow on purpose: the repair below rewrites values, and
 * it has no business touching PATH or anything else the host put in the environment.
 */
const OURS = /^(AKOOL|ANAM|ANTHROPIC|AZURE_SPEECH|BOOTH|CLAUDE|DEEPGRAM|ELEVENLABS|HEYGEN|OPENAI|SIMLI|TAVUS|TTS)_/;

/**
 * Repair variables that arrived with a newline in the middle, and say so.
 *
 * A dashboard variable field takes a multi-line paste without complaint, so two lines
 * of a .env pasted into one box become one variable whose value is
 * `sk-…\nOPENAI_STT_MODEL=gpt-4o-transcribe`. Nothing notices until the value reaches a
 * request header, and then it fails as `Headers.append: … is an invalid header value` —
 * from inside a fetch, naming neither the variable nor the dashboard, which is a long
 * way from "you pasted two things into one box".
 *
 * A header value cannot contain a newline, so the first line is the only reading that
 * could ever have worked: take it, so the booth runs, and report it loudly, because the
 * dashboard is still wrong and the second variable is still unset. `.trim()` at the call
 * sites does not catch this — the newline is in the middle, not at the ends.
 *
 * @returns {Array<{key: string, alsoFound: string|null}>}
 */
export function repairMultilineValues(env = process.env) {
  const repaired = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || !/[\r\n]/.test(value) || !OURS.test(key)) continue;

    const [first, ...rest] = value.split(/\r?\n/);
    env[key] = first.trim();

    // The tail is usually the variable that should have had its own box. Naming it turns
    // "something is malformed" into the exact edit to make.
    const strayKey = rest.join("\n").match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1] ?? null;
    repaired.push({ key, alsoFound: strayKey });
  }
  return repaired;
}

/**
 * Load, and print what got overruled.
 *
 * Values are shown because the key name alone does not tell you anything actionable —
 * "OPENAI_STT_MODEL is overridden" sends you looking, "the file says gpt-transcribe and
 * you are sending gpt-4o-transcribe" tells you what to do. Secrets are the exception
 * and are never printed; that a key is shadowed at all is the whole signal there.
 */
export function loadEnvAndReport(envPath, log = console.warn) {
  const shadowed = loadEnv(envPath);

  // After loading, so it covers both a mis-pasted dashboard variable and a mangled file.
  for (const { key, alsoFound } of repairMultilineValues()) {
    log(`  ${key} arrived with a line break in it — using the first line only.`);
    log(
      alsoFound
        ? `    The rest looks like ${alsoFound}=…, pasted into the same box. Give ${alsoFound} its own variable — it is NOT set right now.`
        : `    Check where it is set: everything after the first line was discarded.`,
    );
  }

  if (!shadowed.length) return shadowed;

  log(
    `  ${shadowed.length} value${shadowed.length > 1 ? "s" : ""} in .env ` +
      `${shadowed.length > 1 ? "are" : "is"} being overridden by the environment:`,
  );
  for (const { key, file, env, secret } of shadowed) {
    log(secret ? `    ${key} — environment value in use, .env ignored` : `    ${key} — using "${env}", .env says "${file}"`);
  }
  log(`  Expected in a container. On a laptop, clear it:  $env:${shadowed[0].key} = $null`);
  return shadowed;
}
