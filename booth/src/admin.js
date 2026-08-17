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
let ttsEngines = [];
let sttEngines = [];
let elevenVoices = [];
const TTS_DEFAULT_VOICES = {
  elevenlabs: {
    male: { ar: "rPNcQ53R703tTmtue1AT", en: "wAGzRVkxKEs8La0lmdrE" },
    female: { ar: "VwC51uc4PUblWEJSPzeo", en: "yj30vwTGJxSHezdAGsv9" },
  },
  openai: { male: "ash", female: "nova" },
};
const DEFAULT_ELEVENLABS_VOICE_NAMES = {
  male: { ar: "Mohammed Almansari", en: "Mohammed Almansari" },
  female: { ar: "Abrar Sabbah", en: "Abrar Sabbah" },
};
const DEFAULT_TTS_ENGINE = "elevenlabs";

function resolveDefaultElevenVoicePair(gender) {
  const fallback = TTS_DEFAULT_VOICES.elevenlabs[gender] ?? TTS_DEFAULT_VOICES.elevenlabs.male;
  const names = DEFAULT_ELEVENLABS_VOICE_NAMES[gender] ?? DEFAULT_ELEVENLABS_VOICE_NAMES.male;
  const ar = elevenVoices.find((v) => v.name === names.ar)?.id ?? fallback.ar;
  const en = elevenVoices.find((v) => v.name === names.en)?.id ?? fallback.en;
  return { ar, en };
}

/* ------------------------------------------------------------ form binding */

const TEXT_FIELDS = [
  "profileName",
  "avatarId",
  "voiceAr",
  "voiceEn",
  "elevenVoiceAr",
  "elevenVoiceEn",
  "elevenModel",
  "openaiVoice",
  "idleResetMinutes",
  "extraKnowledge",
  "customInstructions",
  "simliFaceId",
  "simliModel",
  "akoolAvatarId",
  "akoolVoiceId",
];

function defaultTtsEngine() {
  const available = (ttsEngines ?? []).map((e) => e.id);
  const fallback = DEFAULT_TTS_ENGINE;
  return available.includes(fallback) ? fallback : (available[0] ?? fallback);
}

function ttsGenderForSettings(s = read()) {
  const engine = s.ttsEngine || defaultTtsEngine();
  if (engine === "openai") {
    return s.openaiVoice === "nova" ? "female" : "male";
  }
  if (engine === "elevenlabs") {
    const male = TTS_DEFAULT_VOICES.elevenlabs.male;
    const female = TTS_DEFAULT_VOICES.elevenlabs.female;
    const arMatch = s.elevenVoiceAr === female.ar || s.elevenVoiceAr === male.ar;
    const enMatch = s.elevenVoiceEn === female.en || s.elevenVoiceEn === male.en;
    if (arMatch && enMatch) {
      return s.elevenVoiceAr === female.ar && s.elevenVoiceEn === female.en ? "female" : "male";
    }
    return "male";
  }
  return "male";
}

function applyTtsGender(value) {
  const engine = selected("ttsChoices", "engine") || defaultTtsEngine();
  if (engine === "openai") {
    $("openaiVoice").value = TTS_DEFAULT_VOICES.openai[value] ?? TTS_DEFAULT_VOICES.openai.male;
    return;
  }
  if (engine === "elevenlabs") {
    const voices = resolveDefaultElevenVoicePair(value);
    $("elevenVoiceAr").value = voices.ar;
    $("elevenVoiceEn").value = voices.en;
  }
}

function read() {
  const s = {};
  for (const id of TEXT_FIELDS) s[id] = $(id).value;
  s.avatarProvider = selected("providerChoices", "provider") || "anam";
  s.ttsEngine = selected("ttsChoices", "engine") || defaultTtsEngine();
  s.sttEngine = selected("sttChoices", "engine") || "deepgram";
  const gender = selected("ttsGenderChoices", "gender") || ttsGenderForSettings(s);
  if (s.ttsEngine === "openai") {
    s.openaiVoice = TTS_DEFAULT_VOICES.openai[gender] ?? "ash";
  }
  if (s.ttsEngine === "elevenlabs") {
    const mapped = TTS_DEFAULT_VOICES.elevenlabs[gender] ?? TTS_DEFAULT_VOICES.elevenlabs.male;
    s.elevenVoiceAr = mapped.ar;
    s.elevenVoiceEn = mapped.en;
  }
  s.idleResetMinutes = Number(s.idleResetMinutes) || 5;
  s.answerWords = Number(selected("lengthChoices", "words")) || 35;
  s.akoolSessionSeconds = Number(selected("akoolSessionChoices", "seconds")) || 300;
  s.releaseAvatarWhenIdle = $("releaseAvatarWhenIdle").checked;
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
  $("releaseAvatarWhenIdle").checked = !!s.releaseAvatarWhenIdle;
  select("akoolSessionChoices", "seconds", s.akoolSessionSeconds ?? 300);
  $("fallbackEnabled").checked = !!s.fallback?.enabled;
  $("fallbackAr").value = s.fallback?.messageAr ?? "";
  $("fallbackEn").value = s.fallback?.messageEn ?? "";
  applyFallbackSettings();
  select("lengthChoices", "words", nearestLength(s.answerWords));
  select("fallbackMode", "mode", s.fallback?.mode ?? "speak");
  select("providerChoices", "provider", s.avatarProvider ?? "anam");
  const ttsValue = (s.ttsEngine && ttsEngines.some((e) => e.id === s.ttsEngine)) ? s.ttsEngine : defaultTtsEngine();
  select("ttsChoices", "engine", ttsValue);
  select("sttChoices", "engine", s.sttEngine ?? "deepgram");
  const currentTtsEngine = selected("ttsChoices", "engine") || defaultTtsEngine();
  const gender = ttsGenderForSettings({ ...s, ttsEngine: currentTtsEngine });
  if (currentTtsEngine === "openai") {
    $("openaiVoice").value = s.openaiVoice || TTS_DEFAULT_VOICES.openai[gender];
  }
  if (currentTtsEngine === "elevenlabs") {
    const mapped = resolveDefaultElevenVoicePair(gender);
    $("elevenVoiceAr").value = s.elevenVoiceAr || mapped.ar;
    $("elevenVoiceEn").value = s.elevenVoiceEn || mapped.en;
  }
  select("ttsGenderChoices", "gender", gender);
  applyProvider();
  applyTtsEngine();
  applySttEngine();
  applyAkoolSession();
  renderPreview();
}

/**
 * Show the voice control that belongs to the selected engine, and say plainly what
 * the engine costs the booth.
 *
 * The Microsoft engines take one voice id per language; the multilingual ones take a
 * single voice for both. Showing all three groups at once would let an operator
 * carefully set an Arabic voice that the running engine never reads — the same class
 * of defect as leaving the voice pickers visible under Akool.
 */
function applyTtsEngine() {
  const id = selected("ttsChoices", "engine") || defaultTtsEngine();
  const e = ttsEngines.find((x) => x.id === id) || ttsEngines[0];

  $("microsoftVoiceFields").hidden = e?.voiceMode !== "microsoft";
  $("elevenVoiceFields").hidden = e?.voiceMode !== "pair";
  $("voiceEnField").hidden = e?.voiceMode !== "microsoft";
  $("openaiVoiceFields").hidden = id !== "openai";
  $("ttsGenderFields").hidden = !["elevenlabs", "openai"].includes(id);
  const gender = selected("ttsGenderChoices", "gender") || (id === "openai" ? "male" : "male");
  select("ttsGenderChoices", "gender", gender);

  const renderer = providers.find((x) => x.id === (selected("providerChoices", "provider") || "anam"));
  if (renderer?.mode === "text") {
    $("ttsHint").innerHTML =
      `<b style="color:var(--dv-intense-fire)">${escape(renderer.label)} speaks with its own voice,</b> ` +
      `so whichever engine you pick here is bypassed. Switch the renderer above to hear it at the booth.`;
    return;
  }

  $("ttsHint").innerHTML = !e
    ? ""
    : (e.configured
        ? escape(e.blurb)
        : `<b style="color:var(--dv-poppy)">Not configured.</b> Missing ${escape(e.missing.join(", "))} in .env. ` +
          `Saving this will leave the booth silent.`) +
      (e.warn ? ` <b style="color:var(--dv-intense-fire)">${escape(e.warn)}</b>` : "");
}

/**
 * Turn the session-length choice into the number an operator actually decides on:
 * how many visitors a month's credits will serve.
 *
 * Akool does not publish the streaming rate in its API docs and the two public
 * trackers disagree by 4x, so both are shown rather than one averaged figure that
 * would look authoritative and be wrong. The ratio between the buttons is exact
 * either way, and that is the part that matters: half the window, half the cost.
 */
function applyAkoolSession() {
  const seconds = Number(selected("akoolSessionChoices", "seconds")) || 300;
  const minutes = seconds / 60;
  const sessions = (creditsPerMin) => Math.floor(1200 / (creditsPerMin * minutes));
  $("akoolSessionHint").innerHTML =
    `Charged for the whole window, not for speech — so on 1200 credits (Pro Max) this is ` +
    `<b>${sessions(7.2)}–${sessions(30)} visitors a month</b>, depending on which rate Akool ` +
    `bills you at (they publish 1.2 credits/10s in one place and 30/min in another — ` +
    `check your first invoice). Halving the window halves the cost per visitor.`;
}

function applySttEngine() {
  const id = selected("sttChoices", "engine") || "deepgram";
  const e = sttEngines.find((x) => x.id === id);
  $("sttHint").innerHTML = !e
    ? ""
    : e.configured
      ? escape(e.blurb)
      : `<b style="color:var(--dv-poppy)">Not configured.</b> Missing ${escape(e.missing.join(", "))} in .env. ` +
        `Saving this will leave the booth unable to hear anyone.`;
}

function applyFallbackSettings() {
  const enabled = $("fallbackEnabled").checked;
  $("fallbackModeField").hidden = !enabled;
  $("fallbackMessages").hidden = !enabled;
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

  // The section intro has to move with the provider too. Telling an operator to "pick
  // a voice that matches the avatar" directly above a panel with no voice pickers in
  // it is the same defect as showing the wrong fields — text that describes a
  // configuration the page is not currently offering.
  $("whoLead").textContent = usesOurVoice
    ? "The face on screen and the voice it speaks with. Each language has its own voice — pick one that matches the avatar, or visitors notice the mismatch before they notice anything else."
    : `The face on screen. ${p?.label ?? "This renderer"} supplies the voice as well, so there is nothing to match here — choose the avatar and its voice in the ${p?.label ?? "vendor"} dashboard.`;
  $("voiceHint").innerHTML = usesOurVoice
    ? `${p?.label ?? "This renderer"} lip-syncs the Arabic we generate — pick the engine and voice below.`
    : `<b style="color:var(--dv-intense-fire)">${p?.label} speaks with its own voice.</b> ` +
      `It has no audio input, so our Arabic voice is bypassed entirely — comparing its lip-sync ` +
      `with the others means comparing two different voices at once.`;

  // The sound card's own hint depends on this choice, so it has to be re-rendered
  // whenever the renderer changes — not only when the engine does.
  if (ttsEngines.length) applyTtsEngine();

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
  const group = $(groupId);
  if (!group) return;
  for (const b of group.children) {
    b.setAttribute("aria-pressed", String(b.dataset[key] === String(value)));
  }
}

function bindCollapse(buttonId, panelId) {
  const btn = $(buttonId);
  const panel = $(panelId);
  if (!btn || !panel) return;
  const sync = () => {
    const expanded = !panel.hidden;
    btn.setAttribute("aria-expanded", String(expanded));
    btn.querySelector(".chevron").textContent = expanded ? "▴" : "▾";
  };
  btn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    sync();
  });
  sync();
}

for (const groupId of [
  "lengthChoices",
  "fallbackMode",
  "providerChoices",
  "ttsChoices",
  "ttsGenderChoices",
  "sttChoices",
  "akoolSessionChoices",
]) {
  $(groupId).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    for (const b of $(groupId).children) b.setAttribute("aria-pressed", String(b === btn));
    if (groupId === "providerChoices") applyProvider();
    if (groupId === "ttsChoices") {
      applyTtsEngine();
      const gender = selected("ttsGenderChoices", "gender") || "male";
      applyTtsGender(gender);
    }
    if (groupId === "ttsGenderChoices") {
      applyTtsGender(btn.dataset.gender);
      renderPreview();
      dirty();
      return;
    }
    if (groupId === "sttChoices") applySttEngine();
    if (groupId === "akoolSessionChoices") applyAkoolSession();
    renderPreview();
    dirty();
  });
}

bindCollapse("providerAdvancedToggle", "providerAdvancedPanel");
bindCollapse("ttsAdvancedToggle", "ttsAdvancedPanel");
bindCollapse("ttsTestToggle", "ttsTestPanel");
bindCollapse("sttTestToggle", "sttTestPanel");
bindCollapse("fallbackToggle", "fallbackPanel");
bindCollapse("knowledgeToggle", "knowledgePanel");

// The test-lab language is not a setting — it decides which line gets synthesised
// here and nothing else, so it must never mark the form dirty or the operator would
// be prompted to save a preference that does not exist.
$("testLang").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  for (const b of $("testLang").children) b.setAttribute("aria-pressed", String(b === btn));
  $("testText").value = SAMPLE_LINES[btn.dataset.lang];
  $("testText").dir = btn.dataset.lang === "ar" ? "rtl" : "ltr";
});

/* -------------------------------------------------------------- the summary */

function renderPreview() {
  const s = read();
  const words = s.answerWords;
  const seconds = Math.round(words / 2.2);
  const av = [...$("avatarId").options].find((o) => o.value === s.avatarId)?.textContent;
  const p = providers.find((x) => x.id === s.avatarProvider) ?? providers[0];
  const tts = ttsEngines.find((x) => x.id === s.ttsEngine) ?? ttsEngines[0];
  const stt = sttEngines.find((x) => x.id === s.sttEngine) ?? sttEngines[0];
  const providerName = p?.label ?? "Anam";

  const providerLine = `Visitors meet the <b>${escape(providerName)}</b> avatar configured in \`.env\`.`;

  let voiceLine = `Voice is provided by <b>${escape(tts?.label ?? s.ttsEngine)}</b>.`;
  if (p?.mode === "text") {
    voiceLine = `Voice is provided by <b>${escape(providerName)}</b> and the external TTS engine is bypassed.`;
  } else if (tts?.id === "elevenlabs") {
    const defaultAr = DEFAULT_ELEVENLABS_VOICE_NAMES.male.ar;
    const defaultEn = DEFAULT_ELEVENLABS_VOICE_NAMES.female.en;
    const gender = selected("ttsGenderChoices", "gender") || "male";
    const arName = gender === "female" ? DEFAULT_ELEVENLABS_VOICE_NAMES.female.ar : defaultAr;
    const enName = gender === "female" ? DEFAULT_ELEVENLABS_VOICE_NAMES.female.en : DEFAULT_ELEVENLABS_VOICE_NAMES.male.en;
    voiceLine = `Voice is provided by <b>ElevenLabs</b>, using <b>${escape(arName)}</b> for Arabic and <b>${escape(enName)}</b> for English.`;
  } else if (tts?.id === "openai") {
    const gender = selected("ttsGenderChoices", "gender") || "male";
    const arName = gender === "female" ? "Nova" : "Ash";
    const enName = gender === "female" ? "Nova" : "Ash";
    voiceLine = `Voice is provided by <b>OpenAI</b>, using <b>${escape(arName)}</b> for Arabic and <b>${escape(enName)}</b> for English.`;
  } else if (tts?.voiceMode === "microsoft") {
    voiceLine = `Voice is provided by <b>${escape(tts.label ?? "Microsoft")}</b>.`;
  }

  const fallbackLine = s.fallback.enabled
    ? `${s.fallback.mode === "speak" ? "Speak & Display" : "Display Only"}`
    : "Disabled";

  const sessionLine = p?.id === "akool"
    ? `Response time is about <b>${seconds} seconds</b>.`
    : `Response time is about <b>${seconds} seconds</b>.`;

  const fallbackSentence = s.fallback.enabled
    ? `Failed answers use <b>${fallbackLine}</b> as the fallback response.`
    : `Fallback response is <b>${fallbackLine}</b>.`;

  $("preview").innerHTML = [
    providerLine,
    voiceLine,
    `Listening uses <b>${escape(stt?.label ?? s.sttEngine)}</b>.`,
    sessionLine,
    fallbackSentence,
  ].join(" ");
}

const escape = (v) =>
  String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** A bare ElevenLabs id tells an operator nothing; the voice's name does. */
function elevenName(id) {
  if (!id) return "the .env voice";
  const v = elevenVoices.find((x) => x.id === id);
  return v ? v.name : id;
}

/** "ar-SA-HamedNeural" reads as noise to an operator; "Hamed (Saudi)" does not. */
function shortVoice(id) {
  const v = voices.find((x) => x.id === id);
  if (!v) return id || "—";
  const name = id.split("-")[2]?.replace(/Neural$/, "") ?? id;
  return `${name} (${v.locale}, ${v.gender.toLowerCase()})`;
}

/* ---------------------------------------------------------------- test lab */

/**
 * Default test lines, chosen rather than invented.
 *
 * The Arabic one is deliberately the hard case from the Phase 0 fixture set: a
 * code-switch into Latin-script product names plus the brand name in Arabic script.
 * That combination is what separated renderers in SCORING.md and it is what separates
 * voices too — an engine that handles plain Arabic prose can still mangle "AWS" or
 * turn "ديفوتيم" into something a visitor does not recognise as their own company.
 * Testing on an easy sentence would tell you nothing you need to know.
 */
const SAMPLE_LINES = {
  ar: "في ديفوتيم نبني حلول السحابة على AWS و Azure و Kubernetes لعملائنا في المملكة.",
  en: "At Devoteam we build cloud solutions on AWS, Azure and Kubernetes for our clients in the Kingdom.",
};

const testLanguage = () => selected("testLang", "lang") || "ar";

/** Play base64 WAV without owning a decoder — this is the one place a plain
 *  <audio> element is enough, because nothing here is lip-synced. */
function play(wavBase64) {
  const audio = new Audio(`data:audio/wav;base64,${wavBase64}`);
  audio.play().catch(() => {});
  return audio;
}

function renderTtsResults(results, chosen) {
  const box = $("ttsResults");
  box.innerHTML = "";
  for (const r of results) {
    const row = document.createElement("div");
    row.className = `result${r.ok ? "" : " bad"}${r.engine === chosen ? " chosen" : ""}`;
    if (r.ok) {
      row.innerHTML =
        `<span class="name">${escape(r.label)}</span>` +
        `<span class="meta">${r.seconds}s audio · ${r.ms} ms to make · ${escape(shortVoice(r.voice) || r.voice || "—")}</span>` +
        `<span class="spacer"></span>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "secondary";
      btn.textContent = "▶ Play";
      btn.onclick = () => play(r.wav);
      row.appendChild(btn);
      // Play the chosen engine straight away so the common case — "what does the
      // engine I am about to save sound like" — needs one click, not two.
      if (r.engine === chosen) play(r.wav);
    } else {
      row.innerHTML =
        `<span class="name">${escape(r.label)}</span>` +
        `<span class="meta">${escape(r.error)}</span>`;
    }
    box.appendChild(row);
  }
}

async function compareTts(engines) {
  const text = $("testText").value.trim();
  if (!text) return status("Type a line to test first", "err");

  $("speakOne").disabled = $("speakAll").disabled = true;
  $("ttsResults").innerHTML = `<div class="result"><span class="meta">Synthesising…</span></div>`;
  try {
    const res = await fetch("/api/tts/compare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        language: testLanguage(),
        engines,
        // The voice fields as they stand on screen, saved or not — the lab must test
        // the choice being made, not the one already stored.
        overrides: {
          voiceAr: $("voiceAr").value,
          voiceEn: $("voiceEn").value,
          elevenVoiceAr: $("elevenVoiceAr").value,
          elevenVoiceEn: $("elevenVoiceEn").value,
          elevenModel: $("elevenModel").value,
          openaiVoice: $("openaiVoice").value,
        },
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `failed (${res.status})`);
    if (!body.results.length) throw new Error("no engines are configured — add a key to .env");
    renderTtsResults(body.results, selected("ttsChoices", "engine"));
  } catch (err) {
    $("ttsResults").innerHTML = "";
    status(err.message, "err");
  } finally {
    $("speakOne").disabled = $("speakAll").disabled = false;
  }
}

$("speakOne").onclick = () => compareTts([selected("ttsChoices", "engine") || defaultTtsEngine()]);
$("speakAll").onclick = () => compareTts(undefined);

/* --- microphone -------------------------------------------------------- */

let recorder = null;
let chunks = [];

async function toggleRecording() {
  if (recorder?.state === "recording") {
    recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = async () => {
      // Release the mic immediately — leaving the track live keeps the browser's
      // recording indicator on and makes an operator think it is still listening.
      for (const t of stream.getTracks()) t.stop();
      $("recBtn").textContent = "● Record a question";
      $("recBtn").classList.add("secondary");
      await compareStt(new Blob(chunks, { type: recorder.mimeType }));
    };
    recorder.start();
    $("recBtn").textContent = "■ Stop and transcribe";
    $("recBtn").classList.remove("secondary");
    $("sttResults").innerHTML = "";
  } catch (err) {
    status(`Microphone unavailable: ${err.message}`, "err");
  }
}

async function compareStt(blob) {
  $("sttResults").innerHTML = `<div class="result"><span class="meta">Transcribing…</span></div>`;
  try {
    const res = await fetch("/api/stt/compare", {
      method: "POST",
      headers: { "content-type": blob.type || "audio/webm" },
      body: blob,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `failed (${res.status})`);

    const chosen = selected("sttChoices", "engine");
    const box = $("sttResults");
    box.innerHTML = "";
    if (!body.results.length) throw new Error("no engines are configured — add a key to .env");

    for (const r of body.results) {
      const row = document.createElement("div");
      row.className = `result${r.ok ? "" : " bad"}${r.engine === chosen ? " chosen" : ""}`;
      row.innerHTML = r.ok
        ? `<span class="name">${escape(r.label)}</span>` +
          `<span class="meta">${r.language ? `heard ${r.language}` : "heard nothing"} · ${r.ms} ms</span>` +
          `<span class="said" dir="auto">${escape(r.transcript || "—")}</span>`
        : `<span class="name">${escape(r.label)}</span><span class="meta">${escape(r.error)}</span>`;
      box.appendChild(row);
    }
  } catch (err) {
    $("sttResults").innerHTML = "";
    status(err.message, "err");
  }
}

$("recBtn").onclick = toggleRecording;

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

for (const id of [
  ...TEXT_FIELDS,
  "greetFirstAnswer",
  "releaseAvatarWhenIdle",
  "fallbackEnabled",
  "fallbackAr",
  "fallbackEn",
]) {
  $(id).addEventListener("input", () => {
    renderPreview();
    dirty();
  });
  $(id).addEventListener("change", () => {
    if (id === "fallbackEnabled") applyFallbackSettings();
    renderPreview();
    dirty();
  });
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
  status("Discarded unsaved changes");
};

$("restore").onclick = async () => {
  if (!window.confirm("Restore all settings to the tested defaults?")) return;
  const res = await fetch("/api/settings/reset", { method: "POST" });
  saved = await res.json();
  write(saved);
  status("Restored to the tested defaults", "ok");
};

$("themeBtn").onclick = () => toggleTheme();

/* -------------------------------------------------------------------- init */

initTheme();

async function boot() {
  const [settings, avatarsRes, voicesRes, providersRes, ttsRes, sttRes, elevenRes, akoolRes] = await Promise.all([
    fetch("/api/settings").then((r) => r.json()),
    fetch("/api/avatars").then((r) => r.json()).catch(() => ({ data: [] })),
    fetch("/api/voices").then((r) => r.json()).catch(() => ({ voices: [] })),
    fetch("/api/avatar/providers").then((r) => r.json()).catch(() => ({ providers: [] })),
    fetch("/api/tts/engines").then((r) => r.json()).catch(() => ({ engines: [], openaiVoices: [] })),
    fetch("/api/stt/engines").then((r) => r.json()).catch(() => ({ engines: [] })),
    fetch("/api/tts/eleven-voices").then((r) => r.json()).catch(() => ({ voices: [] })),
    fetch("/api/akool/avatars").then((r) => r.json()).catch(() => ({ avatars: [] })),
  ]);

  voices = voicesRes.voices ?? [];
  providers = providersRes.providers ?? [];
  ttsEngines = (ttsRes.engines ?? []).filter((e) => ["elevenlabs", "openai"].includes(e.id));
  sttEngines = sttRes.engines ?? [];

  const engineButtons = (groupId, list, note) => {
    const group = $(groupId);
    group.innerHTML = "";
    for (const e of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.engine = e.id;
      b.innerHTML = groupId === "ttsChoices"
        ? escape(e.label)
        : `${escape(e.label)}<small>${escape(e.configured ? note(e) : "not configured")}</small>`;
      group.appendChild(b);
    }
  };
  engineButtons("ttsChoices", ttsEngines, (e) => e.cost);
  engineButtons("sttChoices", sttEngines, () => "ready");

  const openaiSel = $("openaiVoice");
  openaiSel.innerHTML = "";
  for (const v of ttsRes.openaiVoices ?? []) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    openaiSel.appendChild(o);
  }

  /**
   * ElevenLabs voices from the account, not a free-text id.
   *
   * The id in .env is a *library* voice, and a library voice returns
   * `402 paid_plan_required` on a free account while premade voices work — with
   * nothing in either id to tell them apart. That is the same trap as an Anam persona
   * id, and it gets the same treatment: list what the key can use, and flag a saved
   * value that is not among them instead of letting it fail mid-answer.
   */
  elevenVoices = elevenRes.voices ?? [];

  // Two pickers, ordered so the language's own native voices come first. A booth in
  // Riyadh should not have to scroll past twenty American voices to find the Arabic
  // one, and the ordering is the cheapest way to say which voices belong here.
  for (const [selId, langCode] of [["elevenVoiceAr", "ar"], ["elevenVoiceEn", "en"]]) {
    const sel = $(selId);
    sel.innerHTML = "";
    if (!elevenVoices.length) {
      const savedId = settings[selId];
      sel.innerHTML = `<option value="${escape(savedId)}">${escape(savedId || "none configured")}</option>`;
      continue;
    }
    const useEnv = document.createElement("option");
    useEnv.value = "";
    useEnv.textContent = `Use ELEVENLABS_VOICE_${langCode.toUpperCase()} from .env`;
    sel.appendChild(useEnv);

    const native = elevenVoices.filter((v) => v.language === langCode);
    const rest = elevenVoices.filter((v) => v.language !== langCode);
    for (const [group, list] of [[`${langCode === "ar" ? "Arabic" : "English"} voices`, native], ["Other languages", rest]]) {
      if (!list.length) continue;
      const g = document.createElement("optgroup");
      g.label = group;
      for (const v of list) {
        const o = document.createElement("option");
        o.value = v.id;
        o.textContent = [v.name, v.accent && v.accent !== "-" ? `(${v.accent})` : "", v.gender ? `· ${v.gender}` : ""]
          .filter(Boolean)
          .join(" ");
        g.appendChild(o);
      }
      sel.appendChild(g);
    }
  }

  const modelSel = $("elevenModel");
  modelSel.innerHTML = "";
  const useEnvModel = document.createElement("option");
  useEnvModel.value = "";
  useEnvModel.textContent = "Use ELEVENLABS_MODEL_ID from .env";
  modelSel.appendChild(useEnvModel);
  for (const m of ttsRes.elevenModels ?? []) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = `${m.label} — ${m.note}`;
    modelSel.appendChild(o);
  }

  $("elevenHint").textContent = elevenVoices.length
    ? `${elevenVoices.length} voices on this account, native ones listed first for each language.`
    : "Could not reach ElevenLabs — showing the saved values. Check ELEVENLABS_API_KEY, then reload.";

  /**
   * Akool avatars from the account, offered as suggestions on a still-typeable field.
   *
   * The hint carries the warning that matters more than the list: Akool bills the
   * *whole session window* it was asked for, not the seconds the avatar speaks, so
   * leaving sessions open is what drains an allowance — not talking a lot.
   */
  const akoolAvatars = akoolRes.avatars ?? [];
  const akoolList = $("akoolAvatarList");
  akoolList.innerHTML = "";
  for (const a of akoolAvatars) {
    const o = document.createElement("option");
    o.value = a.id;
    o.label = a.name;
    akoolList.appendChild(o);
  }
  $("akoolHint").innerHTML =
    (akoolAvatars.length
      ? `${akoolAvatars.length} avatars on this Akool account — start typing to pick one. `
      : `No avatars listed yet: add AKOOL_API_KEY (or the client id/secret pair) and AKOOL_AVATAR_ID to .env, then reload. `) +
    `<b style="color:var(--dv-intense-fire)">Akool charges for the session window, not for speech.</b> ` +
    `Credits are pre-charged for the full requested duration and only refunded when the session ends, ` +
    `so an idle open session costs the same as a busy one — close sessions between visitors.`;

  // Seed the test lab with the hard Arabic line, so the first thing an operator hears
  // is the case that actually discriminates between engines.
  select("testLang", "lang", "ar");
  $("testText").value = SAMPLE_LINES.ar;
  $("testText").dir = "rtl";

  // Provider picker. The subtitle on each button is the honest one-liner from the
  // registry — "not configured" is shown up front rather than discovered at a booth.
  const group = $("providerChoices");
  group.innerHTML = "";
  for (const p of providers) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.provider = p.id;
    b.textContent = p.label;
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
