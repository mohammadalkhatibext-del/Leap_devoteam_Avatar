import { avatar } from "./avatar.js";
import { Mic } from "./mic.js";
import { fromBase64, durationMs } from "./audio.js";
import { currentLang, setLang, applyLang, t } from "./i18n.js";
import { initTheme } from "./theme.js";

// The pre-paint script in index.html already stamped data-theme, so this is not what
// avoids a flash — it is what swaps the wordmark to the variant that survives on the
// current ground. The booth has no theme control of its own: the switch lives in
// Settings, and the booth reads the choice on load.
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
let settings = {
  idleResetMinutes: 5,
  idleDisconnectMinutes: 2,
  requireTapToStart: true,
  stageFraming: {},
};

/**
 * Whether a person has actually asked for the avatar.
 *
 * The booth used to connect on load, which meant the stand held a live vendor session
 * from the moment someone opened the tab in the morning until it was closed at night —
 * billed or concurrency-capped all day for an empty screen. It also gave the visitor
 * no moment they consented to: the face was simply already looking at them.
 *
 * So nothing connects until this is true, and it goes back to false when the stand
 * goes quiet. See `wake()` and `sleep()`.
 */
let awake = false;

/* ------------------------------------------------------------------- logging */

function log(msg, isError = false) {
  const el = $("log");
  const line = document.createElement("div");
  if (isError) line.className = "err";
  line.textContent = `${new Date().toLocaleTimeString("en-GB")}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
/**
 * What the adapters are handed. `log` reaches the operator panel; `onProvider` fires
 * as soon as the server has said which vendor this session is, so the stage can be
 * framed for it without waiting on a connection that may never report success.
 */
const ctx = {
  log,
  onProvider: (provider) => {
    document.body.dataset.provider = provider ?? "";
    applyFraming(provider);
  },
};

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
  /** Nothing connected, waiting for a tap. The stand's resting state all day. */
  asleep: { badge: "tapToStart", dot: "" },
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

/**
 * Back to whichever resting state matches where we are.
 *
 * Three, not two: asleep when nobody has tapped, attract when connected but nobody has
 * spoken yet, ready mid-conversation. Collapsing the first two is what would let a
 * disconnected booth sit there showing "ready" and swallow the next question.
 */
const rest = () => setPhase(!awake ? "asleep" : hasConversation ? "ready" : "attract");

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
  if (busy) return;
  const idleMs = Date.now() - lastActivity;

  // Clearing the conversation and dropping the session are separate decisions on
  // separate clocks, so they are checked separately. In practice the disconnect fires
  // first (2 minutes against 5), which is correct: the face should go before the words
  // do, because the face is the part that costs money to keep.
  if (hasConversation && idleMs >= settings.idleResetMinutes * 60_000) {
    newVisitor({ automatic: true });
    return;
  }
  if (awake && idleMs >= settings.idleDisconnectMinutes * 60_000) sleep();
}, 5_000);

/**
 * Open a renderer session, because somebody just asked for one.
 *
 * The only path to a live avatar. Idempotent, so the visitor mashing the panel while
 * it negotiates does not open three sessions on top of each other — which on Anam
 * would exhaust the concurrent-session cap and leave the booth staring at a token that
 * leads nowhere.
 */
let waking = null;
async function wake({ quiet = false } = {}) {
  if (awake && videoLive()) return true;
  if (waking) return waking;
  log("waking the avatar");
  waking = (async () => {
    awake = true;
    touch();
    const painted = await ensureAvatar({ quiet });
    if (!painted) log("woke without a picture — answering as text", true);
    // Only take the screen back if nothing else is using it. A wake triggered from
    // mid-question has already put the booth in `thinking`, and overwriting that with
    // `attract` would tell the visitor their question had been forgotten.
    if (!busy) rest();
    return painted;
  })();
  try {
    return await waking;
  } finally {
    waking = null;
  }
}

/**
 * Drop the renderer session when the stand goes quiet.
 *
 * Every vendor charges for an open session somehow — Akool pre-charges the whole
 * requested window and refunds only on close, Anam and Simli hold a concurrency slot
 * and a live WebRTC stream. None of them are worth paying for a screen nobody is
 * standing at, and at an exhibition that is most of the day.
 *
 * The price is a few seconds of reconnect on the next tap. That is the right place to
 * spend it: the visitor has just reached for the screen and is still settling, rather
 * than mid-question with an answer owed to them.
 */
async function sleep() {
  if (!awake) return;
  awake = false;
  // The controls stay enabled. `awake` governs the renderer session, not the booth:
  // the answer engine is a separate service that works perfectly well without a face,
  // so a sleeping stand can still take a question and speak it — it just wakes up
  // first. Disabling the mic here would make a quiet stand look like a broken one.
  try {
    await avatar.disconnect();
    log(`idle ${settings.idleDisconnectMinutes}m — avatar session closed`);
  } catch (err) {
    log(`could not close the session: ${err.message}`, true);
  }
  setFace(false);
  document.body.dataset.provider = "";
  setPhase("asleep");
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
    /**
     * A painting video wins over a resolved promise.
     *
     * Simli's `SimliClient.start()` brings the stream up and then simply never
     * settles — verified in the browser: `videoWidth` reaches 512 and a face is on
     * screen while the await below is still pending. Waiting on the SDK left the
     * booth stuck in `connecting`, refusing questions, in front of a working avatar.
     *
     * So the two are raced. `videoLive()` was already this file's definition of
     * "there is a face" — measured rather than inferred, because a resolved connect
     * proves nothing when a vendor hands out a token and then refuses the stream.
     * Racing simply applies that same standard to the connect itself. The connect
     * promise is still kept and its rejection still handled, so a genuine failure is
     * reported rather than swallowed.
     */
    const connected = avatar.connect("avatar", ctx);
    connected.catch(() => {}); // handled below; this only stops an unhandled rejection

    const painted = await Promise.race([
      connected.then(() => waitForPicture()),
      waitForPicture(),
    ]).catch(() => false);

    usable = true;
    enableControls(true);
    setFace(painted);
    if (!painted) {
      // Surface why, if the connect itself is what failed. Awaiting here is safe: the
      // race is already over, so this cannot delay a booth that has a picture.
      await connected.catch((err) => log(`connect failed: ${err.message}`, true));
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

  // Deliberately does NOT drop the renderer session. A staffer pressing "new visitor"
  // is telling us somebody is standing there right now, and the idle timer above is
  // what decides when the face goes away. Tearing the avatar down in front of the
  // person it was just introduced to is the one moment it must not happen.
  if (automatic) {
    // Let the goodbye sit for a moment before the screen returns to the invitation.
    setTimeout(() => {
      $("subtitle").textContent = "";
      if (!busy) rest();
    }, 6000);
  } else {
    rest();
  }
}

/**
 * How much of the stage the video fills, per renderer.
 *
 * The vendors do not agree on how much of a person is in frame. Anam ships a portrait
 * already cropped to head and shoulders, so it wants filling; Simli's preset faces
 * arrive much tighter and at the same settings the top of the head is cut off by the
 * edge of the stage. Scaling is done here rather than in the stylesheet because the
 * numbers are operator settings — a new avatar id can need a different crop, and that
 * should not be a code change on the morning of an event.
 */
function applyFraming(provider) {
  const frame = settings.stageFraming?.[provider] ?? { fit: "cover", zoom: 1, focusY: 22 };
  const root = document.documentElement.style;
  root.setProperty("--stage-fit", frame.fit === "contain" ? "contain" : "cover");
  root.setProperty("--stage-zoom", String(frame.zoom ?? 1));
  root.setProperty("--stage-focus-y", `${frame.focusY ?? 22}%`);
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

  // The session may have been closed while the stand was empty, or the renderer may
  // have dropped. Either way the answer engine is a separate service and still works,
  // so a failure here downgrades to text rather than refusing the question — the
  // visitor is mid-sentence and must not be met with a dead screen.
  const hasFace = await wake({ quiet: true });
  if (!hasFace) log("answering without the avatar — text only", true);

  avatar.begin(SAMPLE_RATE, ctx);

  // Audio arrives faster than it can be spoken, so clips are queued and released in
  // real time. Without this the whole answer would be pushed into the renderer within
  // a second and the subtitles would race ahead of the voice.
  let playHead = Promise.resolve();
  let audioPlaybackStarts = 0;
  let playbackInterrupted = false;
  let playbackRestarted = false;
  const speakClip = (pcm, text) => {
    const durationSeconds = (durationMs(pcm, SAMPLE_RATE) / 1000).toFixed(2);
    audioPlaybackStarts += 1;
    console.log(
      `[audio] playback start #${audioPlaybackStarts} duration=${durationSeconds}s interrupted=${String(playbackInterrupted)} restarted=${String(playbackRestarted)}`,
    );
    playHead = playHead.then(async () => {
      $("subtitle").textContent = text;
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
      const { pcm, text } = JSON.parse(e.data);
      speakClip(fromBase64(pcm), text);
    });

    es.addEventListener("done", (e) => {
      const d = JSON.parse(e.data);
      showSources(d.citations, d.grounded);
      // firstSentence is the number that matters — it is when the mouth could start
      // moving. firstToken flatters the pipeline by over a second.
      $("metrics").textContent =
        `speak at ${d.timing.firstSentenceMs}ms (first token ${d.timing.firstTokenMs}ms) · ` +
        `answer ${d.timing.totalMs}ms · cache read ${d.usage.cacheRead} · ` +
        `out ${d.usage.output} · ${d.model ?? ""} · ${d.language}`;
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

  // Reaching for the microphone is as clear a request for the avatar as tapping the
  // panel, so it wakes it too rather than refusing. Not awaited: the connection
  // negotiates while the visitor is still drawing breath, and the answer engine works
  // without a face anyway, so making them wait for video before they may speak would
  // spend the reconnect twice.
  if (!awake) wake();

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

for (const el of ["talk", "q", "avatar"].map($)) {
  el?.addEventListener("pointerdown", touch);
}

/**
 * The whole stage is the start button.
 *
 * A kiosk visitor does not look for a control; they touch the picture of the person
 * they want to talk to. Making the entire panel the target means the gesture works
 * wherever they happen to reach, which on a large portrait screen matters more than
 * any affordance a small button could carry — and the attract copy says what to do.
 *
 * `pointerdown` rather than `click`: on a touch screen click waits out a ~300 ms
 * double-tap window on some browsers, and this is a moment where the booth is being
 * judged on whether it responded at all.
 */
const stage = document.querySelector(".stage");
stage?.addEventListener("pointerdown", (e) => {
  touch();
  // The controls that sit on top of the stage own their own taps. Without this the
  // stop button would also wake a sleeping booth, which is the opposite of what
  // somebody pressing stop is asking for.
  if (e.target.closest("button, input, a, .sheet")) return;
  if (!awake) wake();
});

// A keyboard is the accessible equivalent of the tap, and the panel is not focusable
// by default. Only while asleep: once awake this key belongs to the page again.
addEventListener("keydown", (e) => {
  if (awake || busy) return;
  if (e.key !== "Enter" && e.key !== " ") return;
  if (document.activeElement?.matches("input, button, a, textarea")) return;
  e.preventDefault();
  wake();
});

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
  await wake();
  $("connect").disabled = false;
};

// Staff need to be able to put the stand to sleep on demand — closing up for the night,
// or freeing the concurrency slot for whoever is testing on the other machine.
$("sleepNow").onclick = () => sleep();
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

/**
 * Boot: read the settings, then wait.
 *
 * Nothing connects here. The booth opens asleep and stays that way until somebody
 * touches the stage — see `wake()` for why. What the page does do immediately is
 * become answerable: the answer engine is independent of the renderer, so the
 * controls are live from the first paint and the first tap costs one connect rather
 * than a connect the visitor is watching.
 *
 * Settings are awaited rather than fired and forgotten, because two of them —
 * idleDisconnectMinutes and stageFraming — are wrong in a way a visitor would see if
 * a tap landed before they arrived.
 */
(async () => {
  try {
    settings = await (await fetch("/api/settings")).json();
    log(
      `ready — tap to start · avatar sleeps after ${settings.idleDisconnectMinutes}m · ` +
        `conversation clears after ${settings.idleResetMinutes}m`,
    );
  } catch {
    log("ready — settings unavailable, using defaults", true);
  }

  usable = true;
  enableControls(true);

  // An operator can turn the gate off for a demo, where a face already on screen when
  // someone walks into the room is the entire effect being demonstrated.
  if (settings.requireTapToStart === false) {
    await wake({ quiet: true });
    return;
  }
  setPhase("asleep");
})();
