/**
 * The booth's HTTP API, as a plain request handler.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT IN vite.config.mjs ANY MORE
 *
 * It used to be, as a dev-server plugin. That worked for building, and it meant the
 * booth could only ever run under `vite dev` — a development server, with a file
 * watcher, on-the-fly transpilation and no asset hashing, holding a live avatar in
 * front of visitors for three days. There was no production mode at all, because the
 * API simply did not exist outside the dev server: `vite build` produced a booth that
 * could not answer a question.
 *
 * Everything here is therefore framework-agnostic — Node's own `req`/`res`, nothing
 * from Vite. `boothApi()` returns a handler that reports whether it took the request,
 * so the dev plugin can fall through to Vite's own middleware and the production
 * server can fall through to serving static files. One implementation, two hosts, and
 * no chance of the thing tested in development differing from the thing at the stand.
 * ────────────────────────────────────────────────────────────────────────────────
 */

import { ask } from "./claude.mjs";
import { fallbackProviders } from "./fallback-answer.mjs";
import { getSettings, saveSettings, resetSettings, DEFAULTS, ANSWER_MODELS } from "./settings.mjs";
import {
  createSession,
  closeSession,
  listProviders,
  listAkoolAvatars,
  boothAvatars,
} from "./providers.mjs";
import { prewarmEngine, speak, SpeechQueue, SAMPLE_RATE, toWav } from "./tts.mjs";
import {
  listTtsEngines,
  voiceFor,
  modelFor,
  listElevenVoices,
  TTS_ENGINES,
  OPENAI_VOICES,
  ELEVEN_MODELS,
} from "./tts-engines.mjs";
import { transcribe, transcribeAll, listSttEngines } from "./stt-engines.mjs";

export { SAMPLE_RATE };

const json = (res, code, body) => {
  res.statusCode = code;
  // Arabic transcripts and answers travel through here, so state the charset rather
  // than leaving it to the client's default.
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
  });

const readRaw = (req) =>
  new Promise((resolve) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
  });

/**
 * Per-visitor conversation state, in memory.
 *
 * A booth session is a person standing at a screen for two minutes; when they walk
 * away the conversation is over and worthless. Nothing here deserves a database —
 * and keeping it in memory means a restart wipes visitor questions, which is the
 * privacy-correct default rather than an oversight.
 */
const sessions = new Map();
const historyFor = (sid) => sessions.get(sid) ?? [];

/**
 * Warm the connection to whichever TTS engine is currently selected.
 *
 * `voiceFor` is asked per language rather than read out of the settings directly.
 * Both engines answer with the same voice for either language today, but asking keeps
 * the warm path identical to the answer path — and it was a mismatch between those two
 * that once warmed one engine while the booth spoke through another.
 */
async function warmEngine(settings) {
  const engine = settings.ttsEngine;
  return prewarmEngine(
    { ar: voiceFor(settings, engine, "ar"), en: voiceFor(settings, engine, "en") },
    engine,
    modelFor(settings, engine),
  );
}

/**
 * Warm the selected TTS engine at startup, and keep it warm.
 *
 * This used to also supervise a Python sidecar, which only edge-tts needed. edge-tts
 * is gone — both remaining engines are HTTP APIs — so the Python process, and the
 * "is it still alive" watchdog around it, went with it. What is left is a periodic
 * re-warm, which matters because a vendor will drop an idle connection during a quiet
 * hour at a stand and the next visitor would otherwise pay the cold start.
 *
 * Returns a stop function, so a caller that owns a lifecycle can shut the timer down
 * rather than leaking it.
 */
export function startTtsSupervisor({ log } = {}) {
  const info = log?.info ?? (() => {});
  const error = log?.error ?? (() => {});
  const warn = log?.warn ?? (() => {});

  const start = () =>
    getSettings()
      .then((settings) => warmEngine(settings))
      .then((n) => info(`TTS ready — ${n} voices warm`))
      .catch((err) => error(`TTS unavailable: ${err.message}`));

  start();

  const timer = setInterval(() => {
    start().catch(() => warn("TTS re-warm failed — the next answer pays the cold start"));
  }, 20_000);
  timer.unref?.();

  return () => clearInterval(timer);
}

/**
 * Build the API request handler.
 *
 * @param {{log?: {info: Function, warn: Function, error: Function}}} [opts]
 * @returns {(req, res) => Promise<boolean>}  true if the request was handled here
 */
export function boothApi({ log } = {}) {
  const info = log?.info ?? (() => {});
  const error = log?.error ?? (() => {});
  const warn = log?.warn ?? (() => {});

  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/")) return false;

    try {
      // ---- avatar: start a session with whichever renderer is selected ----
      // One endpoint for all three vendors. The browser is told the `mode` so it
      // knows whether to push PCM (Anam, Simli) or send text (Akool).
      if (url.pathname === "/api/avatar/session" && req.method === "POST") {
        try {
          json(res, 200, await createSession(await getSettings()));
        } catch (err) {
          error(`avatar session failed: ${err.message}`);
          json(res, 502, { error: err.message });
        }
        return true;
      }

      // ---- avatar: end a session that bills while it is open --------------
      // Distinct from the browser dropping the WebRTC room, which is the cheap
      // half: for Akool the room is the picture and the *session* is the meter.
      // Always answers 200 — this is called from teardown paths, including a
      // sendBeacon from a page that is already going away, and a failed close
      // must not surface as a booth error. It is logged loudly instead, because
      // a close that quietly fails is a bill nobody sees until the invoice.
      if (url.pathname === "/api/avatar/close" && req.method === "POST") {
        const { provider, sessionId } = await readBody(req);
        const result = await closeSession(provider, sessionId);
        if (result.closed) {
          info(`avatar session closed: ${result.sessionId}`);
        } else if (!result.skipped) {
          // A session that would not close is money still burning, and the one
          // line an operator needs to see in a wall of server output.
          error(`avatar session NOT closed — STILL BILLING: ${result.reason}`);
        }
        json(res, 200, result);
        return true;
      }

      // Which renderers this machine can actually use, for the admin picker.
      if (url.pathname === "/api/avatar/providers") {
        json(res, 200, { providers: listProviders() });
        return true;
      }

      // ---- settings: what the operator can change ------------------------
      if (url.pathname === "/api/settings") {
        if (req.method === "GET") {
          json(res, 200, await getSettings());
          return true;
        }
        if (req.method === "POST") {
          const saved = await saveSettings(await readBody(req));
          // The voice or engine may have changed; warm the new path so the next
          // visitor does not pay its cold start.
          warmEngine(saved).catch(() => {});
          json(res, 200, saved);
          return true;
        }
      }

      if (url.pathname === "/api/settings/reset" && req.method === "POST") {
        const saved = await resetSettings();
        warmEngine(saved).catch(() => {});
        json(res, 200, saved);
        return true;
      }

      if (url.pathname === "/api/settings/defaults") {
        json(res, 200, DEFAULTS);
        return true;
      }

      // ---- pickers for the admin page ------------------------------------
      if (url.pathname === "/api/avatars") {
        const key = process.env.ANAM_API_KEY;
        if (!key) {
          json(res, 200, { data: [] });
          return true;
        }
        const r = await fetch("https://api.anam.ai/v1/avatars", {
          headers: { Authorization: `Bearer ${key}` },
        });
        const body = await r.json().catch(() => ({}));
        // The picker shows the booth's two faces under the booth's own names, not
        // the ten this account happens to hold. See BOOTH_AVATARS.
        const data = boothAvatars("anam", body.data ?? []).map((a) => ({
          id: a.id,
          displayName: a.name,
          gender: a.gender,
        }));
        json(res, 200, { data });
        return true;
      }

      // ---- speech to text -------------------------------------------------
      // The browser posts the recorded clip; the vendor key never leaves here.
      if (url.pathname === "/api/stt" && req.method === "POST") {
        const audio = await readRaw(req);
        if (!audio.length) {
          json(res, 400, { error: "empty audio" });
          return true;
        }
        const settings = await getSettings();
        try {
          json(
            res,
            200,
            await transcribe(audio, {
              engine: settings.sttEngine,
              contentType: req.headers["content-type"] || "audio/webm",
            }),
          );
        } catch (err) {
          json(res, 502, { error: err.message });
        }
        return true;
      }

      // ---- engine pickers + the settings-page test lab ---------------------
      // Which engines this machine can actually use, so the picker states
      // "not configured" up front rather than letting it be discovered at a booth.
      if (url.pathname === "/api/tts/engines") {
        json(res, 200, {
          engines: listTtsEngines(),
          openaiVoices: OPENAI_VOICES,
          elevenModels: ELEVEN_MODELS,
        });
        return true;
      }

      if (url.pathname === "/api/stt/engines") {
        json(res, 200, { engines: listSttEngines() });
        return true;
      }

      /** The models an operator may pick from, with their measured latency. */
      if (url.pathname === "/api/models") {
        json(res, 200, { models: ANSWER_MODELS });
        return true;
      }

      if (url.pathname === "/api/akool/avatars") {
        try {
          json(res, 200, { avatars: boothAvatars("akool", await listAkoolAvatars()) });
        } catch {
          json(res, 200, { avatars: [] }); // admin page still loads
        }
        return true;
      }

      if (url.pathname === "/api/tts/eleven-voices") {
        try {
          json(res, 200, { voices: await listElevenVoices() });
        } catch {
          json(res, 200, { voices: [] }); // admin page still loads
        }
        return true;
      }

      /**
       * Synthesise one line on every configured engine and hand back playable WAVs.
       *
       * The whole point is that the text is identical across engines — the same
       * controlled-experiment discipline Phase 0 used for renderers, where one
       * fixture set was rendered once and fed to every vendor. Anything that
       * varied the input would make the comparison worthless.
       *
       * WAV rather than raw PCM because this is the one consumer that is a plain
       * <audio> element rather than the booth's Web Audio pipeline; a RIFF header
       * costs 44 bytes and saves the admin page from owning a decoder.
       */
      if (url.pathname === "/api/tts/compare" && req.method === "POST") {
        const { text, language = "ar", engines, overrides } = await readBody(req);
        if (!text?.trim()) {
          json(res, 400, { error: "text is required" });
          return true;
        }

        /**
         * Test what the operator is about to save, not what is already saved.
         *
         * The page says "press Save to make this live", so the lab has to run on
         * the *unsaved* form state — otherwise picking a new voice and pressing
         * Compare silently synthesises the old one, and the operator debugs a
         * result that came from a voice they had already replaced on screen.
         * Only voice-shaped fields are accepted; nothing here can change the booth.
         */
        const savedSettings = await getSettings();
        const settings = {
          ...savedSettings,
          ...Object.fromEntries(
            [
              "elevenVoice",
              "elevenModel",
              "openaiVoice",
              // The gender toggle resolves to a voice, so the lab has to honour it or
              // it would audition the saved pair while the operator watches the new
              // one selected on screen.
              "voiceGender",
            ]
              .filter((k) => typeof overrides?.[k] === "string")
              .map((k) => [k, overrides[k]]),
          ),
        };
        const wanted =
          Array.isArray(engines) && engines.length
            ? engines
            : listTtsEngines()
                .filter((e) => e.configured)
                .map((e) => e.id);

        const results = await Promise.all(
          wanted.map(async (id) => {
            const label = TTS_ENGINES[id]?.label ?? id;
            const voice = voiceFor(settings, id, language);
            const model = modelFor(settings, id);
            const startedAt = Date.now();
            try {
              const pcm = await speak(text, { engine: id, voice, language, model });
              return {
                engine: id,
                label,
                ok: true,
                voice,
                ms: Date.now() - startedAt,
                seconds: +(pcm.length / 2 / SAMPLE_RATE).toFixed(1),
                chars: text.length,
                wav: toWav(pcm, SAMPLE_RATE).toString("base64"),
              };
            } catch (err) {
              // One failing engine must not sink the comparison — "ElevenLabs is
              // out of characters" is itself a result the operator needs to see.
              return { engine: id, label, ok: false, voice, error: err.message };
            }
          }),
        );
        json(res, 200, { results });
        return true;
      }

      /** The same idea for hearing: one clip, every configured STT engine. */
      if (url.pathname === "/api/stt/compare" && req.method === "POST") {
        const audio = await readRaw(req);
        if (!audio.length) {
          json(res, 400, { error: "empty audio" });
          return true;
        }
        json(res, 200, {
          results: await transcribeAll(audio, {
            contentType: req.headers["content-type"] || "audio/webm",
          }),
        });
        return true;
      }

      // ---- reset a visitor's conversation --------------------------------
      if (url.pathname === "/api/reset" && req.method === "POST") {
        const { sessionId } = await readBody(req);
        sessions.delete(sessionId);
        json(res, 200, { ok: true });
        return true;
      }

      /**
       * Liveness, for a container runtime and for the deployment's health checks.
       *
       * Deliberately does NOT call any vendor. A health endpoint that fails when
       * ElevenLabs is briefly slow would have an orchestrator kill and restart a booth
       * that is answering questions perfectly well — the cure being far worse than the
       * disease at a live event. This answers "is the server up and does it have a key
       * to work with", which is what a restart could actually fix.
       */
      if (url.pathname === "/api/health") {
        const settings = await getSettings().catch(() => null);
        const ok = !!settings && !!process.env.ANTHROPIC_API_KEY;
        json(res, ok ? 200 : 503, {
          ok,
          answerModel: settings?.answerModel ?? null,
          ttsEngine: settings?.ttsEngine ?? null,
          sttEngine: settings?.sttEngine ?? null,
          avatarProvider: settings?.avatarProvider ?? null,
          anthropicKey: !!process.env.ANTHROPIC_API_KEY,
          // Which safety nets are actually strung, in the order they would be tried.
          // Empty means a Claude failure goes straight to the operator's apology line,
          // and that is worth knowing before an event rather than during one.
          fallbackProviders: fallbackProviders(),
          uptimeSeconds: Math.round(process.uptime()),
        });
        return true;
      }

      // ---- ask: stream sentences + their audio as they are produced ------
      if (url.pathname === "/api/ask") {
        const question = url.searchParams.get("q")?.trim();
        const sid = url.searchParams.get("sid") || "default";
        const defaultLanguage = url.searchParams.get("lang") === "en" ? "en" : "ar";
        const spoken = url.searchParams.get("spoken");
        const spokenLanguage = spoken === "ar" || spoken === "en" ? spoken : null;
        if (!question) {
          json(res, 400, { error: "q is required" });
          return true;
        }

        const settings = await getSettings();
        const answerLanguage = spokenLanguage || defaultLanguage;
        const ttsEngine = settings.ttsEngine;
        const voice = voiceFor(settings, ttsEngine, answerLanguage);
        const ttsModel = modelFor(settings, ttsEngine);

        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
          // Nginx and most cloud proxies buffer responses by default, which for SSE
          // means the whole answer arrives at once at the end — every latency gain in
          // this pipeline silently undone by the reverse proxy in front of it.
          "x-accel-buffering": "no",
        });
        const send = (event, data) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

        const t0 = Date.now();

        // The server half of the stutter trace. Each clip is one TTS request, so the
        // count is also the request count, and the moment a clip is handed to the
        // renderer bounds when the booth could possibly have played it. Durations and
        // timings only — the answer text is a visitor's conversation and does not
        // belong in a log that outlives the session.
        let clips = 0;
        let spokenMs = 0;

        // No acknowledgement clip. The avatar's first sound is now the answer itself —
        // see the note where FILLERS used to live in server/tts.mjs for what replaced
        // it and why it must not come back untested.
        const queue = new SpeechQueue(
          (pcm, { index, text }) => {
            const ms = Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000);
            clips++;
            spokenMs += ms;
            info(`clip ${index} sent at ${Date.now() - t0}ms — ${ms}ms of audio`);
            send("audio", { index, text, pcm: pcm.toString("base64") });
          },
          { voice, engine: ttsEngine, language: answerLanguage, model: ttsModel },
        );

        try {
          const result = await ask(question, {
            history: historyFor(sid),
            defaultLanguage,
            spokenLanguage,
            onSentence: (s) => {
              send("sentence", { text: s });
              queue.push(s);
            },
          });
          await queue.drain();
          info(`answer spoke as ${clips} clip(s), ${spokenMs}ms of audio, ${Date.now() - t0}ms wall`);

          // A booth that answered on a spare model looks identical to one that never
          // stumbled, which is the point at the stand and a problem afterwards. Say it
          // in the log — this is the only record that the primary model is failing,
          // and at a live event nobody is watching a dashboard.
          if (result.attempts.length) {
            warn(
              `answer chain fell through to ${result.provider}/${result.model} — ` +
                result.attempts.map((a) => `${a.model ?? a.provider}: ${a.error}`).join(" | "),
            );
          }

          // Keep a degraded answer out of history. If it goes in, the model reads
          // its own English as precedent and every later answer in this visitor's
          // conversation degrades too — one slip becomes a ruined session.
          if (result.leakedSource) {
            warn(
              `answer read source text aloud — dropped from history: ${result.answer.slice(0, 90)}`,
            );
          } else {
            sessions.set(sid, [
              ...historyFor(sid),
              { role: "user", content: question },
              { role: "assistant", content: result.answer },
            ]);
          }

          send("done", {
            answer: result.answer,
            citations: result.citations,
            grounded: result.grounded,
            leakedSource: result.leakedSource,
            // Which model actually answered. Worth carrying to the operator panel: the
            // model is a settings choice now, and "why is it suddenly slower" is a
            // question whose answer is usually this field.
            model: result.model,
            // Which vendor wrote it, and what it had to walk past to get there. An
            // answer with an empty sources panel is normal from the OpenAI rung and
            // suspicious from Claude; without this field they are indistinguishable.
            provider: result.provider,
            attempts: result.attempts,
            language: answerLanguage,
            timing: { ...result.timing, wallMs: Date.now() - t0 },
            usage: result.usage,
          });
        } catch (err) {
          error(`ask failed: ${err.message}`);

          // The operator's fallback line, spoken in the visitor's language, so a
          // backend failure still looks like a person saying sorry rather than a
          // frozen face. See STRATEGY.md §5.
          const fb = settings.fallback;
          if (fb?.enabled) {
            const text = answerLanguage === "en" ? fb.messageEn : fb.messageAr;
            send("sentence", { text });
            if (fb.mode === "speak") {
              try {
                const q2 = new SpeechQueue(
                  (pcm, meta) => send("audio", { ...meta, pcm: pcm.toString("base64") }),
                  { voice, engine: ttsEngine, language: answerLanguage, model: ttsModel },
                );
                q2.push(text);
                await q2.drain();
              } catch {
                /* audio itself is down — the text above is all we can offer */
              }
            }
          }
          send("failed", {
            error: err.message,
            // Every rung that was tried, so the apology line can be traced to a cause
            // rather than to "ask failed". Empty when the failure was not the chain's.
            attempts: err.attempts ?? [],
            fallback: fb?.enabled ?? false,
          });
        }
        res.end();
        return true;
      }
    } catch (err) {
      json(res, 500, { error: String(err?.message ?? err) });
      return true;
    }

    // An /api/ path nobody claimed. Answering 404 here rather than falling through
    // stops a typo'd endpoint from being served the booth's index.html, which is how
    // a missing route ends up reported as "the API returns HTML".
    json(res, 404, { error: `no such endpoint: ${url.pathname}` });
    return true;
  };
}
