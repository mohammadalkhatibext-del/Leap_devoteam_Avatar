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
const { ensureTts, prewarmFillers, filler, SpeechQueue, SAMPLE_RATE } = await load(
  "server",
  "tts.mjs",
);

const readRaw = (req) =>
  new Promise((resolve) => {
    const parts = [];
    req.on("data", (c) => parts.push(c));
    req.on("end", () => resolve(Buffer.concat(parts)));
  });

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

function boothApi() {
  return {
    name: "booth-api",
    async configureServer(server) {
      // Start the TTS sidecar and render the filler clips before the first visitor,
      // so nobody pays that cost standing at the booth.
      ensureTts({ log: (m) => server.config.logger.info(`  ${m}`) })
        .then(() => prewarmFillers())
        .then((n) => server.config.logger.info(`  TTS ready — ${n} filler clips warm`))
        .catch((err) => server.config.logger.error(`  TTS unavailable: ${err.message}`));

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");

        try {
          // ---- Anam: mint a passthrough session token -----------------------
          if (url.pathname === "/api/anam/token" && req.method === "POST") {
            const key = process.env.ANAM_API_KEY;
            if (!key) return json(res, 400, { error: "ANAM_API_KEY not set in .env" });

            const r = await fetch("https://api.anam.ai/v1/auth/session-token", {
              method: "POST",
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                personaConfig: {
                  name: "Devoteam LEAP",
                  avatarId: process.env.ANAM_AVATAR_ID,
                  enableAudioPassthrough: true,
                },
              }),
            });
            return json(res, r.ok ? 200 : r.status, await r.json().catch(() => ({})));
          }

          // ---- speech to text -------------------------------------------------
          // The browser posts the recorded clip; the Deepgram key never leaves here.
          if (url.pathname === "/api/stt" && req.method === "POST") {
            const audio = await readRaw(req);
            if (!audio.length) return json(res, 400, { error: "empty audio" });
            try {
              const r = await transcribe(audio, {
                contentType: req.headers["content-type"] || "audio/webm",
              });
              return json(res, 200, r);
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
            if (!question) return json(res, 400, { error: "q is required" });

            res.writeHead(200, {
              "content-type": "text/event-stream",
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
            const ack = filler();
            if (ack) {
              send("audio", {
                index: -1,
                text: ack.text,
                filler: true,
                pcm: ack.pcm.toString("base64"),
              });
            }

            const queue = new SpeechQueue((pcm, { index, text }) => {
              send("audio", { index, text, pcm: pcm.toString("base64") });
            });

            try {
              const result = await ask(question, {
                history: historyFor(sid),
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
                timing: { ...result.timing, wallMs: Date.now() - t0 },
                usage: result.usage,
              });
            } catch (err) {
              send("failed", { error: err.message });
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
  server: { port: 5174, open: true, fs: { allow: [ROOT] } },
});
