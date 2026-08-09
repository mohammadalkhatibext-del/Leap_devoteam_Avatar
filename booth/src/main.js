import { avatar } from "./avatar.js";
import { Mic } from "./mic.js";
import { fromBase64, durationMs } from "./audio.js";

const SAMPLE_RATE = __SAMPLE_RATE__;
const $ = (id) => document.getElementById(id);

/** One booth visit. Reset when someone new walks up, so history doesn't leak between people. */
let sessionId = crypto.randomUUID();
let busy = false;

const SUGGESTIONS = [
  "ما هي ديفوتيم؟",
  "هل لديكم مكاتب في السعودية؟",
  "كيف تدعمون رؤية ٢٠٣٠؟",
  "ما علاقتكم بجوجل كلاود؟",
  "What does Devoteam do?",
];

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

function setState(text, cls = "") {
  $("state").textContent = text;
  $("dot").className = `dot ${cls}`;
}

/* ------------------------------------------------------------------ ask flow */

async function askQuestion(question) {
  if (busy || !avatar.client) return;
  busy = true;
  $("q").value = "";
  $("subtitle").textContent = "";
  $("citations").innerHTML = '<p class="empty">…</p>';
  setState("يفكر", "busy");
  log(`Q: ${question}`);

  avatar.begin(SAMPLE_RATE, ctx);

  // Audio arrives faster than it can be spoken, so clips are queued and released in
  // real time. Without this the whole answer would be pushed into the renderer within
  // a second and the subtitles would race ahead of the voice.
  let playHead = Promise.resolve();
  const speakClip = (pcm, text, isFiller) => {
    playHead = playHead.then(async () => {
      if (!isFiller) $("subtitle").textContent = text;
      setState("يتحدث", "live");
      avatar.push(pcm);
      await new Promise((r) => setTimeout(r, durationMs(pcm, SAMPLE_RATE)));
    });
  };

  await new Promise((resolve) => {
    const es = new EventSource(
      `/api/ask?q=${encodeURIComponent(question)}&sid=${encodeURIComponent(sessionId)}`,
    );

    es.addEventListener("audio", (e) => {
      const { pcm, text, filler } = JSON.parse(e.data);
      speakClip(fromBase64(pcm), text, filler);
    });

    es.addEventListener("done", (e) => {
      const d = JSON.parse(e.data);
      renderCitations(d.citations, d.grounded);
      $("metrics").textContent =
        `first token ${d.timing.firstTokenMs}ms · answer ${d.timing.totalMs}ms · ` +
        `cache read ${d.usage.cacheRead} · out ${d.usage.output}`;
      log(`answered — ${d.citations.length} citations`);
      es.close();
      resolve();
    });

    es.addEventListener("failed", (e) => {
      const { error } = JSON.parse(e.data);
      log(`failed: ${error}`, true);
      $("subtitle").textContent = "عذراً، حدث خطأ. تفضلوا بسؤال أحد الزملاء في الجناح.";
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
  setState("جاهز", "live");
  busy = false;
}

function renderCitations(citations, grounded) {
  const el = $("citations");
  if (!citations?.length) {
    // Worth surfacing rather than hiding: an ungrounded answer is exactly the case
    // booth staff need to notice, because it is the one that could be wrong.
    el.innerHTML = `<p class="empty">${
      grounded ? "لا توجد مصادر." : "⚠ إجابة بدون مصدر — راجعها قبل الاعتماد عليها."
    }</p>`;
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

/* --------------------------------------------------------------------- wiring */

$("connect").onclick = async () => {
  $("connect").disabled = true;
  setState("جارٍ الاتصال", "busy");
  try {
    await avatar.connect("avatar", ctx);
    $("placeholder").style.display = "none";
    $("q").disabled = false;
    $("talk").disabled = false;
    $("interrupt").disabled = false;
    $("reset").disabled = false;
    $("q").focus();
    setState("جاهز", "live");
  } catch (err) {
    log(`connect failed: ${err.message}`, true);
    setState("فشل الاتصال");
    $("connect").disabled = false;
  }
};

$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && $("q").value.trim()) askQuestion($("q").value.trim());
});

/* ------------------------------------------------------------------- speaking */

const mic = new Mic();

$("talk").onclick = async () => {
  // Tapping while it is already listening means "I'm done" — the visitor should
  // never be stuck waiting for the silence timer if they want to cut it short.
  if (mic.recording) return mic.stop();
  if (busy) return;

  const btn = $("talk");
  btn.classList.add("listening");
  $("talkLabel").textContent = "أستمع إليك…";
  setState("يستمع", "busy");

  let clip = null;
  try {
    clip = await mic.listen({
      onLevel: (v) => ($("meterFill").style.width = `${v * 100}%`),
      onSpeechStart: () => ($("talkLabel").textContent = "تفضّل…"),
    });
  } catch (err) {
    log(`mic failed: ${err.message}`, true);
  } finally {
    btn.classList.remove("listening");
    $("talkLabel").textContent = "🎤 اضغط وتحدّث";
    $("meterFill").style.width = "0%";
  }

  if (!clip) {
    setState("جاهز", "live");
    log("heard nothing");
    return;
  }

  setState("يكتب ما قلت", "busy");
  try {
    const res = await fetch("/api/stt", {
      method: "POST",
      headers: { "content-type": clip.type || "audio/webm" },
      body: clip,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `stt ${res.status}`);

    if (!data.transcript) {
      // Say so out loud rather than failing silently — a booth visitor staring at a
      // motionless avatar has no way to tell "didn't hear you" from "crashed".
      log("transcript empty", true);
      $("subtitle").textContent = "ما سمعتك زين، ممكن تعيد؟";
      setState("جاهز", "live");
      return;
    }

    log(`heard (${data.confidence.toFixed(2)}, ${data.ms}ms): ${data.transcript}`);
    $("q").value = data.transcript;
    await askQuestion(data.transcript);
  } catch (err) {
    log(`stt failed: ${err.message}`, true);
    setState("جاهز", "live");
  }
};

$("interrupt").onclick = () => {
  avatar.interrupt();
  setState("جاهز", "live");
  log("interrupted");
};

$("reset").onclick = async () => {
  await fetch("/api/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  sessionId = crypto.randomUUID();
  $("subtitle").textContent = "";
  $("citations").innerHTML = '<p class="empty">تظهر هنا المصادر التي استند إليها الجواب.</p>';
  $("metrics").textContent = "";
  log("new visitor — conversation cleared");
};

const suggest = $("suggest");
for (const s of SUGGESTIONS) {
  const b = document.createElement("button");
  b.textContent = s;
  b.onclick = () => askQuestion(s);
  suggest.appendChild(b);
}

log("ready — press تشغيل to connect");
