import phrasesFile from "../../fixtures/phrases.ar.json";
import { parseWav } from "./wav.js";
import { anamAdapter } from "./adapters/anam.js";
import { heygenAdapter } from "./adapters/heygen.js";

const ADAPTERS = { anam: anamAdapter, heygen: heygenAdapter };
/** The three phrases that actually separate vendors — see README. */
const KEY_PHRASES = new Set(["02", "04", "07"]);

const $ = (id) => document.getElementById(id);
const phrases = phrasesFile.phrases;
const scores = {};
let adapter = null;
let fixtures = [];

/* ------------------------------------------------------------------ logging */

function log(msg, isError = false) {
  const el = $("log");
  const line = document.createElement("div");
  if (isError) line.className = "err";
  line.textContent = `${new Date().toLocaleTimeString("en-GB")}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
const ctx = { log };

/* -------------------------------------------------------------- phrase list */

function renderPhrases() {
  $("phrases").innerHTML = "";
  for (const p of phrases) {
    const key = KEY_PHRASES.has(p.id);
    const tr = document.createElement("tr");
    tr.id = `row-${p.id}`;
    if (key) tr.className = "key";

    tr.innerHTML = `
      <td><strong>${p.id}</strong></td>
      <td>
        <div class="ar">${p.ar}</div>
        <div class="tests">${key ? '<span class="badge">decisive</span> ' : ""}${p.tests}</div>
      </td>
      <td><span class="ms" id="ms-${p.id}"></span></td>
      <td><div class="score" id="score-${p.id}"></div></td>
    `;

    // Clicking the phrase plays it — one click, one utterance, score it, move on.
    tr.querySelector(".ar").style.cursor = "pointer";
    tr.querySelector(".ar").onclick = () => play(p);
    $("phrases").appendChild(tr);

    const holder = tr.querySelector(`#score-${p.id}`);
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement("button");
      b.textContent = n;
      b.setAttribute("aria-pressed", "false");
      b.onclick = () => {
        scores[p.id] = n;
        [...holder.children].forEach((c, i) => c.setAttribute("aria-pressed", String(i + 1 === n)));
      };
      holder.appendChild(b);
    }
  }
}

/* ------------------------------------------------------------------ playback */

async function play(p) {
  if (!adapter) return log("connect a renderer first", true);
  const set = fixtures.find((f) => f.id === $("voice").value);
  if (!set) return log("no fixture set selected", true);

  const row = $(`row-${p.id}`);
  document.querySelectorAll("tr.playing").forEach((r) => r.classList.remove("playing"));
  row.classList.add("playing");

  try {
    const res = await fetch(`/api/audio/${set.provider}/${set.voice}/${p.id}.wav`);
    if (!res.ok) throw new Error(`fixture ${p.id}.wav not found — render it first`);
    const { pcm, sampleRate, durationMs } = parseWav(await res.arrayBuffer());

    // Time-to-first-mouth-movement is the number a visitor actually feels.
    // We can only measure send-to-ack here; watch the video for the real thing.
    const t0 = performance.now();
    await adapter.speak(pcm, sampleRate, ctx);
    const sent = Math.round(performance.now() - t0);

    $(`ms-${p.id}`).textContent = `${sent} ms`;
    log(`${p.id}: ${Math.round(durationMs)} ms audio @ ${sampleRate} Hz, sent in ${sent} ms`);
    setTimeout(() => row.classList.remove("playing"), durationMs + 500);
  } catch (err) {
    row.classList.remove("playing");
    log(`${p.id}: ${err.message}`, true);
  }
}

/* -------------------------------------------------------------------- wiring */

$("connect").onclick = async () => {
  const kind = $("renderer").value;
  $("connect").disabled = true;
  try {
    adapter = ADAPTERS[kind];
    log(`connecting to ${adapter.name}…`);
    await adapter.connect("avatar", ctx);
    $("placeholder").style.display = "none";
    ["playAll", "interrupt", "disconnect"].forEach((id) => ($(id).disabled = false));
    log(`${adapter.name} ready`);
  } catch (err) {
    adapter = null;
    $("connect").disabled = false;
    log(`connect failed: ${err.message}`, true);
  }
};

$("playAll").onclick = async () => {
  for (const p of phrases) {
    await play(p);
    // Let each utterance finish before the next — otherwise we're testing the
    // renderer's queue, not its lip-sync.
    const res = await fetch(`/api/audio/${$("voice").value}/${p.id}.wav`).catch(() => null);
    if (res?.ok) {
      const { durationMs } = parseWav(await res.arrayBuffer());
      await new Promise((r) => setTimeout(r, durationMs + 800));
    }
  }
};

$("interrupt").onclick = () => { adapter?.interrupt(); log("interrupt sent"); };

$("disconnect").onclick = async () => {
  await adapter?.disconnect();
  adapter = null;
  $("placeholder").style.display = "grid";
  $("connect").disabled = false;
  ["playAll", "interrupt", "disconnect"].forEach((id) => ($(id).disabled = true));
  log("disconnected");
};

$("export").onclick = async () => {
  const rows = phrases.map((p) => {
    const bold = KEY_PHRASES.has(p.id);
    const label = bold ? `**${p.tests}**` : p.tests;
    return `| ${p.id} | ${label} | ${scores[p.id] ?? ""} | ${$(`ms-${p.id}`).textContent} |`;
  });
  const md = [
    `### Renderer: ${adapter?.name ?? "(not connected)"}`,
    `Fixture set: \`${$("voice").value}\``,
    "",
    "| # | What it tests | Lip-sync 1–5 | Send time |",
    "|---|---|---|---|",
    ...rows,
  ].join("\n");
  await navigator.clipboard.writeText(md);
  log("scores copied — paste into SCORING.md");
};

/* --------------------------------------------------------------------- init */

renderPhrases();

fixtures = await fetch("/api/fixtures").then((r) => r.json());
const sel = $("voice");
sel.innerHTML = "";
if (!fixtures.length) {
  sel.innerHTML = "<option>no fixtures — run: node scripts/render-tts.mjs azure</option>";
  log("no rendered audio found. Run `node scripts/render-tts.mjs azure` first.", true);
} else {
  for (const f of fixtures) {
    const o = document.createElement("option");
    o.value = f.id;
    o.textContent = `${f.provider} / ${f.voice}  (${f.files.length} phrases)`;
    sel.appendChild(o);
  }
  log(`${fixtures.length} fixture set(s) available`);
}
