// Control-plane API dispatcher (AGENTS.md §15). Session-authenticated,
// CSRF-protected. Authenticates once, then routes to focused handlers.

import type { AppContext } from "../context.ts";
import { apiError, authenticate, ok } from "./api-helpers.ts";
import { handleCredentials } from "./api-credentials.ts";
import { handleBuckets } from "./api-buckets.ts";
import { handleAudit } from "./api-audit.ts";
import { handleTraffic } from "./api-traffic.ts";
import { handleSettings } from "./api-settings.ts";
import { handleBackupAccounts } from "./api-backup.ts";
import { handleSecurityTotp } from "./api-security.ts";
import { handleSecurityKms } from "./api-kms.ts";
import { TokenRevokedError } from "../drive/oauth-token.ts";
import { compatMatrix } from "../compat/matrix.ts";
import { hasRequiredScopes } from "../auth/google-oauth.ts";
import { handleDriveFolders } from "./api-drive-imports.ts";
import { handleDriveQuota } from "./api-drive-quota.ts";

export async function handleApi(
  ctx: AppContext,
  req: Request,
  requestId: string,
): Promise<Response> {
  const path = new URL(req.url).pathname;

  const auth = authenticate(ctx, req, requestId);
  if (auth instanceof Response) return auth;
  const { session } = auth;

  if (path === "/api/me" && req.method === "GET") {
    const user = ctx.repos.users.findById(session.user_id);
    if (!user) return apiError("NOT_FOUND", "User tidak ditemukan.", 404, requestId);
    return ok(
      {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        hostedDomain: user.hosted_domain,
        isAdmin: !!user.is_admin,
        csrfToken: session.csrf_secret,
      },
      requestId,
    );
  }

  if (path === "/api/drive/status" && req.method === "GET") {
    const account = ctx.repos.oauth.find(session.user_id);
    const root = ctx.repos.driveRoots.find(session.user_id);
    const requiresReauthorization =
      !!account && !hasRequiredScopes(ctx.config, account.granted_scopes);
    return ok(
      {
        connected:
          !!account &&
          account.last_error !== "token_revoked" &&
          !requiresReauthorization,
        hasRootFolder: !!root,
        requiresReauthorization,
        reauthorizationUrl: requiresReauthorization ? "/auth/google/start" : null,
        lastRefreshAt: account?.last_refresh_at ?? null,
        lastError: account?.last_error ?? null,
      },
      requestId,
    );
  }

  if (path === "/api/drive/quota") {
    return handleDriveQuota(ctx, req, session, requestId);
  }

  if (path === "/api/drive/folders") {
    return handleDriveFolders(ctx, req, session, requestId);
  }

  if (path === "/api/drive/shared-drives" && req.method === "GET") {
    const account = ctx.repos.oauth.find(session.user_id);
    if (!account || !hasRequiredScopes(ctx.config, account.granted_scopes)) {
      return apiError(
        "DRIVE_REAUTHORIZATION_REQUIRED",
        "Hubungkan ulang Google Drive untuk memilih Shared Drive.",
        409,
        requestId,
      );
    }
    try {
      const pageToken = new URL(req.url).searchParams.get("pageToken") ?? undefined;
      return ok(
        await ctx.driveStorage.listSharedDrives({
          userId: session.user_id,
          pageToken,
          signal: req.signal,
        }),
        requestId,
      );
    } catch (error) {
      ctx.log.warn("shared drive list failed", {
        userId: session.user_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return apiError("DRIVE_ERROR", "Gagal memuat Shared Drive.", 502, requestId);
    }
  }

  if (path === "/api/drive/reconnect" && req.method === "POST") {
    const account = ctx.repos.oauth.find(session.user_id);
    if (!account || !hasRequiredScopes(ctx.config, account.granted_scopes)) {
      return apiError(
        "DRIVE_REAUTHORIZATION_REQUIRED",
        "Google Drive perlu dihubungkan kembali dengan izin Shared Drive.",
        409,
        requestId,
      );
    }
    try {
      await ctx.rootFolder.ensure(session.user_id);
      return ok({ connected: true }, requestId);
    } catch (err) {
      if (err instanceof TokenRevokedError) {
        return apiError(
          "DRIVE_TOKEN_REVOKED",
          "Google Drive perlu dihubungkan kembali.",
          409,
          requestId,
        );
      }
      ctx.log.warn("reconnect failed", {
        userId: session.user_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return apiError("DRIVE_ERROR", "Gagal menghubungi Google Drive.", 502, requestId);
    }
  }

  if (path === "/api/drive/reconcile" && req.method === "POST") {
    const after = new URL(req.url).searchParams.get("after") ?? undefined;
    const result = await ctx.reconcileService.runUserBatch(
      session.user_id,
      requestId,
      after,
    );
    return ok(result, requestId);
  }

  if (path === "/api/credentials" || path.startsWith("/api/credentials/")) {
    return handleCredentials(ctx, req, session, requestId, path.slice("/api/credentials".length));
  }

  if (path === "/api/buckets" || path.startsWith("/api/buckets/")) {
    return handleBuckets(ctx, req, session, requestId, path.slice("/api/buckets".length));
  }

  if (path === "/api/audit") {
    return handleAudit(ctx, req, session, requestId);
  }

  if (path === "/api/traffic") {
    return handleTraffic(ctx, req, session, requestId);
  }

  if (path === "/api/settings" || path.startsWith("/api/settings/")) {
    return handleSettings(ctx, req, session, requestId, path.slice("/api/settings".length));
  }

  if (path === "/api/backup-accounts" || path.startsWith("/api/backup-accounts/")) {
    return handleBackupAccounts(ctx, req, session, requestId, path.slice("/api/backup-accounts".length));
  }

  if (path === "/api/security/kms" || path.startsWith("/api/security/kms/")) {
    return handleSecurityKms(ctx, req, session, requestId, path.slice("/api/security/kms".length));
  }

  if (path === "/api/security/totp" || path.startsWith("/api/security/totp/")) {
    return handleSecurityTotp(ctx, req, session, requestId, path.slice("/api/security/totp".length));
  }

  if (path === "/api/status" && req.method === "GET") {
    return ok(
      {
        multipartOpen: ctx.repos.multipartUploads.countOpenForUser(session.user_id),
        compatibility: compatMatrix(),
        s3Endpoint: ctx.config.s3PublicEndpoint,
        s3Region: ctx.config.s3Region,
      },
      requestId,
    );
  }

  if (path === "/api/system/compatibility" && req.method === "GET") {
    return ok({ items: compatMatrix() }, requestId);
  }

  return apiError("NOT_FOUND", "Endpoint tidak ditemukan.", 404, requestId);
}
