// Server bootstrap (AGENTS.md §27 shutdown, §19 health, §9 migrations).
// Validate config -> open DB -> migrate -> serve. Refuse to boot on failure.

import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { createLogger, newRequestId } from "./observability/logger.ts";
import { openDatabase } from "./db/connection.ts";
import { runMigrations } from "./db/migrate.ts";
import { handleLive, handleReady } from "./routes/health.ts";
import { createContext } from "./context.ts";
import { handleAuthCallback, handleAuthStart, handleLogout } from "./routes/auth.ts";
import { handleBackupLinkStart } from "./routes/backup-auth.ts";
import { handleMfaStatus, handleMfaVerify } from "./routes/mfa-auth.ts";
import { handleApi } from "./routes/api.ts";
import { handleS3 } from "./s3/router.ts";
import { CleanupWorker } from "./jobs/orphan-cleanup.ts";
import { MultipartExpiryWorker } from "./jobs/multipart-expiry.ts";
import { DriveImportWorker } from "./jobs/drive-import.ts";
import { BackupTransferWorker } from "./jobs/backup-transfer.ts";
import { recoverStaleStaging } from "./jobs/staging-recovery.ts";
import { applySecurityHeaders, classifyResponseKind } from "./security/headers.ts";
import { DashboardServer } from "./routes/dashboard.ts";
import {
  handlePublicShare,
  maskedRoute,
  PUBLIC_SHARE_PREFIX,
} from "./routes/public-share.ts";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        level: "error",
        time: new Date().toISOString(),
        msg: "invalid configuration, refusing to start",
        error: err instanceof Error ? err.message : String(err),
      }) + "\n",
    );
    process.exit(1);
  }

  const log = createLogger(config.logLevel);

  // Ensure runtime directories exist before opening the DB / temp usage.
  mkdirSync(config.multipartTempDir, { recursive: true });

  const db = openDatabase(config.sqlitePath);
  const migrateResult = runMigrations(db);
  log.info("migrations applied", {
    applied: migrateResult.applied,
    currentVersion: migrateResult.currentVersion,
  });

  const ctx = createContext(config, db, log);
  const recovered = recoverStaleStaging(ctx);
  log.info("staging recovery complete", { ...recovered });
  const cleanupWorker = new CleanupWorker(ctx);
  const multipartExpiryWorker = new MultipartExpiryWorker(ctx);
  const driveImportWorker = new DriveImportWorker(ctx);
  const backupTransferWorker = new BackupTransferWorker(ctx);
  cleanupWorker.start();
  multipartExpiryWorker.start();
  driveImportWorker.start();
  backupTransferWorker.start();
  const dashboard = new DashboardServer(config);

  const server = Bun.serve({
    hostname: config.serverHost,
    port: config.serverPort,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const requestId = newRequestId();
      const start = performance.now();

      let res: Response;
      let servedDashboard = false;
      try {
        if (path === "/health/live") {
          res = handleLive();
        } else if (path === "/health/ready") {
          res = handleReady(db, config);
        } else if (path === "/auth/google/start") {
          res = await handleAuthStart(ctx, req, server);
        } else if (path === "/auth/google/callback") {
          res = await handleAuthCallback(ctx, req, server);
        } else if (path === "/auth/google/link-start") {
          res = await handleBackupLinkStart(ctx, req);
        } else if (path === "/auth/logout") {
          res = await handleLogout(ctx, req);
        } else if (path === "/auth/mfa/status") {
          res = await handleMfaStatus(ctx, req, requestId);
        } else if (path === "/auth/mfa/verify") {
          res = await handleMfaVerify(ctx, req, requestId);
        } else if (path.startsWith("/api/")) {
          res = await handleApi(ctx, req, requestId);
        } else if (path.startsWith(PUBLIC_SHARE_PREFIX)) {
          res = await handlePublicShare(ctx, req, requestId, server);
        } else {
          const staticResponse = await dashboard.serve(req);
          if (staticResponse) {
            res = staticResponse;
            servedDashboard = true;
          } else {
            res = await handleS3(ctx, req, requestId, server);
          }
        }
      } catch (err) {
        log.error("unhandled request error", {
          requestId,
          route: maskedRoute(path),
          error: err instanceof Error ? err.message : String(err),
        });
        res = Response.json(
          { error: { code: "INTERNAL", message: "Internal error" }, requestId },
          { status: 500 },
        );
      }

      res.headers.set("x-request-id", requestId);
      applySecurityHeaders(res, config, classifyResponseKind(path, servedDashboard));
      log.info("http", {
        requestId,
        route: maskedRoute(path),
        method: req.method,
        status: res.status,
        durationMs: Math.round(performance.now() - start),
      });
      return res;
    },
  });

  log.info("server listening", {
    host: config.serverHost,
    port: config.serverPort,
    appName: config.appName,
  });

  const shutdown = async (signal: string) => {
    log.info("shutdown signal received", { signal });
    server.stop();
    await backupTransferWorker.stop();
    await driveImportWorker.stop();
    await multipartExpiryWorker.stop();
    await cleanupWorker.stop();
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // best effort
    }
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
