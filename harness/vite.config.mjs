import { defineConfig } from "vite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HARNESS);
const AUDIO = path.join(ROOT, "fixtures", "audio");

try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {}

const json = (res, code, body) => {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

/**
 * Dev-only API. Vendor API keys stay on the server — the browser only ever sees
 * a short-lived session token. Same shape we'll want in production, so the Phase 1
 * app can lift these two handlers as-is.
 */
function harnessApi() {
  return {
    name: "harness-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://localhost");

        try {
          // ---- fixture discovery: which voices have been rendered? ----------
          if (url.pathname === "/api/fixtures") {
            const out = [];
            for (const provider of await readdir(AUDIO).catch(() => [])) {
              for (const voice of await readdir(path.join(AUDIO, provider)).catch(() => [])) {
                const dir = path.join(AUDIO, provider, voice);
                const files = (await readdir(dir)).filter((f) => f.endsWith(".wav")).sort();
                if (files.length) out.push({ provider, voice, id: `${provider}/${voice}`, files });
              }
            }
            return json(res, 200, out);
          }

          // ---- serve a fixture wav ------------------------------------------
          if (url.pathname.startsWith("/api/audio/")) {
            const rel = decodeURIComponent(url.pathname.slice("/api/audio/".length));
            const file = path.resolve(AUDIO, rel);
            // Never let a crafted path escape the fixtures directory.
            if (!file.startsWith(AUDIO + path.sep)) return json(res, 403, { error: "forbidden" });
            const buf = await readFile(file);
            res.setHeader("content-type", "audio/wav");
            return res.end(buf);
          }

          // ---- Anam: mint a session token with audio passthrough on ---------
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
                  // The whole point of the bake-off: we supply the audio, Anam only lip-syncs.
                  enableAudioPassthrough: true,
                },
              }),
            });
            const body = await r.json().catch(() => ({}));
            return json(res, r.ok ? 200 : r.status, body);
          }

          // ---- HeyGen LiveAvatar LITE: token, then start -> livekit + ws ----
          if (url.pathname === "/api/heygen/session" && req.method === "POST") {
            const key = process.env.HEYGEN_API_KEY;
            if (!key) return json(res, 400, { error: "HEYGEN_API_KEY not set in .env" });

            const tokenRes = await fetch("https://api.liveavatar.com/v1/sessions/token", {
              method: "POST",
              headers: { "X-API-KEY": key, "Content-Type": "application/json" },
              body: JSON.stringify({
                mode: "lite", // LITE = we bring the audio, HeyGen renders only
                avatar_id: process.env.HEYGEN_AVATAR_ID,
              }),
            });
            const tokenBody = await tokenRes.json().catch(() => ({}));
            if (!tokenRes.ok) return json(res, tokenRes.status, tokenBody);

            const sessionToken = tokenBody?.data?.session_token;
            if (!sessionToken) return json(res, 502, { error: "no session_token", tokenBody });

            const startRes = await fetch("https://api.liveavatar.com/v1/sessions/start", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${sessionToken}`,
                "Content-Type": "application/json",
              },
              body: "{}",
            });
            const startBody = await startRes.json().catch(() => ({}));
            return json(res, startRes.ok ? 200 : startRes.status, startBody);
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
  root: HARNESS,
  plugins: [harnessApi()],
  // main.js imports ../../fixtures/phrases.ar.json — above the harness root,
  // so Vite needs explicit permission to read it.
  server: { port: 5173, open: true, fs: { allow: [ROOT] } },
});
