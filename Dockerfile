# syntax=docker/dockerfile:1
#
# Trycord - single-container self-hosting image.
#
# The server process is the whole deployment: it serves the web client
# (frontend), the public/legal site (public/), the REST API and the
# WebSocket gateway on one port. There is no separate frontend container to
# wire up, which is the whole point of the "easy" path.
#
# Layout inside the image mirrors the repository layout on purpose:
#
#   /app/backend   application code, node_modules, dev.db
#   /app/frontend   static web client
#   /app/public           public site, terms.html, privacy.html
#   /data                 SQLite database + WAL sidecars      <- volume
#   /app/uploads          user uploads                        <- volume
#
# glibc base, not alpine: better-sqlite3 and bcrypt are native modules and
# musl prebuilds are not reliably available.

# ---------------------------------------------------------------------------
# Stage 1 - build native dependencies
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps

# build-essential + python3 are needed to compile better-sqlite3/bcrypt when
# no prebuilt binary matches this platform. python3 is not needed at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build/backend

# Copy manifests first so the dependency layer is cached until a dependency
# actually changes, not on every source edit.
COPY backend/package.json backend/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# Stage 2 - runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=9971 \
    HOST=0.0.0.0 \
    DB_CLIENT=sqlite \
    DB_FILE=/data/trycord.db \
    UPLOAD_DIR=/app/uploads \
    SERVER_HOST_TYPE=express

# tini reaps zombies and forwards SIGTERM so the container stops promptly
# instead of waiting out the 10s kill timeout.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /build/backend/node_modules ./backend/node_modules
COPY backend/package.json       ./backend/
COPY backend/src                 ./backend/src
COPY backend/scripts             ./backend/scripts
COPY frontend                     ./frontend
COPY public                             ./public

# Writable state. The SQLite file and WAL sidecars land in /data; uploads in
# /app/uploads. Both are declared as volumes in compose so they survive
# `docker compose down` and image upgrades.
RUN mkdir -p /data /app/uploads \
 && chown -R node:node /data /app/uploads /app/backend

WORKDIR /app/backend
USER node

EXPOSE 9971
VOLUME ["/data", "/app/uploads"]

# The real health endpoint, which also proves the database is reachable -
# a process that is up but cannot reach its DB is not healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||9971)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# ENTRYPOINT is tini so it is PID 1 and reaps children; CMD is the server.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
