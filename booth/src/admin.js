import "./style.css";
import { initTheme, toggleTheme } from "./theme.js";

const $ = (id) => document.getElementById(id);

/**
 * Booth settings, for a Devoteam staffer on a stand rather than a developer.
 *
 * Two rules shape this page. Nothing is saved until the operator presses Save, so a
 * half-typed thought never reaches a live booth. And every control is phrased as the
 * outcome a visitor experiences ("Answer length", "If something breaks") rather than
 * as the mechanism behind it — nobody standing at LEAP should need to know what a
 * system prompt or a voice id is.
 */

let saved = null; // last known server state, for Undo
let voices = [];
let providers = [];

/* ------------------------------------------------------------ form binding */

const TEXT_FIELDS = [
  "profileName",
  "avatarId",
  "voiceAr",
  "voiceEn",
  "idleResetMinutes",
  "extraKnowledge",
  "customInstructions",
  "simliFaceId",
  "simliModel",
  "akoolAvatarId",
  "akoolVoiceId",
];

function read() {
  const s = {};
  for (const id of TEXT_FIELDS) s[id] = $(id).value;
  s.avatarProvider = selected("providerChoices", "provider") || "anam";
  s.idleResetMinutes = Number(s.idleResetMinutes) || 5;
  s.answerWords = Number(selected("lengthChoices", "words")) || 35;
  s.greetFirstAnswer = $("greetFirstAnswer").checked;
  s.fallback = {
    enabled: $("fallbackEnabled").checked,
    mode: selected("fallbackMode", "mode") || "speak",
    messageAr: $("fallbackAr").value,
    messageEn: $("fallbackEn").value,
  };
  return s;
}

function write(s) {
  for (const id of TEXT_FIELDS) $(id).value = s[id] ?? "";
  $("greetFirstAnswer").checked = !!s.greetFirstAnswer;
  $("fallbackEnabled").checked = !!s.fallback?.enabled;
  $("fallbackAr").value = s.fallback?.messageAr ?? "";
  $("fallbackEn").value = s.fallback?.messageEn ?? "";
  select("lengthChoices", "words", nearestLength(s.answerWords));
  select("fallbackMode", "mode", s.fallback?.mode ?? "speak");
  select("providerChoices", "provider", s.avatarProvider ?? "anam");
  applyProvider();
  renderPreview();
}

/**
 * Show only the fields the selected renderer actually uses, and say plainly when a
 * choice changes the voice.
 *
 * Akool has no audio input: it speaks our text in its own voice, so the Arabic and
 * English voice pickers do nothing there. Leaving them visible and inert would let an
 * operator carefully choose Hamed and then wonder why the booth sounds like someone
 * else — the failure would look like a bug rather than a property of the vendor.
 */
function applyProvider() {
  const id = selected("providerChoices", "provider") || "anam";
  const p = providers.find((x) => x.id === id);

  $("anamFields").hidden = id !== "anam";
  $("simliFields").hidden = id !== "simli";
  $("akoolFields").hidden = id !== "akool";

  const usesOurVoice = p?.mode !== "text";
  $("voiceFields").hidden = !usesOurVoice;

  // The section intro has to move with the provider too. Telling an operator to "pick
  // a voice that matches the avatar" directly above a panel with no voice pickers in
  // it is the same defect as showing the wrong fields — text that describes a
  // configuration the page is not currently offering.
  $("whoLead").textContent = usesOurVoice
    ? "The face on screen and the voice it speaks with. Each language has its own voice — pick one that matches the avatar, or visitors notice the mismatch before they notice anything else."
    : `The face on screen. ${p?.label ?? "This renderer"} supplies the voice as well, so there is nothing to match here — choose the avatar and its voice in the ${p?.label ?? "vendor"} dashboard.`;
  $("voiceHint").innerHTML = usesOurVoice
    ? `${p?.label ?? "This renderer"} lip-syncs the Arabic we generate, so these voices are what visitors hear.`
    : `<b style="color:var(--dv-intense-fire)">${p?.label} speaks with its own voice.</b> ` +
      `It has no audio input, so our Arabic voice is bypassed entirely — comparing its lip-sync ` +
      `with the others means comparing two different voices at once.`;

  $("providerHint").innerHTML = !p
    ? ""
    : p.configured
      ? escape(p.blurb)
      : `<b style="color:var(--dv-poppy)">Not configured.</b> Missing ${escape(p.missing.join(", "))} in .env. ` +
        `Saving this will leave the booth unable to connect.`;
}

/** Snap an arbitrary saved word count to the closest of the three presets. */
function nearestLength(words) {
  const options = [...$("lengthChoices").children].map((b) => Number(b.dataset.words));
  return String(options.reduce((a, b) => (Math.abs(b - words) < Math.abs(a - words) ? b : a)));
}

function selected(groupId, key) {
  return $(groupId).querySelector('[aria-pressed="true"]')?.dataset[key];
}

function select(groupId, key, value) {
  for (const b of $(groupId).children) {
    b.setAttribute("aria-pressed", String(b.dataset[key] === String(value)));
  }
}

for (const groupId of ["lengthChoices", "fallbackMode", "providerChoices"]) {
  $(groupId).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    for (const b of $(groupId).children) b.setAttribute("aria-pressed", String(b === btn));
    if (groupId === "providerChoices") applyProvider();
    renderPreview();
    dirty();
  });
}

/* -------------------------------------------------------------- the summary */

function renderPreview() {
  const s = read();
  const words = s.answerWords;
  const seconds = Math.round(words / 2.2);
  const av = [...$("avatarId").options].find((o) => o.value === s.avatarId)?.textContent;
  const p = providers.find((x) => x.id === s.avatarProvider);

  const who =
    p?.mode === "text"
      ? `Visitors meet an <b>${escape(p.label)}</b> avatar, speaking <b>${escape(p.label)}'s own voice</b> — our Arabic voice is not used.`
      : `Visitors meet <b>${escape(av || "—")}</b> via <b>${escape(p?.label ?? "Anam")}</b>, speaking
         <b>${escape(shortVoice(s.voiceAr))}</b> in Arabic and
         <b>${escape(shortVoice(s.voiceEn))}</b> in English.`;

  $("preview").innerHTML = `
    ${who}
    Answers run about <b>${seconds} seconds</b>, and it
    ${s.greetFirstAnswer ? "greets each visitor once" : "skips greetings"}.
    The conversation clears itself after <b>${s.idleResetMinutes} minutes</b> of silence.
    ${
      s.fallback.enabled
        ? `If an answer fails it ${s.fallback.mode === "speak" ? "says the fallback out loud" : "shows the fallback as a subtitle"}.`
        : `<b>If an answer fails it says nothing</b> — the screen will just sit there.`
    }
    ${s.extraKnowledge.trim() ? `It also knows <b>${s.extraKnowledge.trim().split("\n").filter(Boolean).length} extra fact(s)</b> you added.` : ""}
  `;
}

const escape = (v) =>
  String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** "ar-SA-HamedNeural" reads as noise to an operator; "Hamed (Saudi)" does not. */
function shortVoice(id) {
  const v = voices.find((x) => x.id === id);
  if (!v) return id || "—";
  const name = id.split("-")[2]?.replace(/Neural$/, "") ?? id;
  return `${name} (${v.locale}, ${v.gender.toLowerCase()})`;
}

/* ------------------------------------------------------------------ status */

let statusTimer = 0;
function status(msg, kind = "") {
  clearTimeout(statusTimer);
  $("status").textContent = msg;
  $("status").className = `status ${kind}`;
  if (msg) statusTimer = setTimeout(() => ($("status").textContent = ""), 4000);
}

function dirty() {
  status("Unsaved changes");
}

for (const id of [...TEXT_FIELDS, "greetFirstAnswer", "fallbackEnabled", "fallbackAr", "fallbackEn"]) {
  $(id).addEventListener("input", () => {
    renderPreview();
    dirty();
  });
  $(id).addEventListener("change", renderPreview);
}

/* ------------------------------------------------------------------ actions */

$("save").onclick = async () => {
  $("save").disabled = true;
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(read()),
    });
    if (!res.ok) throw new Error(`save failed (${res.status})`);
    saved = await res.json();
    write(saved);
    status("Saved — the next question uses these settings", "ok");
  } catch (err) {
    status(err.message, "err");
  } finally {
    $("save").disabled = false;
  }
};

$("revert").onclick = () => {
  if (saved) write(saved);
  status("Reverted to the last saved settings");
};

$("restore").onclick = async () => {
  // No confirm dialog: this only resets settings, the knowledge base is untouched,
  // and Undo brings the previous values straight back.
  const res = await fetch("/api/settings/reset", { method: "POST" });
  saved = await res.json();
  write(saved);
  status("Restored to the tested defaults", "ok");
};

$("themeBtn").onclick = () => toggleTheme();

/* -------------------------------------------------------------------- init */

initTheme();

async function boot() {
  const [settings, avatarsRes, voicesRes, providersRes] = await Promise.all([
    fetch("/api/settings").then((r) => r.json()),
    fetch("/api/avatars").then((r) => r.json()).catch(() => ({ data: [] })),
    fetch("/api/voices").then((r) => r.json()).catch(() => ({ voices: [] })),
    fetch("/api/avatar/providers").then((r) => r.json()).catch(() => ({ providers: [] })),
  ]);

  voices = voicesRes.voices ?? [];
  providers = providersRes.providers ?? [];

  // Provider picker. The subtitle on each button is the honest one-liner from the
  // registry — "not configured" is shown up front rather than discovered at a booth.
  const group = $("providerChoices");
  group.innerHTML = "";
  for (const p of providers) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.provider = p.id;
    const note = p.configured
      ? p.mode === "text"
        ? "own voice (not ours)"
        : `our voice @ ${p.sampleRate / 1000} kHz`
      : "not configured";
    b.innerHTML = `${escape(p.label)}<small>${escape(note)}</small>`;
    group.appendChild(b);
  }

  // Avatars: real names from the account, so the operator picks a face not a UUID.
  const avatarSel = $("avatarId");
  avatarSel.innerHTML = "";
  const avatars = avatarsRes.data ?? [];

  if (!avatars.length) {
    avatarSel.innerHTML = `<option value="${escape(settings.avatarId)}">${escape(settings.avatarId || "none configured")}</option>`;
    $("avatarHint").textContent =
      "Could not reach Anam — showing the saved value. Check ANAM_API_KEY, then reload.";
  } else {
    // "Use the one from .env" has to be a real option, or an operator who has never
    // touched this page cannot tell what the booth is actually using.
    const useEnv = document.createElement("option");
    useEnv.value = "";
    useEnv.textContent = "Use the avatar configured in .env";
    avatarSel.appendChild(useEnv);

    for (const a of avatars) {
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = a.displayName || a.id;
      avatarSel.appendChild(o);
    }

    /**
     * A saved avatar that this API key cannot use is the failure that wastes the most
     * time, because Anam's token endpoint returns 200 for it and only fails later with
     * a black video. Keys get swapped between accounts; the saved id does not follow.
     * Surface it here, where it is one dropdown away from being fixed.
     */
    const savedId = settings.avatarId;
    const known = !savedId || avatars.some((a) => a.id === savedId);
    if (!known) {
      const missing = document.createElement("option");
      missing.value = savedId;
      missing.textContent = `⚠ ${savedId} — not on this account`;
      avatarSel.insertBefore(missing, avatarSel.firstChild);
      $("avatarHint").innerHTML =
        `<b style="color:var(--dv-poppy)">The saved avatar is not available on this Anam key.</b> ` +
        `The booth would connect and then show a black video. Pick one of the ${avatars.length} below and save.`;
    } else {
      $("avatarHint").textContent =
        `${avatars.length} avatars available on this Anam account.` +
        (savedId ? "" : " Currently following ANAM_AVATAR_ID from .env.");
    }
  }

  for (const [selId, lang] of [["voiceAr", "ar"], ["voiceEn", "en"]]) {
    const sel = $(selId);
    sel.innerHTML = "";
    const list = voices.filter((v) => v.language === lang);
    if (!list.length) {
      sel.innerHTML = `<option value="${escape(settings[selId])}">${escape(settings[selId])}</option>`;
      continue;
    }
    for (const v of list) {
      const o = document.createElement("option");
      o.value = v.id;
      o.textContent = shortVoice(v.id);
      sel.appendChild(o);
    }
  }

  saved = settings;
  write(settings);
  $("lengthHint").textContent =
    "Measured, not guessed: the Arabic voice speaks about two words per second.";
}

boot().catch((err) => status(`Could not load settings: ${err.message}`, "err"));
