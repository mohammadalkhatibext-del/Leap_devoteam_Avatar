# Devoteam LEAP booth — production image.
#
#   docker compose up --build     # then http://localhost:8080
#
# Two stages, so the ~200 MB of build toolchain never reaches the machine on the stand.
# The builder installs every dependency and runs Vite; the runtime gets the built
# assets, production dependencies and nothing else.

# ──────────────────────────────────────────────────────────────── build stage ──
# Pinned to a digest-stable minor rather than `20` or `latest`: the booth is rebuilt
# under pressure the week of an event, and a base image that moved underneath you is
# not a debugging session anyone wants on the show floor. Node 22 is the LTS the README
# recommends; 20.12 is the hard floor because every entry point calls
# process.loadEnvFile(), which does not exist before it.
FROM node:22.14-bookworm-slim AS build

WORKDIR /app

# Manifests first, on their own layer. Dependencies change far less often than source,
# so a normal code edit reuses this layer and skips the install entirely.
COPY package.json package-lock.json ./

# `npm ci` for a reproducible tree from the lockfile. --ignore-scripts is not an
# optimisation here, it is required: package.json's postinstall runs
# `npm --prefix harness install`, and harness/ is excluded by .dockerignore because it
# is the Phase 0 bake-off tool and has no business in a production image. Without the
# flag the build fails on a directory that is deliberately absent.
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY booth ./booth
COPY server ./server
COPY devoteam_information ./devoteam_information

RUN npm run build

# ────────────────────────────────────────────────────────────── runtime stage ──
FROM node:22.14-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    BOOTH_DIST=/app/dist

WORKDIR /app

# Production dependencies only. The booth server imports @anthropic-ai/sdk at runtime;
# Vite and the client SDKs are already compiled into dist/ and are not needed here.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
# The corpus is read from disk at runtime by server/corpus.mjs, not bundled.
COPY devoteam_information ./devoteam_information

# Operator settings live here and must survive a container replacement — a booth that
# forgets its avatar and voice every deploy is worse than one that cannot be redeployed.
# docker-compose.yml mounts a named volume over this. Created and owned before the
# USER switch below, or the unprivileged process cannot write to its own settings.
RUN mkdir -p /app/data && chown -R node:node /app/data

# Never root. If something does get through the booth's HTTP surface at an exhibition,
# the blast radius should be one unprivileged process in a container.
USER node

EXPOSE 8080

# Uses the API's own health endpoint, which deliberately does not call any vendor — see
# the note on /api/health. A check that failed when ElevenLabs was briefly slow would
# have Docker restart a booth that is answering questions perfectly well.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node directly as PID 1, with the signal handlers server/index.mjs installs, so
# `docker stop` closes the server cleanly instead of cutting off an avatar mid-sentence.
CMD ["node", "server/index.mjs"]
