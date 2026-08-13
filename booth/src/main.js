import { avatar } from "./avatar.js";
import { Mic } from "./mic.js";
import { fromBase64, durationMs } from "./audio.js";
import { currentLang, setLang, applyLang, t } from "./i18n.js";
import { initTheme, toggleTheme, currentTheme } from "./theme.js";

// The pre-paint script in index.html already stamped data-theme, so this is not what
// avoids a flash — it is what swaps the wordmark to the variant that survives on the
// current ground.
initTheme();

const SAMPLE_RATE = __SAMPLE_RATE__;
const $ = (id) => document.getElementById(id);

const lang = currentLang();
let S = t(lang); // UI strings for the page language

/** One booth visit. Rotated when someone new walks up, so history never leaks between people. */
let sessionId = crypto.randomUUID();
let busy = false;
let hasConversation = false;
let usable = false; // the booth has connected at least once and can take a question
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

/* ----------------------------------------------------------------- phases */

/**
 * What the booth is doing, as one value.
 *
 * Previously this lived across `busy`, a status string and four separate `disabled`
 * toggles, which meant no stylesheet could describe a state — every appearance change
 * had to be another imperative DOM write. Writing it to `data-phase` on <body> instead
 * puts all seven states in CSS, where they belong, and leaves this file deciding only
 * *which* state we are in.
 *
 * The badge word is not decoration: it is what makes the state readable to someone who
 * cannot tell the dot colours apart, and to a screen reader via role="status".
 */
const PHASES = {
  boot: { badge: "notConnected", dot: "" },
  attract: { badge: "ready", dot: "live" },
  connecting: { badge: "connecting", dot: "busy" },
  ready: { badge: "ready", dot: "live" },
  listening: { badge: "hearing", dot: "busy" },
  thinking: { badge: "thinking", dot: "busy" },
  speaking: { badge: "speaking", dot: "live" },
};

let phase = "boot";

function setPhase(next) {
  phase = next;
  document.body.dataset.phase = next;
  const p = PHASES[next] ?? PHASES.ready;
  $("state").textContent = S[p.badge] ?? p.badge;
  $("dot").className = `dot ${p.dot}`;

}

/** Back to whichever resting state matches where the visitor is in the conversation. */
const rest = () => setPhase(hasConversation ? "ready" : "attract");

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
    setFace(false);
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

/* --------------------------------------------------------------- the picture */

/**
 * Whether there is actually a face on screen.
 *
 * Tracked separately from the phase, and measured rather than inferred. `connect()`
 * resolving is not proof of a picture: the token endpoint hands one out freely, and
 * the vendor can still refuse the stream afterwards — Anam caps concurrent sessions,
 * so a tab left open elsewhere makes the next connect return a token that leads
 * nowhere. The old code trusted the resolve, so the booth would sit on a black
 * rectangle insisting it was listening.
 *
 * A <video> that is genuinely painting has non-zero intrinsic dimensions and is past
 * HAVE_CURRENT_DATA. Nothing else reliably distinguishes "connected" from "connected
 * to silence".
 */
const videoLive = () => {
  const v = $("avatar");
  return v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0;
};

function setFace(live) {
  document.body.dataset.face = live ? "live" : "none";
}

/** Resolve once the video paints, or false if it never does. */
function waitForPicture(timeoutMs = 9000) {
  if (videoLive()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const v = $("avatar");
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      for (const ev of EVENTS) v.removeEventListener(ev, onEvent);
      resolve(ok);
    };
    const onEvent = () => videoLive() && finish(true);
    const EVENTS = ["loadeddata", "playing", "resize", "canplay"];
    for (const ev of EVENTS) v.addEventListener(ev, onEvent);
    // Belt and braces: some renderers attach a track without firing anything useful.
    const poll = setInterval(onEvent, 250);
    const timer = setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * If the stream dies mid-session the picture goes with it, and the booth has to notice.
 * A visitor mid-question should be told the answer is coming as text, not left looking
 * at a black panel.
 */
for (const ev of ["emptied", "ended", "stalled", "suspend"]) {
  $("avatar").addEventListener(ev, () => {
    if (document.body.dataset.face === "live" && !videoLive()) {
      setFace(false);
      log("picture lost — continuing as text", true);
    }
  });
}

/** Bring the renderer up, or back up if it was released while nobody was here. */
async function ensureAvatar({ quiet = false } = {}) {
  if (avatar.client && videoLive()) return true;
  if (!quiet) setPhase("connecting");
  try {
    await avatar.connect("avatar", ctx);
    usable = true;
    enableControls(true);
    // Connecting is not the same as seeing something. Wait for real frames before
    // claiming there is a face.
    const painted = await waitForPicture();
    setFace(painted);
    if (!painted) {
      log("connected, but no video arrived — check for another open session", true);
      return false;
    }
    return true;
  } catch (err) {
    log(`connect failed: ${err.message}`, true);
    setFace(false);
    return false;
  }
}

function enableControls(on) {
  $("talk").disabled = !on;
  $("q").disabled = !on;
  $("reset").disabled = !on;
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
  showSources(null);
  $("metrics").textContent = "";
  log(automatic ? `idle ${settings.idleResetMinutes}m — conversation cleared` : "new visitor");

  if (automatic) {
    // Let the goodbye sit for a moment before the screen returns to the invitation.
    setTimeout(() => {
      $("subtitle").textContent = "";
      if (!busy) rest();
    }, 6000);
    // Only on the automatic path: a staffer pressing "new visitor" is telling us
    // somebody is standing there right now, and dropping the session in front of
    // them would make the booth look broken at exactly the wrong moment.
    await releaseAvatarIfIdle();
  } else {
    rest();
  }
}

/* ------------------------------------------------------------------ ask flow */

async function askQuestion(question, spokenLanguage = null) {
  if (busy || !usable) return;
  busy = true;
  touch();
  $("q").value = "";
  $("subtitle").textContent = "";
  showSources(null);
  setPhase("thinking");
  log(`Q: ${question}`);

  // The session may have been released while the stand was empty, or the renderer may
  // have dropped. Either way the answer engine is a separate service and still works,
  // so a failure here downgrades to text rather than refusing the question — the
  // visitor is mid-sentence and must not be met with a dead screen.
  const hasFace = await ensureAvatar({ quiet: true });
  if (!hasFace) log("answering without the avatar — text only", true);

  avatar.begin(SAMPLE_RATE, ctx);

  // Audio arrives faster than it can be spoken, so clips are queued and released in
  // real time. Without this the whole answer would be pushed into the renderer within
  // a second and the subtitles would race ahead of the voice.
  let playHead = Promise.resolve();
  const speakClip = (pcm, text, isFiller) => {
    playHead = playHead.then(async () => {
      if (!isFiller) $("subtitle").textContent = text;
      setPhase("speaking");
      avatar.push(pcm, ctx);
      await new Promise((r) => setTimeout(r, durationMs(pcm, SAMPLE_RATE)));
    });
  };

  const params = new URLSearchParams({ q: question, sid: sessionId, lang });
  if (spokenLanguage) params.set("spoken", spokenLanguage);

  await new Promise((resolve) => {
    const es = new EventSource(`/api/ask?${params}`);

    es.addEventListener("sentence", (e) => {
      const { text } = JSON.parse(e.data);
      // Text-mode renderers (Akool) speak our text in their own voice — there is no
      // audio to push, so the sentence itself is the payload.
      if (avatar.mode === "text") {
        $("subtitle").textContent = text;
        setPhase("speaking");
        avatar.say(text, ctx);
        return;
      }
      // No renderer at all: the sentence stream is the only thing left to show, so
      // it drives the subtitle directly.
      if (!avatar.client) {
        $("subtitle").textContent = text;
        setPhase("speaking");
      }
    });

    es.addEventListener("audio", (e) => {
      // Our TTS is unused in text mode, and there is nothing to play it into when the
      // renderer is down. Ignore the clips rather than double-speaking.
      if (avatar.mode === "text" || !avatar.client) return;
      const { pcm, text, filler } = JSON.parse(e.data);
      speakClip(fromBase64(pcm), text, filler);
    });

    es.addEventListener("done", (e) => {
      const d = JSON.parse(e.data);
      showSources(d.citations, d.grounded);
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
  busy = false;
  touch();
  rest();
}

/* ----------------------------------------------------------------- sources */

/**
 * Sources are one tap away rather than permanently on screen.
 *
 * Booth staff need to check what an answer was built on — an ungrounded answer is
 * exactly the one that could be wrong — but a visitor reading a face does not, and
 * a standing panel of quotes was competing with the answer itself for attention.
 * The count stays visible so nobody has to guess whether there is anything to open.
 */
function showSources(citations, grounded = true) {
  const btn = $("sourcesBtn");
  const panel = $("sources");
  const list = $("citations");

  if (!citations) {
    btn.hidden = true;
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    list.innerHTML = `<p class="empty">${S.sourcesEmpty}</p>`;
    return;
  }

  list.innerHTML = "";
  if (!citations.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = grounded ? S.noSources : S.ungrounded;
    list.appendChild(p);
  } else {
    for (const c of citations) {
      const div = document.createElement("div");
      div.className = "cite";
      const b = document.createElement("b");
      const span = document.createElement("span");
      b.textContent = c.title ?? "—";
      span.textContent =
        c.quote?.length > 220 ? `${c.quote.slice(0, 220)}…` : (c.quote ?? "");
      div.append(b, span);
      list.appendChild(div);
    }
  }

  // Label first, then reveal. The count *is* the button's accessible name, so
  // revealing it a frame early puts an unnamed control in the accessibility tree.
  $("sourcesCount").textContent = `${S.sourcesCount} · ${citations.length}`;
  btn.hidden = false;
}

$("sourcesBtn").onclick = () => {
  const open = $("sourcesBtn").getAttribute("aria-expanded") === "true";
  $("sourcesBtn").setAttribute("aria-expanded", String(!open));
  $("sources").hidden = open;
  touch();
};

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
  setPhase("listening");

  let clip = null;
  try {
    clip = await mic.listen({
      // Drives the glow around the button rather than a bar across it: this is
      // ambient "I can hear you" feedback, not a measurement anyone reads.
      onLevel: (v) => btn.style.setProperty("--level", v.toFixed(3)),
      onSpeechStart: () => ($("talkLabel").textContent = S.speakNow),
    });
  } catch (err) {
    log(`mic failed: ${err.message}`, true);
  } finally {
    btn.classList.remove("listening");
    btn.style.setProperty("--level", "0");
    $("talkLabel").textContent = S.talk;
  }

  if (!clip) {
    rest();
    log("heard nothing");
    return;
  }

  setPhase("thinking");
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
      rest();
      return;
    }

    const considered = (data.considered ?? [])
      .map((c) => `${c.language} ${c.confidence.toFixed(2)}`)
      .join(", ");
    log(`heard [${data.language}] (${considered}, ${data.ms}ms): ${data.transcript}`);

    // The language the visitor actually spoke wins over the page language.
    await askQuestion(data.transcript, data.language);
  } catch (err) {
    log(`stt failed: ${err.message}`, true);
    rest();
  }
};

/* ----------------------------------------------------------------- wiring */

$("q").addEventListener("keydown", (e) => {
  // A typed question carries no spoken language, so it falls back to the page's.
  if (e.key === "Enter" && $("q").value.trim()) askQuestion($("q").value.trim());
});

$("interrupt").onclick = () => {
  avatar.interrupt();
  rest();
  touch();
  log("interrupted");
};

$("langBtn").onclick = () => setLang(lang === "ar" ? "en" : "ar");

/* ------------------------------------------------------------------- theme */

/* Which glyph is visible is CSS's job — it keys off the same data-theme attribute that
 * colours the page, so the two cannot drift. All that is left here is the name, which
 * an icon-only button has no visible text to supply. It states the mode the press moves
 * *to*, matching the glyph, so a screen reader and a sighted visitor are told the same
 * thing. `applyLang` cannot do this one: the label changes on every press, not once at
 * load, so a data-t-label attribute would be right only until the first tap. */
const themeBtn = $("themeBtn");
const labelTheme = () => {
  themeBtn.setAttribute(
    "aria-label",
    currentTheme() === "dark" ? S.themeLight : S.themeDark,
  );
};
themeBtn.onclick = () => {
  toggleTheme();
  labelTheme();
  touch();
};
labelTheme();

/* No fullscreen control. The kiosk is launched in the browser's own kiosk mode at the
   stand, so a button that duplicates F11 was one more thing on a visitor's screen —
   and one more thing they could leave the booth in a strange state with. */

for (const el of ["talk", "q", "avatar"].map($)) {
  el?.addEventListener("pointerdown", touch);
}

/* ---------------------------------------------------------------- operator */

/**
 * Booth staff surface. Hidden by default — the log, the timings and the provider
 * state are what staff need to tell a mic failure from a network one, and none of
 * it is something a visitor at LEAP should be reading next to the answer.
 *
 * Two ways in, because a kiosk usually has no keyboard: a deliberate long press on
 * the logo, or Ctrl+Shift+O on the laptop it gets configured from. Neither is
 * reachable by tapping around.
 */
const LONG_PRESS_MS = 1500;
let pressTimer = 0;

function setOperator(open) {
  $("operator").hidden = !open;
  if (open) $("operatorClose").focus();
}

const logo = document.querySelector(".masthead .logo");
const startPress = () => {
  pressTimer = setTimeout(() => setOperator(true), LONG_PRESS_MS);
};
const cancelPress = () => clearTimeout(pressTimer);
if (logo) {
  logo.addEventListener("pointerdown", startPress);
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    logo.addEventListener(ev, cancelPress);
  }
  // A long press on an image is a drag gesture by default, which cancels the press.
  logo.addEventListener("dragstart", (e) => e.preventDefault());
}

addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === "KeyO") {
    e.preventDefault();
    setOperator($("operator").hidden);
  }
  if (e.key === "Escape" && !$("operator").hidden) setOperator(false);
});

$("operatorClose").onclick = () => setOperator(false);
$("connect").onclick = async () => {
  $("connect").disabled = true;
  await ensureAvatar();
  $("connect").disabled = false;
  rest();
};
$("reset").onclick = () => newVisitor();
/* -------------------------------------------------------------------- init */

S = applyLang(lang);
showSources(null);
setPhase("boot");

const suggest = $("suggest");
for (const s of S.suggestions) {
  const b = document.createElement("button");
  b.textContent = s;
  b.onclick = () => askQuestion(s);
  suggest.appendChild(b);
}

/**
 * The badge and the stop button sit above the glass sheet, and the sheet's height
 * depends on how the suggestion chips wrap — which changes with language and screen
 * width. Measuring it beats guessing: a hard-coded offset overlaps the sheet on the one
 * screen size nobody tested on. (The transcript and its sources moved to the rail and
 * are no longer part of this stack.)
 */
const sheet = $("sheet");
new ResizeObserver(([entry]) => {
  // borderBoxSize, not contentRect: the sheet carries ~18px of padding top and bottom
  // plus a 1px border, so the content box is ~37px shorter than the thing on screen.
  // Positioning against the content box tucked the badge and the stop button under
  // the sheet's own padding.
  const h = entry.borderBoxSize?.[0]?.blockSize ?? entry.target.getBoundingClientRect().height;
  document.documentElement.style.setProperty("--sheet-h", `${Math.round(h)}px`);
}).observe(sheet);

fetch("/api/settings")
  .then((r) => r.json())
  .then((s) => {
    settings = s;
    log(`ready — idle reset ${s.idleResetMinutes}m, voice ${lang === "en" ? s.voiceEn : s.voiceAr}`);
  })
  .catch(() => log("ready"));

// No Start button. A visitor at a stand does not press Start — they walk up and talk,
// so the session opens on load and the attract screen is what fills the wait.
(async () => {
  setPhase("connecting");
  const painted = await ensureAvatar({ quiet: true });
  if (painted) log("connected");
  // Either way the booth is open for questions: the answer engine is independent of
  // the renderer, so a missing picture costs the face, not the service. `data-face`
  // is already set, and the stage says so without blanking the screen.
  usable = true;
  enableControls(true);
  setPhase("attract");
})();
