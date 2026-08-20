# syntax=docker/dockerfile:1.6
# Multi-stage production image for DriveS3 Gateway.

FROM oven/bun:1.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
RUN bun install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY scripts ./scripts
RUN bun run build

FROM oven/bun:1.2-slim AS runtime
ARG APP_UID=1010
ARG APP_GID=1010
RUN groupadd --system --gid "${APP_GID}" drives3 \
  && useradd --system --uid "${APP_UID}" --gid "${APP_GID}" \
             --home-dir /app --shell /usr/sbin/nologin drives3 \
  && install -d -o drives3 -g drives3 -m 0750 /app /app/data /app/data/multipart
WORKDIR /app

# Runtime assets: bundled server, built dashboard, migrations, .env.example.
COPY --from=build --chown=drives3:drives3 /app/dist ./dist
COPY --from=build --chown=drives3:drives3 /app/apps/server/src/db/migrations ./dist/server/migrations
COPY --chown=drives3:drives3 .env.example ./

ENV NODE_ENV=production \
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=8787 \
    SQLITE_PATH=/app/data/app.sqlite \
    MULTIPART_TEMP_DIR=/app/data/multipart \
    STATIC_ROOT=/app/dist/web \
    MIGRATIONS_DIR=/app/dist/server/migrations \
    RATE_LIMIT_ENABLED=true

USER drives3
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e 'const r=await fetch("http://127.0.0.1:8787/health/live"); if(!r.ok)process.exit(1)'

# Server startup validates config, opens SQLite, and runs all migrations before
# binding the HTTP socket.
CMD ["bun", "dist/server/index.js"]
