import "./style.css";
import { avatar } from "./avatar.js";
import { Mic } from "./mic.js";
import { fromBase64, durationMs } from "./audio.js";
import { currentLang, setLang, applyLang, t } from "./i18n.js";
import { initTheme, toggleTheme } from "./theme.js";

const SAMPLE_RATE = __SAMPLE_RATE__;
const $ = (id) => document.getElementById(id);

const lang = currentLang();
let S = t(lang); // UI strings for the page language

/** One booth visit. Rotated when someone new walks up, so history never leaks between people. */
let sessionId = crypto.randomUUID();
let busy = false;
let hasConversation = false;
let settings = { idleResetMinutes: 5 };

/* ------------------------------------------------------------------- logging */

function log(msg, isError = false) {
  const el = $("log");
  const line = document.createElement("div");
  if (isError) line.className = "err";
  line.textContent = `${new Date().toLocaleTimeString("en-GB")}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
const ctx = { log };

function setState(key, cls = "") {
  $("state").textContent = S[key] ?? key;
  $("dot").className = `dot ${cls}`;
}

/* --------------------------------------------------------------- idle reset */

let lastActivity = Date.now();
const touch = () => (lastActivity = Date.now());

/**
 * Clear the conversation when a visitor walks away without pressing "new visitor".
 *
 * They will not press it — they get their answer and leave. Without this the next
 * person inherits a stranger's conversation: the avatar skips its greeting, answers
 * follow-ups to a question that was never asked, and in the worst case repeats
 * something the previous visitor said. The timeout is the operator's, from settings.
 */
setInterval(() => {
  if (busy || !hasConversation) return;
  const idleMs = Date.now() - lastActivity;
  if (idleMs < settings.idleResetMinutes * 60_000) return;
  newVisitor({ automatic: true });
}, 15_000);

/**
 * Close the renderer session when the stand goes quiet, for renderers that charge by
 * the open session rather than by speech.
 *
 * Akool pre-charges the whole requested window and only refunds the remainder once
 * the session ends, so a session left open over a coffee break costs exactly what a
 * busy one does. Releasing it turns an empty stand into an idle cost of zero; the
 * price is a few seconds of reconnect when the next visitor speaks, which is paid
 * while they are still finishing their question.
 *
 * Deliberately opt-in and provider-aware: Anam and Simli are not billed this way, and
 * dropping their session would trade an instant start for nothing.
 */
async function releaseAvatarIfIdle() {
  if (!settings.releaseAvatarWhenIdle || !avatar.billsBySession || !avatar.client) return;
  try {
    await avatar.disconnect();
    $("placeholder").style.display = "";
    setState("ready", "live");
    log("session released — no charge while the stand is empty");
  } catch (err) {
    log(`could not release the session: ${err.message}`, true);
  }
}

/**
 * A closed tab must not leave a paid session running.
 *
 * `pagehide` rather than `beforeunload`: it is the one that fires reliably when a tab
 * is closed, the browser is quit, or the machine suspends the page — which at a booth
 * means the end of the day, the most expensive moment to leak a window. sendBeacon
 * rather than fetch, because a normal request is cancelled as the page goes away, and
 * that cancellation is exactly the case this handler exists to cover.
 */
addEventListener("pagehide", () => {
  if (!avatar.billsBySession || !avatar.sessionId) return;
  navigator.sendBeacon(
    "/api/avatar/close",
    new Blob([JSON.stringify({ provider: avatar.provider, sessionId: avatar.sessionId })], {
      type: "application/json",
    }),
  );
});

/** Bring the renderer back up if it was released while nobody was here. */
async function ensureAvatar() {
  if (avatar.client) return true;
  setState("connecting", "busy");
  try {
    await avatar.connect("avatar", ctx);
    $("placeholder").style.display = "none";
    return true;
  } catch (err) {
    log(`reconnect failed: ${err.message}`, true);
    setState("connectFailed");
    return false;
  }
}

async function newVisitor({ automatic = false } = {}) {
  await fetch("/api/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }).catch(() => {});
  sessionId = crypto.randomUUID();
  hasConversation = false;
  touch();
  $("subtitle").textContent = automatic ? S.idleReset : "";
  $("citations").innerHTML = `<p class="empty">${S.sourcesEmpty}</p>`;
  $("metrics").textContent = "";
  log(automatic ? `idle ${settings.idleResetMinutes}m — conversation cleared` : "new visitor");
  if (automatic) {
    setTimeout(() => ($("subtitle").textContent = ""), 6000);
    // Only on the automatic path: a staffer pressing "new visitor" is telling us
    // somebody is standing there right now, and dropping the session in front of
    // them would make the booth look broken at exactly the wrong moment.
    await releaseAvatarIfIdle();
  }
}

/* ------------------------------------------------------------------ ask flow */

async function askQuestion(question, spokenLanguage = null) {
  if (busy) return;
  // The session may have been released while the stand was empty. Bring it back
  // before anything else — the visitor is mid-question and must not see a dead screen.
  if (!(await ensureAvatar())) return;
  busy = true;
  touch();
  $("q").value = "";
  $("subtitle").textContent = "";
  $("citations").innerHTML = `<p class="empty">…</p>`;
  setState("thinking", "busy");
  log(`Q: ${question}`);

  avatar.begin(SAMPLE_RATE, ctx);

  // Audio arrives faster than it can be spoken, so clips are queued and released in
  // real time. Without this the whole answer would be pushed into the renderer within
  // a second and the subtitles would race ahead of the voice.
  let playHead = Promise.resolve();
  const speakClip = (pcm, text, isFiller) => {
    playHead = playHead.then(async () => {
      if (!isFiller) $("subtitle").textContent = text;
      setState("speaking", "live");
      avatar.push(pcm, ctx);
      await new Promise((r) => setTimeout(r, durationMs(pcm, SAMPLE_RATE)));
    });
  };

  const params = new URLSearchParams({ q: question, sid: sessionId, lang });
  if (spokenLanguage) params.set("spoken", spokenLanguage);

  await new Promise((resolve) => {
    const es = new EventSource(`/api/ask?${params}`);

    es.addEventListener("sentence", (e) => {
      // Text-mode renderers (Akool) speak our text in their own voice — there is no
      // audio to push, so the sentence itself is the payload and the subtitle is
      // driven from here rather than from clip playback.
      if (avatar.mode !== "text") return;
      const { text } = JSON.parse(e.data);
      $("subtitle").textContent = text;
      setState("speaking", "live");
      avatar.say(text, ctx);
    });

    es.addEventListener("audio", (e) => {
      // Our TTS is unused in text mode; ignore the clips rather than double-speaking.
      if (avatar.mode === "text") return;
      const { pcm, text, filler } = JSON.parse(e.data);
      speakClip(fromBase64(pcm), text, filler);
    });

    es.addEventListener("done", (e) => {
      const d = JSON.parse(e.data);
      renderCitations(d.citations, d.grounded);
      $("metrics").textContent =
        `first token ${d.timing.firstTokenMs}ms · answer ${d.timing.totalMs}ms · ` +
        `cache read ${d.usage.cacheRead} · out ${d.usage.output} · ${d.language}`;
      log(`answered in ${d.language} — ${d.citations.length} citations`);
      hasConversation = true;
      es.close();
      resolve();
    });

    es.addEventListener("failed", (e) => {
      const { error, fallback } = JSON.parse(e.data);
      log(`failed: ${error}`, true);
      if (!fallback) $("subtitle").textContent = S.error;
      es.close();
      resolve();
    });

    es.onerror = () => {
      es.close();
      resolve();
    };
  });

  await playHead; // let the last clip finish before returning to idle
  avatar.end();
  setState("ready", "live");
  touch();
  busy = false;
}

function renderCitations(citations, grounded) {
  const el = $("citations");
  if (!citations?.length) {
    // Worth surfacing rather than hiding: an ungrounded answer is exactly the case
    // booth staff need to notice, because it is the one that could be wrong.
    el.innerHTML = `<p class="empty">${grounded ? S.noSources : S.ungrounded}</p>`;
    return;
  }
  el.innerHTML = "";
  for (const c of citations) {
    const div = document.createElement("div");
    div.className = "cite";
    div.innerHTML = `<b></b><span></span>`;
    div.querySelector("b").textContent = c.title ?? "—";
    div.querySelector("span").textContent =
      c.quote?.length > 220 ? `${c.quote.slice(0, 220)}…` : (c.quote ?? "");
    el.appendChild(div);
  }
}

/* --------------------------------------------------------------------- mic */

const mic = new Mic();

$("talk").onclick = async () => {
  // Tapping while it is already listening means "I'm done" — the visitor should
  // never be stuck waiting for the silence timer if they want to cut it short.
  if (mic.recording) return mic.stop();
  if (busy) return;
  touch();

  const btn = $("talk");
  btn.classList.add("listening");
  $("talkLabel").textContent = S.listening;
  setState("hearing", "busy");

  let clip = null;
  try {
    clip = await mic.listen({
      onLevel: (v) => ($("meterFill").style.width = `${v * 100}%`),
      onSpeechStart: () => ($("talkLabel").textContent = S.speakNow),
    });
  } catch (err) {
    log(`mic failed: ${err.message}`, true);
  } finally {
    btn.classList.remove("listening");
    $("talkLabel").textContent = S.talk;
    $("meterFill").style.width = "0%";
  }

  if (!clip) {
    setState("ready", "live");
    log("heard nothing");
    return;
  }

  setState("transcribing", "busy");
  try {
    const res = await fetch("/api/stt", {
      method: "POST",
      headers: { "content-type": clip.type || "audio/webm" },
      body: clip,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `stt ${res.status}`);

    if (!data.transcript) {
      // Say so rather than failing silently — a booth visitor staring at a motionless
      // avatar has no way to tell "didn't hear you" from "crashed".
      log("transcript empty", true);
      $("subtitle").textContent = S.heardNothing;
      setState("ready", "live");
      return;
    }

    const considered = (data.considered ?? [])
      .map((c) => `${c.language} ${c.confidence.toFixed(2)}`)
      .join(", ");
    log(`heard [${data.language}] (${considered}, ${data.ms}ms): ${data.transcript}`);
    $("q").value = data.transcript;

    // The language the visitor actually spoke wins over the page language.
    await askQuestion(data.transcript, data.language);
  } catch (err) {
    log(`stt failed: ${err.message}`, true);
    setState("ready", "live");
  }
};

/* ----------------------------------------------------------------- wiring */

$("connect").onclick = async () => {
  $("connect").disabled = true;
  setState("connecting", "busy");
  try {
    await avatar.connect("avatar", ctx);
    $("placeholder").style.display = "none";
    for (const id of ["q", "talk", "interrupt", "reset"]) $(id).disabled = false;
    $("q").focus();
    setState("ready", "live");
    touch();
  } catch (err) {
    log(`connect failed: ${err.message}`, true);
    setState("connectFailed");
    $("connect").disabled = false;
  }
};

$("q").addEventListener("keydown", (e) => {
  // A typed question carries no spoken language, so it falls back to the page's.
  if (e.key === "Enter" && $("q").value.trim()) askQuestion($("q").value.trim());
});

$("interrupt").onclick = () => {
  avatar.interrupt();
  setState("ready", "live");
  touch();
  log("interrupted");
};

$("reset").onclick = () => newVisitor();

$("langBtn").onclick = () => setLang(lang === "ar" ? "en" : "ar");
$("themeBtn").onclick = () => log(`theme: ${toggleTheme()}`);

for (const el of ["talk", "q", "avatar"].map($)) {
  el?.addEventListener("pointerdown", touch);
}

/* -------------------------------------------------------------------- init */

initTheme();
S = applyLang(lang);
$("placeholder").textContent = S.connect;
$("citations").innerHTML = `<p class="empty">${S.sourcesEmpty}</p>`;

const suggest = $("suggest");
for (const s of S.suggestions) {
  const b = document.createElement("button");
  b.textContent = s;
  b.onclick = () => askQuestion(s);
  suggest.appendChild(b);
}

fetch("/api/settings")
  .then((r) => r.json())
  .then((s) => {
    settings = s;
    log(`ready — idle reset ${s.idleResetMinutes}m, voice ${lang === "en" ? s.voiceEn : s.voiceAr}`);
  })
  .catch(() => log("ready"));
