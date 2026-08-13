/**
 * The production booth server.
 *
 *   npm run build && npm start          # http://localhost:8080
 *
 * Serves the built assets from dist/ and mounts the same API the dev server uses
 * (server/api.mjs). This is what runs in the container and at the event; `vite dev` is
 * for building the thing, not for standing in front of visitors for three days.
 *
 * No framework. The whole job is: static files with correct types, the API, and a
 * single-page fallback — about eighty lines of Node's own http module against a
 * dependency that would need patching, auditing and a version bump at the worst
 * possible moment. There is nothing here Express would do better.
 */

import http from "node:http";
import path from "node:path";
import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Load .env before anything reads a key. In the container the values usually arrive as
// real environment variables instead, and loadEnvFile does not overwrite those — which
// is the behaviour we want: `docker run -e` beats a stale file baked into an image.
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch {
  /* no .env — expected when the environment supplies the keys directly */
}

const { boothApi, startTtsSupervisor } = await import("./api.mjs");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const DIST = process.env.BOOTH_DIST || path.join(ROOT, "dist");

const log = {
  info: (m) => console.log(`  ${m}`),
  warn: (m) => console.warn(`  ${m}`),
  error: (m) => console.error(`  ${m}`),
};

/**
 * A booth runs unattended for three days. A single unhandled rejection anywhere must
 * not be the thing that leaves a dead screen on the stand.
 */
process.on("unhandledRejection", (err) => {
  log.error(`unhandled rejection (kept running): ${err?.message ?? err}`);
});
process.on("uncaughtException", (err) => {
  log.error(`uncaught exception (kept running): ${err?.stack ?? err}`);
});

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  // Fonts must carry a type or the browser refuses the preload in index.html and the
  // Arabic falls back to a system face — the exact failure the preloads exist to stop.
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
};

const handleApi = boothApi({ log });

/**
 * Resolve a URL path to a file inside dist/, or null.
 *
 * The `..` check is not ceremony: without it a request for
 * `/../../.env` reads the API keys straight out of the repo and returns them to
 * whoever asked. A kiosk on an exhibition network is exactly where that gets tried.
 */
async function resolveFile(pathname) {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
  const full = path.resolve(DIST, rel);
  if (full !== DIST && !full.startsWith(DIST + path.sep)) return null;
  try {
    const s = await stat(full);
    if (s.isDirectory()) return null;
    return { full, size: s.size };
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (await handleApi(req, res)) return;

    const url = new URL(req.url, "http://localhost");
    let pathname = url.pathname;
    if (pathname === "/") pathname = "/index.html";
    // Two pages, not a router: /admin is the settings surface and has its own entry.
    if (pathname === "/admin" || pathname === "/admin/") pathname = "/admin.html";

    const file = (await resolveFile(pathname)) ?? (await resolveFile("/index.html"));
    if (!file) {
      res.statusCode = 500;
      res.end(
        `Nothing to serve from ${DIST}. Run "npm run build" first, or point BOOTH_DIST at the built assets.`,
      );
      return;
    }

    const ext = path.extname(file.full).toLowerCase();
    res.setHeader("content-type", TYPES[ext] ?? "application/octet-stream");
    res.setHeader("content-length", file.size);

    /**
     * Vite hashes every asset filename, so anything under /assets/ is immutable by
     * construction and can be cached for a year. The HTML entry points must not be —
     * they are what point at the hashed names, and a cached index.html after a
     * redeploy loads asset URLs that no longer exist. That failure looks like a blank
     * screen at the stand and is fixed by a hard refresh nobody thinks to try.
     */
    res.setHeader(
      "cache-control",
      ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    );

    if (req.method === "HEAD") return res.end();
    createReadStream(file.full).pipe(res);
  } catch (err) {
    log.error(`request failed: ${err.message}`);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  }
});

// A booth answer streams for as long as the avatar is speaking, and Node closes idle
// sockets at two minutes by default. Nothing here should ever run that long, but a
// timeout that kills a live answer mid-sentence is a worse failure than a slow one.
server.headersTimeout = 0;
server.requestTimeout = 0;

startTtsSupervisor({ log });

server.listen(PORT, HOST, async () => {
  const settings = await import("./settings.mjs").then((m) => m.getSettings()).catch(() => null);
  console.log(`\n  Devoteam LEAP booth`);
  console.log(`  ➜  booth     http://localhost:${PORT}/`);
  console.log(`  ➜  settings  http://localhost:${PORT}/admin.html`);
  console.log(`  ➜  health    http://localhost:${PORT}/api/health`);
  if (settings) {
    console.log(
      `\n  ${settings.avatarProvider} · ${settings.ttsEngine} · ${settings.sttEngine} · ${settings.answerModel}`,
    );
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    log.error("ANTHROPIC_API_KEY is not set — the booth cannot answer anything.");
  }
  // Served from dist/, so a stale build is invisible until someone notices the booth
  // is missing a change. Print what is actually on disk.
  await readFile(path.join(DIST, "index.html"), "utf8").catch(() =>
    log.error(`no build found in ${DIST} — run "npm run build"`),
  );
  console.log("");
});

/**
 * Shut down on a signal rather than being killed.
 *
 * `docker stop` sends SIGTERM and waits ten seconds before SIGKILL. Closing the server
 * in that window lets an in-flight answer finish rather than cutting the avatar off
 * mid-sentence in front of somebody.
 */
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log.info(`${signal} — closing`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
