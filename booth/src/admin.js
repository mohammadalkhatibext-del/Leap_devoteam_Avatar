import { initTheme, toggleTheme, currentTheme } from "./theme.js";

const $ = (id) => document.getElementById(id);
const safeHtml = (id, html) => {
  const el = $(id);
  if (el) el.innerHTML = html;
};
const safeText = (id, text) => {
  const el = $(id);
  if (el) el.textContent = text;
};

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

/**
 * Display names for the gender pairs, so the summary can say who a visitor will hear
 * when the override fields are empty. Mirrors ELEVEN_VOICE_PAIRS in
 * server/tts-engines.mjs, which is the authority — this copy exists only because the
 * summary line renders before /api/tts/eleven-voices has necessarily answered, and a
 * summary that says "—" for a second on load reads as a misconfigured booth.
 */
const ELEVEN_PAIRS = {
  male: { ar: "Mohammed Almansari", en: "Sully" },
  female: { ar: "Abrar Sabbah", en: "Jessa" },
};

let voices = [];
let providers = [];
let ttsEngines = [];
let sttEngines = [];
let elevenVoices = [];
const DEFAULT_PROVIDER_ID = "anam";
const DEFAULT_STT_ENGINE = "deepgram";
const DEFAULT_SETTINGS = {
  avatarProvider: DEFAULT_PROVIDER_ID,
  ttsEngine: "elevenlabs",
  sttEngine: DEFAULT_STT_ENGINE,
  answerWords: 35,
  idleResetMinutes: 5,
  greetFirstAnswer: true,
  akoolSessionSeconds: 300,
  fallback: {
    enabled: true,
    mode: "speak",
    messageAr: "أعتذر، النظام ما يقدر يجاوب الحين. تفضلوا، أحد زملائي هنا في الجناح يسعده مساعدتكم.",
    messageEn: "I'm sorry — I can't answer right now. One of my colleagues here at the stand would be glad to help you.",
  },
  elevenVoiceAr: "2bnoa3wtrtcUW41TrSJM",
  elevenVoiceEn: "wAGzRVkxKEs8La0lmdrE",
  openaiVoice: "ash",
};
const TTS_DEFAULT_VOICES = {
  elevenlabs: {
    // Mohammed Almansari (Saudi, male) for Arabic, Sully for English.
    male: { ar: "2bnoa3wtrtcUW41TrSJM", en: "wAGzRVkxKEs8La0lmdrE" },
    female: { ar: "VwC51uc4PUblWEJSPzeo", en: "yj30vwTGJxSHezdAGsv9" },
  },
  openai: { male: "ash", female: "nova" },
};
const DEFAULT_ELEVENLABS_VOICE_NAMES = {
  male: { ar: "Mohammed Almansari", en: "Sully" },
  female: { ar: "Abrar Sabbah", en: "Jessa" },
};
const DEFAULT_TTS_ENGINE = "elevenlabs";

/**
 * Match on the name loosely, because the vendor's own names are not clean data. The
 * account's "Mohammed Almansari" is returned with a leading space, and "Jessa" is
 * returned as a sentence-long description — an exact === match misses both, falls
 * through to the id below, and the booth quietly speaks in a different voice than the
 * page claims. That is how the male default ended up being Mazen Lawand.
 */
function findVoiceIdByName(name) {
  const want = name.trim().toLowerCase();
  const all = elevenVoices ?? [];
  const norm = (v) => (v.name ?? "").trim().toLowerCase();
  return (all.find((v) => norm(v) === want) ?? all.find((v) => norm(v).startsWith(want)))?.id;
}

function resolveDefaultElevenVoicePair(gender) {
  const fallback = TTS_DEFAULT_VOICES.elevenlabs[gender] ?? TTS_DEFAULT_VOICES.elevenlabs.male;
  const names = DEFAULT_ELEVENLABS_VOICE_NAMES[gender] ?? DEFAULT_ELEVENLABS_VOICE_NAMES.male;
  const ar = findVoiceIdByName(names.ar) ?? fallback.ar;
  const en = findVoiceIdByName(names.en) ?? fallback.en;
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
  "idleDisconnectMinutes",
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
  s.avatarProvider = selected("providerChoices", "provider") || DEFAULT_PROVIDER_ID;
  s.ttsEngine = selected("ttsChoices", "engine") || defaultTtsEngine();
  s.sttEngine = selected("sttChoices", "engine") || DEFAULT_STT_ENGINE;
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
  s.greetFirstAnswer = $("greetFirstAnswer").checked;
  s.requireTapToStart = $("requireTapToStart").checked;
  s.idleDisconnectMinutes = Number(s.idleDisconnectMinutes) || 2;
  s.answerModel = selected("modelChoices", "model") || "claude-sonnet-5";
  // The old dedicated gender picker is gone; the TTS gender buttons are the control
  // now. Follow them, so the server-side pair fallback in tts-engines.mjs agrees with
  // what the operator actually chose if the explicit voice ids are ever cleared.
  s.voiceGender = selected("genderChoices", "gender") || gender;

  // Framing is per renderer, and the page only ever edits the one that is selected —
  // so the other two have to be carried through from the last known server state or
  // saving would silently reset them to whatever the defaults happen to be.
  const provider = s.avatarProvider;
  s.stageFraming = {
    ...(saved?.stageFraming ?? {}),
    [provider]: {
      fit: selected("fitChoices", "fit") || "cover",
      zoom: Number($("stageZoom").value) || 1,
      focusY: Number($("stageFocusY").value) || 22,
    },
  };
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
  $("requireTapToStart").checked = s.requireTapToStart !== false;
  select("modelChoices", "model", s.answerModel ?? "claude-sonnet-5");
  select("genderChoices", "gender", s.voiceGender ?? "male");
  select("akoolSessionChoices", "seconds", s.akoolSessionSeconds ?? 300);
  $("fallbackEnabled").checked = !!s.fallback?.enabled;
  $("fallbackAr").value = s.fallback?.messageAr ?? "";
  $("fallbackEn").value = s.fallback?.messageEn ?? "";
  applyFallbackSettings();
  select("lengthChoices", "words", nearestLength(s.answerWords));
  select("fallbackMode", "mode", s.fallback?.mode ?? "speak");
  select("providerChoices", "provider", s.avatarProvider ?? DEFAULT_PROVIDER_ID);
  const ttsValue = (s.ttsEngine && ttsEngines.some((e) => e.id === s.ttsEngine)) ? s.ttsEngine : defaultTtsEngine();
  select("ttsChoices", "engine", ttsValue);
  select("sttChoices", "engine", s.sttEngine ?? DEFAULT_STT_ENGINE);
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
  applyFraming();
  renderPreview();
}

/**
 * Load the framing controls with the selected renderer's numbers.
 *
 * Called on every provider change as well as on load, because the two sliders mean
 * something different depending on which renderer is selected — leaving Anam's numbers
 * on screen after switching to Simli would have an operator adjust one avatar's crop
 * and save it onto another's.
 */
function applyFraming() {
  const provider = selected("providerChoices", "provider") || "anam";
  const frame = saved?.stageFraming?.[provider] ?? { fit: "cover", zoom: 1, focusY: 22 };
  select("fitChoices", "fit", frame.fit ?? "cover");
  $("stageZoom").value = frame.zoom ?? 1;
  $("stageFocusY").value = frame.focusY ?? 22;
  showFraming();
}

/** Echo the values as words — a slider with no readout cannot be reproduced tomorrow. */
function showFraming() {
  const zoom = Number($("stageZoom").value);
  const contain = selected("fitChoices", "fit") === "contain";
  $("stageZoomOut").textContent = `${Math.round(zoom * 100)}%`;
  $("stageFocusYOut").textContent = `${$("stageFocusY").value}% from the top`;
  $("framingHint").textContent = contain
    ? zoom > 1
      ? "The whole frame fits, then scales past the edges — the top and bottom may be cropped."
      : "The whole frame fits inside the stage. Nothing is cropped — use this if the head is cut off."
    : zoom < 1
      ? "Filled and cropped, then pulled back inside the stage."
      : zoom > 1
        ? "Filled and cropped, then pushed past the edges."
        : "The video fills the stage, cropped to fit.";
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

  if ("microsoftVoiceFields" in window && $("microsoftVoiceFields")) $("microsoftVoiceFields").hidden = e?.voiceMode !== "microsoft";
  if ("elevenVoiceFields" in window && $("elevenVoiceFields")) $("elevenVoiceFields").hidden = e?.voiceMode !== "pair";
  if ("voiceEnField" in window && $("voiceEnField")) $("voiceEnField").hidden = e?.voiceMode !== "microsoft";
  if ("openaiVoiceFields" in window && $("openaiVoiceFields")) $("openaiVoiceFields").hidden = id !== "openai";
  if ("ttsGenderFields" in window && $("ttsGenderFields")) $("ttsGenderFields").hidden = !["elevenlabs", "openai"].includes(id);
  const gender = selected("ttsGenderChoices", "gender") || (id === "openai" ? "male" : "male");
  select("ttsGenderChoices", "gender", gender);

  const renderer = providers.find((x) => x.id === (selected("providerChoices", "provider") || "anam"));
  const ttsHint = $("ttsHint");
  if (renderer?.mode === "text") {
    if (ttsHint) {
      ttsHint.textContent = `${renderer.label} uses its own voice, so the TTS settings below do not apply.`;
    }
    return;
  }

  if (!ttsHint) return;
  ttsHint.textContent = !e
    ? "Choose the provider and voice used by the avatar."
    : id === "elevenlabs"
      ? "Supports natural Arabic and English voices."
      : id === "openai"
        ? "Supports both Arabic and English using the selected voice."
        : "Choose the provider and voice used by the avatar.";
}

/** Keep the session-length hint in step with the buttons. */
function applyAkoolSession() {
  const hint = $("akoolSessionHint");
  if (!hint) return;
  hint.textContent = "Shorter sessions reduce the cost per visitor.";
}

function applySttEngine() {
  const id = selected("sttChoices", "engine") || "deepgram";
  const e = sttEngines.find((x) => x.id === id);
  const sttHint = $("sttHint");
  if (!sttHint) return;
  sttHint.textContent = !e
    ? ""
    : id === "deepgram"
      ? "Optimized for reliable Arabic and English speech recognition."
      : "Supports automatic speech recognition for both Arabic and English.";
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
  const id = selected("providerChoices", "provider") || DEFAULT_PROVIDER_ID;
  const p = providers.find((x) => x.id === id);

  const anamFields = $("anamFields"); if (anamFields) anamFields.hidden = id !== "anam";
  const simliFields = $("simliFields"); if (simliFields) simliFields.hidden = id !== "simli";
  const akoolFields = $("akoolFields"); if (akoolFields) akoolFields.hidden = id !== "akool";
  applyFraming();

  const usesOurVoice = p?.mode !== "text";

  const voiceHint = $("voiceHint");
  if (voiceHint) {
    voiceHint.textContent = usesOurVoice
      ? "The selected avatar provider uses the TTS settings below."
      : "Akool uses its own voice, so the TTS settings below do not apply.";
  }

  if (ttsEngines.length) applyTtsEngine();
}

/** Snap an arbitrary saved word count to the closest of the three presets. */
function nearestLength(words) {
  const options = [...$("lengthChoices").children].map((b) => Number(b.dataset.words));
  return String(options.reduce((a, b) => (Math.abs(b - words) < Math.abs(a - words) ? b : a)));
}

function selected(groupId, key) {
  const group = $(groupId);
  return group?.querySelector('[aria-pressed="true"]')?.dataset[key];
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
    const chevron = btn.querySelector(".chevron");
    if (chevron) chevron.textContent = expanded ? "▴" : "▾";
  };
  btn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    sync();
  });
  sync();
}

function seedDefaultUi() {
  const providerGroup = $("providerChoices");
  if (providerGroup && !providerGroup.children.length) {
    for (const option of [
      { id: "anam", label: "Anam" },
      { id: "simli", label: "Simli" },
      { id: "akool", label: "Akool" },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.provider = option.id;
      btn.textContent = option.label;
      providerGroup.appendChild(btn);
    }
  }
  if (providerGroup) select("providerChoices", "provider", DEFAULT_PROVIDER_ID);

  const ttsGroup = $("ttsChoices");
  if (ttsGroup && !ttsGroup.children.length) {
    for (const option of [
      { id: "elevenlabs", label: "ElevenLabs" },
      { id: "openai", label: "OpenAI" },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.engine = option.id;
      btn.textContent = option.label;
      ttsGroup.appendChild(btn);
    }
  }
  if (ttsGroup) select("ttsChoices", "engine", "elevenlabs");

  const sttGroup = $("sttChoices");
  if (sttGroup && !sttGroup.children.length) {
    for (const option of [
      { id: "deepgram", label: "Deepgram" },
      { id: "openai", label: "OpenAI" },
    ]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.engine = option.id;
      btn.textContent = option.label;
      sttGroup.appendChild(btn);
    }
  }
  if (sttGroup) select("sttChoices", "engine", DEFAULT_STT_ENGINE);

  if ($("ttsGenderChoices")) {
    select("ttsGenderChoices", "gender", "male");
  }
  if ($("fallbackEnabled")) $("fallbackEnabled").checked = true;
  if ($("fallbackMode")) select("fallbackMode", "mode", "speak");
  if ($("fallbackAr")) $("fallbackAr").value = DEFAULT_SETTINGS.fallback.messageAr;
  if ($("fallbackEn")) $("fallbackEn").value = DEFAULT_SETTINGS.fallback.messageEn;
  if ($("elevenVoiceAr")) $("elevenVoiceAr").value = DEFAULT_SETTINGS.elevenVoiceAr;
  if ($("elevenVoiceEn")) $("elevenVoiceEn").value = DEFAULT_SETTINGS.elevenVoiceEn;
  if ($("openaiVoice")) $("openaiVoice").value = DEFAULT_SETTINGS.openaiVoice;
  if ($("avatarId")) $("avatarId").value = "";

  write(DEFAULT_SETTINGS);
  renderPreview();
}

for (const groupId of [
  "lengthChoices",
  "fallbackMode",
  "providerChoices",
  "ttsChoices",
  "ttsGenderChoices",
  "sttChoices",
  "akoolSessionChoices",
  "modelChoices",
  "fitChoices",
]) {
  // Guarded because this page is assembled from two layouts — a group that one of
  // them does not render must not take the whole script down on load.
  const group = $(groupId);
  if (!group) continue;
  group.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    for (const b of $(groupId).children) b.setAttribute("aria-pressed", String(b === btn));
    if (groupId === "fitChoices") showFraming();
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

if (!selected("providerChoices", "provider")) {
  select("providerChoices", "provider", DEFAULT_PROVIDER_ID);
}
if (!selected("ttsChoices", "engine")) {
  select("ttsChoices", "engine", DEFAULT_TTS_ENGINE);
}
if (!selected("sttChoices", "engine")) {
  select("sttChoices", "engine", DEFAULT_STT_ENGINE);
}

// The framing sliders echo their value as they move but only mark the form dirty on
// release. Firing `dirty()` on every pixel of a drag would flood the status line with
// "Unsaved changes" and make the readout unreadable while it is being read.
for (const id of ["stageZoom", "stageFocusY"]) {
  $(id).addEventListener("input", showFraming);
  $(id).addEventListener("change", dirty);
}

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
  // 1.4 words a second, measured on the shipping Arabic voice — see WORDS_PER_SECOND
  // in server/system-prompt.mjs. The old 2.2 was an English reading rate and told the
  // operator an answer would run half as long as it does.
  const seconds = Math.round(words / 1.4);
  // Name the face belonging to the selected renderer. Reading the Anam picker whatever
  // the provider was is how the summary came to say "Visitors meet Faisal via Akool"
  // while Akool was in fact set to Dalia.
  // An empty id means "follow .env", and the picker labels that "Use configured
  // avatar" — a sentence has to say it differently, so resolve to "" and let
  // providerLine word it.
  const optionText = (selId, value) =>
    value ? [...($(selId)?.options ?? [])].find((o) => o.value === value)?.textContent : "";
  const av =
    s.avatarProvider === "akool"
      ? optionText("akoolAvatarId", s.akoolAvatarId) || s.akoolAvatarId
      : s.avatarProvider === "simli"
        ? s.simliFaceId
        : optionText("avatarId", s.avatarId) || s.avatarId;
  const p = providers.find((x) => x.id === s.avatarProvider) ?? providers[0];
  const tts = ttsEngines.find((x) => x.id === s.ttsEngine) ?? ttsEngines[0];
  const stt = sttEngines.find((x) => x.id === s.sttEngine) ?? sttEngines[0];
  const providerName = p?.label ?? "Anam";

  const providerLine = av
    ? `Visitors meet <b>${escape(av)}</b> via <b>${escape(providerName)}</b>.`
    : `Visitors meet the <b>configured avatar</b> via <b>${escape(providerName)}</b>.`;

  // What the operator needs from this line is which voice a visitor will actually
  // hear. The gender buttons are the control on this page and read() maps them
  // straight onto the ElevenLabs pair / OpenAI voice, so resolve the name from the
  // selected gender rather than from the override fields — those are always filled in
  // now, and echoing a raw voice id back would tell the operator nothing.
  let voiceLine = `Voice is provided by <b>${escape(tts?.label ?? s.ttsEngine)}</b>.`;
  if (p?.mode === "text") {
    voiceLine = `Voice is provided by <b>${escape(providerName)}</b> and the external TTS engine is bypassed.`;
  } else if (tts?.id === "elevenlabs") {
    const gender = selected("ttsGenderChoices", "gender") || "male";
    const names = DEFAULT_ELEVENLABS_VOICE_NAMES[gender] ?? DEFAULT_ELEVENLABS_VOICE_NAMES.male;
    voiceLine = `Voice is provided by <b>ElevenLabs</b> using <b>${escape(names.ar)}</b> for Arabic and <b>${escape(names.en)}</b> for English.`;
  } else if (tts?.id === "openai") {
    const gender = selected("ttsGenderChoices", "gender") || "male";
    const voiceName = gender === "female" ? "Nova" : "Ash";
    voiceLine = `Voice is provided by <b>OpenAI</b> using <b>${escape(voiceName)}</b> for Arabic and English.`;
  } else if (tts?.voiceMode === "microsoft") {
    voiceLine =
      `Voice is provided by <b>${escape(tts.label ?? "Microsoft")}</b> using ` +
      `<b>${escape(shortVoice(s.voiceAr))}</b> for Arabic and <b>${escape(shortVoice(s.voiceEn))}</b> for English.`;
  }

  const preview = $("preview");
  if (preview) {
    preview.innerHTML = `
      ${providerLine}
      ${voiceLine}
      It listens with <b>${escape(stt?.label ?? s.sttEngine)}</b>.
      Answers run about <b>${seconds} seconds</b>, and it
      ${s.greetFirstAnswer ? "greets each visitor once" : "skips greetings"}.
      ${
        s.requireTapToStart
          ? `The avatar stays off until someone touches the screen, and closes itself again after
             <b>${s.idleDisconnectMinutes} minutes</b> of silence.`
          : `<b>The avatar connects on load and stays connected</b>, closing only after
             <b>${s.idleDisconnectMinutes} minutes</b> of silence.`
      }
      The conversation clears itself after <b>${s.idleResetMinutes} minutes</b> of silence.
      ${
        s.fallback.enabled
          ? `If an answer fails it ${s.fallback.mode === "speak" ? "says the fallback out loud" : "shows the fallback as a subtitle"}.`
          : `<b>If an answer fails it says nothing</b> — the screen will just sit there.`
      }
      ${s.extraKnowledge.trim() ? `It also knows <b>${s.extraKnowledge.trim().split("\n").filter(Boolean).length} extra fact(s)</b> you added.` : ""}
    `;
  }
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
  if (!box) return;
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

  const speakOne = $("speakOne");
  const speakAll = $("speakAll");
  const ttsResults = $("ttsResults");
  if (speakOne) speakOne.disabled = true;
  if (speakAll) speakAll.disabled = true;
  if (ttsResults) ttsResults.innerHTML = `<div class="result"><span class="meta">Synthesising…</span></div>`;
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
    if (ttsResults) ttsResults.innerHTML = "";
    status(err.message, "err");
  } finally {
    if (speakOne) speakOne.disabled = false;
    if (speakAll) speakAll.disabled = false;
  }
}

const speakOneBtn = $("speakOne");
const speakAllBtn = $("speakAll");
if (speakOneBtn) speakOneBtn.onclick = () => compareTts([selected("ttsChoices", "engine") || defaultTtsEngine()]);
if (speakAllBtn) speakAllBtn.onclick = () => compareTts(undefined);

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
      for (const t of stream.getTracks()) t.stop();
      const recBtn = $("recBtn");
      if (recBtn) {
        recBtn.textContent = "● Record a question";
        recBtn.classList.add("secondary");
      }
      await compareStt(new Blob(chunks, { type: recorder.mimeType }));
    };
    recorder.start();
    const recBtn = $("recBtn");
    if (recBtn) {
      recBtn.textContent = "■ Stop and transcribe";
      recBtn.classList.remove("secondary");
    }
    const sttResults = $("sttResults");
    if (sttResults) sttResults.innerHTML = "";
  } catch (err) {
    status(`Microphone unavailable: ${err.message}`, "err");
  }
}

async function compareStt(blob) {
  const sttResults = $("sttResults");
  if (sttResults) sttResults.innerHTML = `<div class="result"><span class="meta">Transcribing…</span></div>`;
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
    if (!box) return;
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
    const box = $("sttResults");
    if (box) box.innerHTML = "";
    status(err.message, "err");
  }
}

const recBtn = $("recBtn");
if (recBtn) recBtn.onclick = toggleRecording;

/* ------------------------------------------------------------------ status */

let statusTimer = 0;
function status(msg, kind = "") {
  clearTimeout(statusTimer);
  const statusEl = $("status");
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
  if (msg) statusTimer = setTimeout(() => { const el = $("status"); if (el) el.textContent = ""; }, 4000);
}

function dirty() {
  status("Unsaved changes");
}

for (const id of [
  ...TEXT_FIELDS,
  "greetFirstAnswer",
  "requireTapToStart",
  "fallbackEnabled",
  "fallbackAr",
  "fallbackEn",
]) {
  const el = $(id);
  if (!el) continue;
  el.addEventListener("input", () => {
    renderPreview();
    dirty();
  });
  el.addEventListener("change", () => {
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

/* The button says which theme is active rather than showing a glyph, so it has a real
   accessible name and an operator can tell the current state without squinting. */
function labelTheme() {
  $("themeBtn").textContent = currentTheme() === "dark" ? "Theme: dark" : "Theme: light";
}
$("themeBtn").onclick = () => {
  toggleTheme();
  labelTheme();
};

/* -------------------------------------------------------------------- init */

initTheme();
labelTheme();

async function boot() {
  const [settings, avatarsRes, voicesRes, providersRes, ttsRes, sttRes, elevenRes, akoolRes] = await Promise.all([
    fetch("/api/settings").then((r) => r.json()).catch(() => ({})),
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
    if (!group) return;
    if (!group.children.length) {
      const fallback = groupId === "ttsChoices"
        ? [{ id: "elevenlabs", label: "ElevenLabs" }]
        : [{ id: "deepgram", label: "Deepgram" }];
      const items = list.length ? list : fallback;
      for (const e of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.dataset.engine = e.id;
        b.textContent = e.label;
        group.appendChild(b);
      }
    }
  };
  engineButtons("ttsChoices", ttsEngines, (e) => e.cost);
  engineButtons("sttChoices", sttEngines, () => "ready");

  const openaiSel = $("openaiVoice");
  if (openaiSel) {
    openaiSel.innerHTML = "";
    for (const v of ttsRes.openaiVoices ?? []) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      openaiSel.appendChild(o);
    }
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
    if (!sel) continue;
    sel.innerHTML = "";
    if (!elevenVoices.length) {
      const savedId = settings[selId];
      sel.innerHTML = `<option value="${escape(savedId)}">${escape(savedId || "none configured")}</option>`;
      continue;
    }
    // The empty option is the normal state, not an escape hatch — with the Male/Female
    // switch above doing the work, most booths never touch these two. Naming it after
    // that switch rather than after an environment variable is what makes the
    // relationship visible to an operator who has never read the .env file.
    const useEnv = document.createElement("option");
    useEnv.value = "";
    useEnv.textContent = "Follow the Male / Female choice above";
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
  if (modelSel) {
    modelSel.innerHTML = "";
    const useEnvModel = document.createElement("option");
    useEnvModel.value = "";
    useEnvModel.textContent = "Use configured model";
    modelSel.appendChild(useEnvModel);
    for (const m of ttsRes.elevenModels ?? []) {
      const o = document.createElement("option");
      o.value = m.id;
      o.textContent = `${m.label} — ${m.note}`;
      modelSel.appendChild(o);
    }
  }

  const elevenHint = $("elevenHint");
  if (elevenHint) {
    elevenHint.textContent = elevenVoices.length
      ? "Supports natural Arabic and English voices."
      : "Supports natural Arabic and English voices.";
  }

  /**
   * Akool avatars from the account, offered as suggestions on a still-typeable field.
   *
   * The hint carries the warning that matters more than the list: Akool bills the
   * *whole session window* it was asked for, not the seconds the avatar speaks, so
   * leaving sessions open is what drains an allowance — not talking a lot.
   */
  // A select rather than the old text box with a datalist: a datalist still leaves the
  // raw id sitting in the field once picked, and "kWte7SV6zSTmF07UZF_lW" tells an
  // operator nothing about who is on screen.
  const akoolAvatars = akoolRes.avatars ?? [];
  const akoolSel = $("akoolAvatarId");
  if (akoolSel) {
    const savedAkoolId = settings.akoolAvatarId ?? "";
    akoolSel.innerHTML = "";

    const useEnv = document.createElement("option");
    useEnv.value = "";
    useEnv.textContent = "Use configured avatar";
    akoolSel.appendChild(useEnv);

    for (const a of akoolAvatars) {
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = a.name;
      akoolSel.appendChild(o);
    }

    // Same trap as Anam: a saved id this key cannot use fails at session-create, in
    // front of a visitor. Keep it visible and selected rather than silently reset.
    if (savedAkoolId && !akoolAvatars.some((a) => a.id === savedAkoolId)) {
      const missing = document.createElement("option");
      missing.value = savedAkoolId;
      missing.textContent = `⚠ ${savedAkoolId} — not available`;
      akoolSel.insertBefore(missing, akoolSel.firstChild);
    }
    akoolSel.value = savedAkoolId;
  }
  const akoolHint = $("akoolHint");
  if (akoolHint) {
    akoolHint.textContent = akoolAvatars.length
      ? `${akoolAvatars.length} avatars available.`
      : "Akool uses its own voice, so the TTS settings below do not apply.";
  }

  // Seed the test lab with the hard Arabic line, so the first thing an operator hears
  // is the case that actually discriminates between engines.
  select("testLang", "lang", "ar");
  $("testText").value = SAMPLE_LINES.ar;
  $("testText").dir = "rtl";

  // Provider picker. The subtitle on each button is the honest one-liner from the
  // registry — "not configured" is shown up front rather than discovered at a booth.
  const group = $("providerChoices");
  if (group && !group.children.length) {
    const providerList = providers.length ? providers : [{ id: "anam", label: "Anam" }];
    for (const p of providerList) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.provider = p.id;
      b.textContent = p.label;
      group.appendChild(b);
    }
  }

  // Avatars: real names from the account, so the operator picks a face not a UUID.
  const avatarSel = $("avatarId");
  if (avatarSel) {
    avatarSel.innerHTML = "";
    const avatars = avatarsRes.data ?? [];

    if (!avatars.length) {
      avatarSel.innerHTML = `<option value="${escape(settings.avatarId)}">${escape(settings.avatarId || "none configured")}</option>`;
      const avatarHint = $("avatarHint");
      if (avatarHint) avatarHint.textContent =
        "Could not reach Anam — showing the saved value. Check ANAM_API_KEY, then reload.";
    } else {
      // "Use the one from .env" has to be a real option, or an operator who has never
      // touched this page cannot tell what the booth is actually using.
      const useEnv = document.createElement("option");
      useEnv.value = "";
      useEnv.textContent = "Use configured avatar";
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
        const avatarHint = $("avatarHint");
        if (avatarHint) avatarHint.innerHTML =
          `<b style="color:var(--dv-poppy)">The saved avatar is not available on this Anam key.</b> ` +
          `The booth would connect and then show a black video. Pick one of the ${avatars.length} below and save.`;
      } else {
        const avatarHint = $("avatarHint");
        if (avatarHint) avatarHint.textContent =
          `The booth's ${avatars.length} faces.` +
          (savedId ? "" : " Currently following ANAM_AVATAR_ID from .env.");
      }
    }
  }

  for (const [selId, lang] of [["voiceAr", "ar"], ["voiceEn", "en"]]) {
    const sel = $(selId);
    if (!sel) continue;
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
  const defaultProvider = providers.find((p) => p.id === DEFAULT_PROVIDER_ID) ?? { id: DEFAULT_PROVIDER_ID, label: "Anam" };
  const fallbackTts = ttsEngines.find((e) => e.id === DEFAULT_TTS_ENGINE) ?? { id: DEFAULT_TTS_ENGINE, label: "ElevenLabs" };
  const fallbackStt = sttEngines.find((e) => e.id === DEFAULT_STT_ENGINE) ?? { id: DEFAULT_STT_ENGINE, label: "Deepgram" };
  settings.avatarProvider = settings.avatarProvider || defaultProvider.id;
  settings.ttsEngine = settings.ttsEngine || fallbackTts.id;
  settings.sttEngine = settings.sttEngine || fallbackStt.id;
  write(settings);
}

seedDefaultUi();
boot().catch((err) => status(`Could not load settings: ${err.message}`, "err"));
