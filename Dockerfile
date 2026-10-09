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

# rclone, for rclone backup destinations. Off by default -- a Drive or S3
# destination needs none of it. Turn on with INSTALL_RCLONE=true (in .env for
# Compose, or --build-arg). The release is checked against rclone's SHA256SUMS.
FROM oven/bun:1.2-slim AS rclone
ARG INSTALL_RCLONE=false
ARG RCLONE_VERSION=1.75.1
ARG TARGETARCH
RUN set -eu; mkdir -p /out; \
    if [ "$INSTALL_RCLONE" = "true" ]; then \
      arch="${TARGETARCH:-amd64}"; \
      zip="rclone-v${RCLONE_VERSION}-linux-${arch}.zip"; \
      apt-get update; \
      apt-get install -y --no-install-recommends ca-certificates curl unzip; \
      cd /tmp; \
      curl -fsSLO "https://downloads.rclone.org/v${RCLONE_VERSION}/${zip}"; \
      curl -fsSL "https://downloads.rclone.org/v${RCLONE_VERSION}/SHA256SUMS" | grep " ${zip}\$" | sha256sum -c -; \
      unzip -q "$zip"; \
      install -D -m 0755 "${zip%.zip}/rclone" /out/usr/local/bin/rclone; \
      install -D -m 0644 /etc/ssl/certs/ca-certificates.crt /out/etc/ssl/certs/ca-certificates.crt; \
    fi

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
# Empty unless INSTALL_RCLONE=true: the binary, and the CA bundle it verifies
# TLS remotes with.
COPY --from=rclone /out/ /

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
