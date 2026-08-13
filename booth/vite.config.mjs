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

const { boothApi, startTtsSupervisor, SAMPLE_RATE } = await load("server", "api.mjs");

/**
 * Mount the booth API on the dev server.
 *
 * Everything this plugin used to contain now lives in server/api.mjs, so that the
 * production server can run the identical code — see the header there. What is left is
 * genuinely Vite-shaped: adapt Vite's logger, and fall through to Vite's own
 * middleware for anything that is not an API call.
 */
function boothApiPlugin() {
  return {
    name: "booth-api",
    async configureServer(server) {
      const log = {
        info: (m) => server.config.logger.info(`  ${m}`),
        warn: (m) => server.config.logger.warn(`  ${m}`),
        error: (m) => server.config.logger.error(`  ${m}`),
      };

      /**
       * Last line of defence for an unattended kiosk.
       *
       * A booth runs for three days with nobody watching the terminal. One stray
       * rejected promise anywhere would otherwise take the whole server down and
       * leave a dead screen on the stand — which is exactly what happened when the
       * TTS sidecar died mid-answer. Log it and keep serving.
       */
      process.on("unhandledRejection", (err) => {
        log.error(`unhandled rejection (kept running): ${err?.message ?? err}`);
      });

      startTtsSupervisor({ log });

      const handle = boothApi({ log });
      server.middlewares.use(async (req, res, next) => {
        if (await handle(req, res)) return;
        next();
      });
    },
  };
}

/**
 * Work around a case bug in simli-client@3.0.2 that only exists on Linux.
 *
 * Its `dist/index.js` does `require("./Client")`, but the file it ships is
 * `dist/client.js` — lowercase. Windows and macOS have case-insensitive filesystems and
 * resolve it happily, so the build passes on every developer machine here. Linux does
 * not, and the build dies with:
 *
 *   Could not resolve "./Client" from "./Client?commonjs-external"
 *
 * Which is to say: this repo could not be built in a container or on any Linux host at
 * all, and nothing revealed that until it was containerised. Worth keeping in mind
 * before removing the Docker setup as "just for testing" — it is also the only thing
 * that compiles the booth the way a cloud host would.
 *
 * Deliberately narrow: one package, one specifier. A broad case-insensitive resolver
 * would paper over the same class of bug in our own imports, where it is a real defect
 * that should fail loudly. Remove this once simli-client ships a fixed dist.
 */
function fixSimliClientCasing() {
  return {
    name: "simli-client-casing",
    // Before @rollup/plugin-commonjs gets to it — by the time it appears as
    // "./Client?commonjs-external" the resolution has already failed.
    enforce: "pre",
    resolveId(source, importer) {
      if (source.split("?")[0] !== "./Client") return null;
      if (!importer || !importer.replace(/\\/g, "/").includes("/simli-client/")) return null;
      return path.join(path.dirname(importer), "client.js");
    },
  };
}

export default defineConfig({
  root: BOOTH,
  plugins: [fixSimliClientCasing(), boothApiPlugin()],
  define: { __SAMPLE_RATE__: SAMPLE_RATE },
  build: {
    // Written outside booth/ so the production server can serve a directory that is
    // not also the Vite root — and so a stray `dist` never gets picked up as a page.
    outDir: path.join(ROOT, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        booth: path.join(BOOTH, "index.html"),
        admin: path.join(BOOTH, "admin.html"),
      },
    },
  },
  server: { port: 5174, open: true, fs: { allow: [ROOT] } },
});
