import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BOOTH = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(BOOTH);

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

// `import()` of an absolute path is a URL, and on Windows "C:\..." parses as a
// protocol — so these must be converted to file:// URLs rather than passed raw.
const load = (...seg) => import(pathToFileURL(path.join(ROOT, ...seg)).href);

const { ask } = await load("server", "claude.mjs");
const { transcribe } = await load("server", "deepgram.mjs");
const { getSettings, saveSettings, resetSettings, DEFAULTS } = await load(
  "server",
  "settings.mjs",
);
const { createSession, listProviders } = await load("server", "providers.mjs");
const { ensureTts, prewarmFillers, filler, SpeechQueue, SAMPLE_RATE } = await load(
  "server",
  "tts.mjs",
);

const TTS_PORT = Number(process.env.TTS_PORT || 8765);

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

const voiceFor = (settings, language) =>
  language === "en" ? settings.voiceEn : settings.voiceAr;

async function warmFillers(settings) {
  return prewarmFillers({ ar: settings.voiceAr, en: settings.voiceEn });
}

function boothApi() {
  return {
    name: "booth-api",
    async configureServer(server) {
      const info = (m) => server.config.logger.info(`  ${m}`);

      /**
       * Last line of defence for an unattended kiosk.
       *
       * A booth runs for three days with nobody watching the terminal. One stray
       * rejected promise anywhere in this file would otherwise take the whole server
       * down and leave a dead screen on the stand — which is exactly what happened
       * when the TTS sidecar died mid-answer. Log it and keep serving.
       */
      process.on("unhandledRejection", (err) => {
        server.config.logger.error(`  unhandled rejection (kept running): ${err?.message ?? err}`);
      });

      // Start the TTS sidecar and render the filler clips before the first visitor,
      // so nobody pays that cost standing at the booth.
      const startTts = () =>
        ensureTts({ log: info })
          .then(async () => warmFillers(await getSettings()))
          .then((n) => info(`TTS ready — ${n} filler clips warm`))
          .catch((err) => server.config.logger.error(`  TTS unavailable: ${err.message}`));

      startTts();

      // The sidecar is a separate process and can die during an event. Nobody is
      // watching, so bring it back rather than waiting for someone to notice the
      // avatar has gone quiet.
      setInterval(async () => {
        try {
          const r = await fetch(`http://127.0.0.1:${TTS_PORT}/health`, {
            signal: AbortSignal.timeout(1500),
          });
          if (r.ok) return;
        } catch {
          /* fall through to restart */
        }
        server.config.logger.warn("  TTS sidecar not responding — restarting it");
        startTts();
      }, 20_000).unref?.();

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");

        try {
          // ---- avatar: start a session with whichever renderer is selected ----
          // One endpoint for all three vendors. The browser is told the `mode` so it
          // knows whether to push PCM (Anam, Simli) or send text (Akool).
          if (url.pathname === "/api/avatar/session" && req.method === "POST") {
            try {
              return json(res, 200, await createSession(await getSettings()));
            } catch (err) {
              server.config.logger.error(`  avatar session failed: ${err.message}`);
              return json(res, 502, { error: err.message });
            }
          }

          // Which renderers this machine can actually use, for the admin picker.
          if (url.pathname === "/api/avatar/providers") {
            return json(res, 200, { providers: listProviders() });
          }

          // ---- settings: what the operator can change ------------------------
          if (url.pathname === "/api/settings") {
            if (req.method === "GET") return json(res, 200, await getSettings());
            if (req.method === "POST") {
              const saved = await saveSettings(await readBody(req));
              // Voices may have changed; re-render the fillers so the next visitor
              // hears the new voice rather than a cached clip of the old one.
              warmFillers(saved).catch(() => {});
              return json(res, 200, saved);
            }
          }

          if (url.pathname === "/api/settings/reset" && req.method === "POST") {
            const saved = await resetSettings();
            warmFillers(saved).catch(() => {});
            return json(res, 200, saved);
          }

          if (url.pathname === "/api/settings/defaults") {
            return json(res, 200, DEFAULTS);
          }

          // ---- pickers for the admin page ------------------------------------
          if (url.pathname === "/api/avatars") {
            const key = process.env.ANAM_API_KEY;
            if (!key) return json(res, 200, { data: [] });
            const r = await fetch("https://api.anam.ai/v1/avatars", {
              headers: { Authorization: `Bearer ${key}` },
            });
            const body = await r.json().catch(() => ({}));
            return json(res, 200, { data: body.data ?? [] });
          }

          if (url.pathname === "/api/voices") {
            try {
              const r = await fetch(`http://127.0.0.1:${TTS_PORT}/voices`);
              return json(res, 200, await r.json());
            } catch {
              return json(res, 200, { voices: [] }); // sidecar down — admin still loads
            }
          }

          // ---- speech to text -------------------------------------------------
          // The browser posts the recorded clip; the Deepgram key never leaves here.
          if (url.pathname === "/api/stt" && req.method === "POST") {
            const audio = await readRaw(req);
            if (!audio.length) return json(res, 400, { error: "empty audio" });
            try {
              return json(
                res,
                200,
                await transcribe(audio, {
                  contentType: req.headers["content-type"] || "audio/webm",
                }),
              );
            } catch (err) {
              return json(res, 502, { error: err.message });
            }
          }

          // ---- reset a visitor's conversation --------------------------------
          if (url.pathname === "/api/reset" && req.method === "POST") {
            const { sessionId } = await readBody(req);
            sessions.delete(sessionId);
            return json(res, 200, { ok: true });
          }

          // ---- ask: stream sentences + their audio as they are produced ------
          if (url.pathname === "/api/ask") {
            const question = url.searchParams.get("q")?.trim();
            const sid = url.searchParams.get("sid") || "default";
            const defaultLanguage = url.searchParams.get("lang") === "en" ? "en" : "ar";
            const spoken = url.searchParams.get("spoken");
            const spokenLanguage = spoken === "ar" || spoken === "en" ? spoken : null;
            if (!question) return json(res, 400, { error: "q is required" });

            const settings = await getSettings();
            const answerLanguage = spokenLanguage || defaultLanguage;
            const voice = voiceFor(settings, answerLanguage);

            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            const send = (event, data) =>
              res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

            const t0 = Date.now();

            // Speak an acknowledgement immediately. Claude needs ~2 s and the first
            // sentence another ~1 s to synthesise; without this the avatar stands
            // frozen for three seconds, which visitors read as a crash rather than
            // as thinking.
            const ack = filler({ language: answerLanguage, voice });
            if (ack) {
              send("audio", {
                index: -1,
                text: ack.text,
                filler: true,
                pcm: ack.pcm.toString("base64"),
              });
            }

            const queue = new SpeechQueue(
              (pcm, { index, text }) =>
                send("audio", { index, text, pcm: pcm.toString("base64") }),
              { voice },
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

              // Keep a degraded answer out of history. If it goes in, the model reads
              // its own English as precedent and every later answer in this visitor's
              // conversation degrades too — one slip becomes a ruined session.
              if (result.leakedSource) {
                server.config.logger.warn(
                  `  answer read source text aloud — dropped from history: ${result.answer.slice(0, 90)}`,
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
                language: answerLanguage,
                timing: { ...result.timing, wallMs: Date.now() - t0 },
                usage: result.usage,
              });
            } catch (err) {
              server.config.logger.error(`  ask failed: ${err.message}`);

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
                      { voice },
                    );
                    q2.push(text);
                    await q2.drain();
                  } catch {
                    /* audio itself is down — the text above is all we can offer */
                  }
                }
              }
              send("failed", { error: err.message, fallback: fb?.enabled ?? false });
            }
            return res.end();
          }
        } catch (err) {
          return json(res, 500, { error: String(err?.message ?? err) });
        }

        next();
      });
    },
  };
}

export default defineConfig({
  root: BOOTH,
  plugins: [boothApi()],
  define: { __SAMPLE_RATE__: SAMPLE_RATE },
  build: {
    rollupOptions: {
      input: {
        booth: path.join(BOOTH, "index.html"),
        admin: path.join(BOOTH, "admin.html"),
      },
    },
  },
  server: { port: 5174, open: true, fs: { allow: [ROOT] } },
});
