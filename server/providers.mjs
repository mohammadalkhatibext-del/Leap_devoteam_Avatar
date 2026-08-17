/**
 * Avatar renderer registry — one place that knows how to start a session with each
 * vendor, and what each vendor can actually do.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THE DIVIDE THAT MATTERS: `mode`
 *
 *   "pcm"   Anam, Simli — we synthesise the Arabic ourselves and the renderer only
 *           lip-syncs the samples we hand it. The voice is ar-SA-HamedNeural, the one
 *           ranked in SCORING.md Step 1, and every renderer hears byte-identical
 *           audio. This is what makes a renderer comparison a controlled experiment.
 *
 *   "text"  Akool — its live avatar has no audio-in path at all. You send chat text
 *           over Agora/LiveKit and Akool speaks it with its own `voice_id`. Our TTS
 *           is bypassed entirely.
 *
 * So Akool is not a drop-in third option, and the admin page says so rather than
 * letting an operator pick it and quietly get a different voice. Judging Akool's
 * lip-sync against Anam's means judging two different voices at once, which is
 * exactly the confound Phase 0 was designed to avoid — the whole reason fixture audio
 * was rendered once and fed to every renderer.
 * ────────────────────────────────────────────────────────────────────────────────
 */

const env = (k) => process.env[k]?.trim() || "";

/* ------------------------------------------------------------------------ anam */

async function anamSession(settings) {
  const key = env("ANAM_API_KEY");
  const r = await fetch("https://api.anam.ai/v1/auth/session-token", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      personaConfig: {
        name: settings.profileName || "Devoteam LEAP",
        avatarId: settings.avatarId || env("ANAM_AVATAR_ID"),
        // The whole point: we supply the audio, Anam only lip-syncs it.
        enableAudioPassthrough: true,
      },
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.message || body.error || `Anam ${r.status}`);

  const token = body.sessionToken ?? body.session_token;
  if (!token) throw new Error(`Anam returned no session token: ${JSON.stringify(body).slice(0, 200)}`);
  return { provider: "anam", mode: "pcm", sampleRate: 24000, token };
}

/* ----------------------------------------------------------------------- simli */

async function simliSession(settings) {
  const key = env("SIMLI_API_KEY");
  const faceId = settings.simliFaceId || env("SIMLI_FACE_ID");
  if (!faceId) throw new Error("SIMLI_FACE_ID not set in .env");

  const r = await fetch("https://api.simli.ai/compose/token", {
    method: "POST",
    headers: { "x-simli-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      faceId,
      // v2 is what actually validates faceId — the older call returns 200 for a face
      // that does not exist, and you only find out at stream time.
      apiVersion: "v2",
      handleSilence: true,
      maxSessionLength: 600,
      maxIdleTime: 300,
      model: settings.simliModel || "fasttalk",
    }),
  });
  const body = await r.json().catch(() => ({}));

  // Simli hands back a token-shaped string even on failure, so the status code is the
  // only trustworthy signal. Checking for the token's presence would call a 401 a success.
  if (!r.ok) throw new Error(body.detail || body.error || `Simli ${r.status}`);
  if (!body.session_token) throw new Error("Simli returned no session_token");

  // 16 kHz is mandatory, not a preference — the client resamples our 24 kHz audio.
  return { provider: "simli", mode: "pcm", sampleRate: 16000, token: body.session_token };
}

/* ----------------------------------------------------------------------- akool */

/**
 * Akool accepts either a long-lived API key or a bearer token exchanged from a
 * clientId/clientSecret pair. Support both, because which one a customer is issued
 * depends on their plan, and a booth operator should not have to care.
 */
async function akoolToken() {
  const apiKey = env("AKOOL_API_KEY");
  if (apiKey) return { header: "x-api-key", value: apiKey };

  const clientId = env("AKOOL_CLIENT_ID");
  const clientSecret = env("AKOOL_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("set AKOOL_API_KEY, or AKOOL_CLIENT_ID + AKOOL_CLIENT_SECRET, in .env");
  }

  const r = await fetch("https://openapi.akool.com/api/open/v3/getToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  const body = await r.json().catch(() => ({}));
  const token = body?.token ?? body?.data?.token;
  if (!r.ok || !token) throw new Error(`Akool getToken failed: ${JSON.stringify(body).slice(0, 200)}`);
  return { header: "Authorization", value: `Bearer ${token}` };
}

/**
 * The only two faces the booth offers, and the name an operator sees for each.
 *
 * The vendor lists are not a menu: Anam returns ten, Akool twenty, mostly stock
 * people with no connection to Devoteam and ids like "dvp_Alinna_realisticbg_vrt".
 * A staffer on the stand is choosing between two colleagues, so the picker offers
 * two colleagues and nothing else.
 *
 * The ids are the contract; the labels are ours. The vendors do not agree on her
 * name — Anam's displayName is "Dania", Akool's is "Dalia" — so the booth settles
 * it here and says Dalia on both. Change a label and only the wording moves; the
 * booth still connects to the same face.
 */
export const BOOTH_AVATARS = {
  anam: [
    { id: "278fec65-e75e-406b-a422-29c6233aba45", name: "Dalia", gender: "female" },
    { id: "bba96e80-2946-4819-a356-73765fa5bb3c", name: "Faisal", gender: "male" },
  ],
  akool: [
    { id: "kWte7SV6zSTmF07UZF_lW", name: "Dalia Akool", gender: "female" },
    { id: "HTuWYZWa-faUiqwRqKIZg", name: "Faisal Akool", gender: "male" },
  ],
};

/**
 * Keep only the booth's two faces, relabelled.
 *
 * Filtering against what the account actually returned rather than just emitting the
 * pair: a key swapped to another account should empty the picker and trip the "not on
 * this account" warning the admin page already draws, not offer two ids that will fail
 * at session-create in front of a visitor.
 */
export function boothAvatars(provider, fromVendor, idOf = (a) => a.id) {
  const allowed = BOOTH_AVATARS[provider] ?? [];
  const byId = new Map((fromVendor ?? []).map((a) => [idOf(a), a]));
  // The label and gender are ours; anything else the vendor knows about the avatar
  // (Akool's bound voice_id) rides along so the picker can act on it.
  return allowed
    .filter((a) => byId.has(a.id))
    .map((a) => ({ ...a, voiceId: byId.get(a.id)?.voiceId ?? null }));
}

/**
 * The streaming avatars this Akool key can use, for the admin picker.
 *
 * ONE path, deliberately. An earlier version tried v4 and fell back to
 * /api/open/v3/avatar/list, because no key existed here to confirm which one a live
 * account answers on. A real key settled it (2026-08-11, via npm run check:akool):
 * both answer 200, but they list different *kinds* of avatar — v4 returns the 20 that
 * can actually stream, v3 returns the 100-entry general catalogue. So the fallback was
 * worse than no fallback: on a v4 hiccup it would have quietly filled the picker with
 * ids that look fine and fail at session-create, which is a bug an operator debugs at
 * a booth rather than here.
 *
 * Returns [] on any failure: a missing avatar list must never stop the settings page
 * from loading, since every other renderer is configured from the same screen.
 */
const AVATAR_LIST_PATH = "https://openapi.akool.com/api/open/v4/liveAvatar/avatar/list";

export async function listAkoolAvatars() {
  let auth;
  try {
    auth = await akoolToken();
  } catch {
    return []; // no credentials yet — the picker just stays empty
  }

  try {
    const r = await fetch(AVATAR_LIST_PATH, { headers: { [auth.header]: auth.value } });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || (body.code && body.code !== 1000)) return [];

    // Confirmed shape: { data: { result: [ { avatar_id, name, … } ] } }. The other
    // spellings are kept as cheap insurance against Akool moving the nesting again.
    const rows = body.data?.result ?? body.data?.list ?? body.data ?? [];
    if (!Array.isArray(rows)) return [];

    return rows.map((a) => ({
      id: a.avatar_id ?? a._id ?? a.id,
      name: a.name ?? a.avatar_id ?? a._id,
      // Akool binds a voice to the avatar itself. Carrying it through lets the admin
      // page send that voice explicitly when the character is chosen, instead of
      // leaving voice_id empty and taking whatever the account defaults to. Not every
      // avatar has one — Faisal_akool does not — so this is often undefined.
      voiceId: a.voice_id ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * The Akool session this booth currently has open, if any.
 *
 * Tracked on the server rather than only in the browser because the expensive
 * failures are exactly the ones where the browser never gets to speak: a crashed
 * tab, a hard refresh, a laptop lid closed at the end of the day.
 */
let openAkoolSession = null;

/** The WebRTC stack we ask Akool for, and therefore the one the credentials describe. */
const AKOOL_STREAM_TYPE = "livekit";

/**
 * Close a live Akool session — this, not leaving the room, is what stops the meter.
 *
 * Akool pre-charges the whole requested window at create time and refunds the unused
 * remainder only when the session is closed. So a room disconnect on its own leaves a
 * paid window running with nobody watching, and since the next visitor opens a *new*
 * session, the windows stack: releasing on idle without closing costs more than never
 * releasing at all. It also consumes one of the account's concurrent-session slots,
 * so enough orphans stop the booth working, not just overspending.
 *
 * VERIFIED against a live key on 2026-08-11 (npm run check:akool): a session created
 * and then closed returns HTTP 200. The id goes out under both spellings Akool uses
 * across its own payloads (`_id` when it hands the session back, `id` in the close
 * docs) — sending both was how this was made safe without a key, and there is no
 * reason to narrow it now that it works.
 *
 * What is NOT verified is whether closing early actually refunds the unused window.
 * That is a billing question no API response answers; it needs a credit balance read
 * before and after. Until someone does that, `releaseAvatarWhenIdle` is a plausible
 * saving rather than a measured one, and the admin page says so.
 *
 * Never throws: this is called from teardown paths, and a failed close must not become
 * a visible booth error. It reports instead, and the caller logs.
 */
export async function closeAkoolSession(sessionId = openAkoolSession) {
  if (!sessionId) return { closed: false, skipped: true, reason: "no open Akool session" };

  let auth;
  try {
    auth = await akoolToken();
  } catch (err) {
    return { closed: false, sessionId, reason: err.message };
  }

  try {
    const r = await fetch("https://openapi.akool.com/api/open/v4/liveAvatar/session/close", {
      method: "POST",
      headers: { [auth.header]: auth.value, "Content-Type": "application/json" },
      body: JSON.stringify({ id: sessionId, _id: sessionId }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || (body.code && body.code !== 1000)) {
      // Deliberately not cleared: a transient failure should be retried at the next
      // create, and a permanently stale id is dropped there anyway when the new
      // session replaces it. Clearing here would turn a retryable miss into a leak.
      return {
        closed: false,
        sessionId,
        reason: `Akool ${r.status} ${JSON.stringify(body).slice(0, 200)}`,
      };
    }
    if (sessionId === openAkoolSession) openAkoolSession = null;
    return { closed: true, sessionId };
  } catch (err) {
    return { closed: false, sessionId, reason: err.message };
  }
}

async function akoolSession(settings) {
  const avatarId = settings.akoolAvatarId || env("AKOOL_AVATAR_ID");
  if (!avatarId) throw new Error("AKOOL_AVATAR_ID not set in .env");

  // Close whatever the last visitor left open before opening another. The browser
  // normally closes its own session on idle-release or page-hide, but a crashed tab or
  // a killed dev server never sends that — and every orphan bills its full window while
  // holding a concurrency slot. Doing it here makes "one booth, one open session" true
  // even when the client never got the chance to say goodbye.
  if (openAkoolSession) await closeAkoolSession(openAkoolSession);

  const auth = await akoolToken();
  const r = await fetch("https://openapi.akool.com/api/open/v4/liveAvatar/session/create", {
    method: "POST",
    headers: { [auth.header]: auth.value, "Content-Type": "application/json" },
    body: JSON.stringify({
      avatar_id: avatarId,
      // Operator-set, because this is what the session actually costs: Akool
      // pre-charges the full window and refunds the unused remainder only when the
      // session closes. Asking for less, and closing when the visitor leaves, is the
      // whole cost story for this renderer.
      duration: settings.akoolSessionSeconds ?? 300,
      // Akool offers agora | livekit | trtc. LiveKit, because this repo already
      // depends on livekit-client for the HeyGen adapter — adding a second WebRTC
      // stack for one unverified vendor is weight the booth does not need.
      stream_type: AKOOL_STREAM_TYPE,
      // Akool speaks with its OWN voice — this is the field our Arabic TTS loses to.
      ...(settings.akoolVoiceId ? { voice_id: settings.akoolVoiceId } : {}),
      ...(settings.akoolLanguage ? { language: settings.akoolLanguage } : {}),
    }),
  });
  const body = await r.json().catch(() => ({}));

  // Akool signals success in the payload (code 1000), not only in the HTTP status.
  if (!r.ok || (body.code && body.code !== 1000)) {
    throw new Error(body.msg || body.message || `Akool ${r.status} ${JSON.stringify(body).slice(0, 160)}`);
  }
  const data = body.data ?? body;
  if (!data.credentials) throw new Error("Akool returned no stream credentials");

  // Remember it the moment it exists, so it can still be closed if the browser never
  // manages to ask — the meter is already running by this line.
  openAkoolSession = data._id ?? null;

  return {
    provider: "akool",
    mode: "text",
    sessionId: data._id,
    // Akool does not echo stream_type back (verified 2026-08-11: the create response
    // carries the livekit_* credentials and no stream_type field at all), so report
    // what we asked for. The old `?? "agora"` default described a LiveKit session as
    // Agora — the kind of wrong label that costs an hour when the video will not attach.
    streamType: data.stream_type ?? AKOOL_STREAM_TYPE,
    credentials: data.credentials,
  };
}

/**
 * Is this renderer billed by how long the session stays open, rather than by how much
 * it speaks?
 *
 * Anam and Simli hold a stream we pay for differently; Akool pre-charges the whole
 * requested window. The booth needs to know, because the correct behaviour when a
 * visitor walks away differs: hold the session open for an instant start, or close it
 * so an empty stand is not being billed.
 */
const BILLS_BY_SESSION = new Set(["akool"]);

/* -------------------------------------------------------------------- registry */

export const PROVIDERS = {
  anam: {
    id: "anam",
    label: "Anam",
    mode: "pcm",
    sampleRate: 24000,
    /** Passed to the browser so it knows which client SDK to load. */
    transport: "anam-sdk",
    blurb: "Lip-syncs the Arabic audio we generate. Passed Phase 0 at 55/60.",
    requires: ["ANAM_API_KEY"],
    optional: ["ANAM_AVATAR_ID"],
    createSession: anamSession,
  },
  // Key order is the order the picker shows them in — listProviders() maps over this
  // object and the admin page builds its buttons from that list, so Akool sits second
  // as the other renderer the booth actually uses, and Simli last.
  akool: {
    id: "akool",
    label: "Akool",
    mode: "text",
    sampleRate: null,
    transport: "livekit",
    blurb:
      "Speaks with its OWN voice. Akool's live avatar has no audio input, so our Arabic voice is bypassed and the answer is sent as text — not comparable with the others on voice.",
    requires: ["AKOOL_AVATAR_ID"],
    optional: ["AKOOL_API_KEY", "AKOOL_CLIENT_ID", "AKOOL_CLIENT_SECRET"],
    createSession: akoolSession,
    // Only Akool has one. Anam and Simli stop costing when the stream ends, so there
    // is nothing for the booth to call and nothing to get wrong by not calling it.
    closeSession: closeAkoolSession,
  },
  simli: {
    id: "simli",
    label: "Simli",
    mode: "pcm",
    sampleRate: 16000,
    transport: "simli-sdk",
    blurb: "Lip-syncs our audio too, but requires 16 kHz — the browser resamples, so it is the one renderer not hearing the fixture bit-for-bit.",
    requires: ["SIMLI_API_KEY", "SIMLI_FACE_ID"],
    optional: [],
    createSession: simliSession,
  },
};

export const DEFAULT_PROVIDER = "anam";

/** Is every environment variable this provider needs actually present? */
export function providerStatus(id) {
  const p = PROVIDERS[id];
  if (!p) return { id, configured: false, missing: [], unknown: true };

  const missing = p.requires.filter((k) => !env(k));

  // Akool's credential can arrive by either route, so "missing" needs a special case
  // rather than a flat list — otherwise a perfectly configured clientId/secret pair
  // would be reported as broken.
  if (id === "akool" && !env("AKOOL_API_KEY") && !(env("AKOOL_CLIENT_ID") && env("AKOOL_CLIENT_SECRET"))) {
    missing.push("AKOOL_API_KEY (or AKOOL_CLIENT_ID + AKOOL_CLIENT_SECRET)");
  }

  return { id, configured: missing.length === 0, missing };
}

/** Everything the admin page needs to render the picker honestly. */
export function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    mode: p.mode,
    sampleRate: p.sampleRate,
    transport: p.transport,
    blurb: p.blurb,
    ...providerStatus(p.id),
  }));
}

/** Start a session with whichever renderer the operator selected. */
export async function createSession(settings) {
  const id = PROVIDERS[settings.avatarProvider] ? settings.avatarProvider : DEFAULT_PROVIDER;
  const p = PROVIDERS[id];

  const status = providerStatus(id);
  if (!status.configured) {
    throw new Error(`${p.label} is not configured — missing ${status.missing.join(", ")}`);
  }

  const session = await p.createSession(settings);
  return {
    ...session,
    label: p.label,
    transport: p.transport,
    // The id the booth quotes back to close this session. Only renderers that bill by
    // the open window have one; for the others the field is simply absent.
    sessionId: session.sessionId ?? null,
    // The browser decides whether to release the session on idle, so it has to be
    // told which renderers cost money for standing still.
    billsBySession: BILLS_BY_SESSION.has(id),
  };
}

/**
 * End a session that costs money while it stays open. A no-op for the renderers that
 * do not, so the booth can call it unconditionally on teardown rather than branching
 * on vendor at every exit — and there are several exits, which is how the leak started.
 *
 * Never throws, for the same reason closeAkoolSession does not: every caller is a
 * teardown path where the visitor is already gone.
 */
export async function closeSession(providerId, sessionId) {
  const p = PROVIDERS[providerId];
  // `skipped` separates "this renderer has no meter" from "the meter is still running".
  // Only the second is worth a warning, and a warning that fires on every Anam teardown
  // is one an operator learns to scroll past — including on the night it matters.
  if (!p?.closeSession) {
    return { closed: false, skipped: true, reason: `${providerId ?? "unknown"}: nothing to close` };
  }
  return p.closeSession(sessionId);
}
