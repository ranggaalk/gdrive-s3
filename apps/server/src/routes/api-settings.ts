// /api/settings — admin-only runtime configuration. Currently the Google
// OAuth client credentials; anyone who can change these controls login for
// the whole app, so every route here requires session.user.is_admin.

import type { AppContext } from "../context.ts";
import type { SessionRow } from "../db/repositories/sessions.ts";
import { ScheduleInputError } from "../backup/schedule-time.ts";
import { DbSnapshotBusyError, DbSnapshotService } from "../services/db-snapshot-service.ts";
import { apiError, mapBodyReadError, ok, readJson } from "./api-helpers.ts";

function requireAdmin(ctx: AppContext, session: SessionRow, requestId: string): Response | null {
  const user = ctx.repos.users.findById(session.user_id);
  if (!user?.is_admin) {
    return apiError("FORBIDDEN", "Hanya admin yang dapat mengakses pengaturan ini.", 403, requestId);
  }
  return null;
}

export async function handleSettings(
  ctx: AppContext,
  req: Request,
  session: SessionRow,
  requestId: string,
  rest: string,
): Promise<Response> {
  const forbidden = requireAdmin(ctx, session, requestId);
  if (forbidden) return forbidden;

  if (rest === "" || rest === "/") {
    if (req.method === "GET") {
      return ok(
        {
          googleOAuth: ctx.runtimeSettings.getGoogleOAuthStatus(),
          rootFolderName: ctx.runtimeSettings.getRootFolderNameStatus(),
        },
        requestId,
      );
    }
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  if (rest === "/google-oauth") {
    if (req.method === "PUT") {
      let body: { clientId?: unknown; clientSecret?: unknown } | null;
      try {
        body = await readJson<{ clientId?: unknown; clientSecret?: unknown }>(ctx, req);
      } catch (error) {
        const mapped = mapBodyReadError(error, requestId);
        if (mapped) return mapped;
        throw error;
      }
      if (typeof body?.clientId !== "string" || typeof body?.clientSecret !== "string") {
        return apiError("INVALID", "clientId dan clientSecret wajib berupa teks.", 400, requestId);
      }
      try {
        ctx.runtimeSettings.updateGoogleOAuthCredentials(
          { clientId: body.clientId, clientSecret: body.clientSecret },
          session.user_id,
        );
      } catch (error) {
        return apiError(
          "INVALID",
          error instanceof Error ? error.message : "Gagal menyimpan pengaturan.",
          400,
          requestId,
        );
      }
      ctx.repos.audit.record({
        userId: session.user_id,
        action: "settings.google_oauth.update",
        requestId,
        statusCode: 200,
      });
      return ok({ googleOAuth: ctx.runtimeSettings.getGoogleOAuthStatus() }, requestId);
    }

    if (req.method === "DELETE") {
      ctx.runtimeSettings.resetGoogleOAuthCredentials();
      ctx.repos.audit.record({
        userId: session.user_id,
        action: "settings.google_oauth.reset",
        requestId,
        statusCode: 200,
      });
      return ok({ googleOAuth: ctx.runtimeSettings.getGoogleOAuthStatus() }, requestId);
    }

    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  if (rest === "/root-folder-name") {
    if (req.method === "PUT") {
      let body: { name?: unknown } | null;
      try {
        body = await readJson<{ name?: unknown }>(ctx, req);
      } catch (error) {
        const mapped = mapBodyReadError(error, requestId);
        if (mapped) return mapped;
        throw error;
      }
      if (typeof body?.name !== "string") {
        return apiError("INVALID", "name wajib berupa teks.", 400, requestId);
      }
      try {
        ctx.runtimeSettings.updateRootFolderName(body.name, session.user_id);
      } catch (error) {
        return apiError(
          "INVALID",
          error instanceof Error ? error.message : "Gagal menyimpan pengaturan.",
          400,
          requestId,
        );
      }
      ctx.repos.audit.record({
        userId: session.user_id,
        action: "settings.root_folder_name.update",
        requestId,
        statusCode: 200,
      });
      return ok({ rootFolderName: ctx.runtimeSettings.getRootFolderNameStatus() }, requestId);
    }

    if (req.method === "DELETE") {
      ctx.runtimeSettings.resetRootFolderName();
      ctx.repos.audit.record({
        userId: session.user_id,
        action: "settings.root_folder_name.reset",
        requestId,
        statusCode: 200,
      });
      return ok({ rootFolderName: ctx.runtimeSettings.getRootFolderNameStatus() }, requestId);
    }

    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  // Scheduled snapshots of this database. Admin-only like everything here,
  // and doubly so: the archive holds every user's secrets.
  if (rest === "/db-snapshot") {
    const snapshots = new DbSnapshotService(ctx);
    if (req.method === "GET") return ok(snapshots.status(), requestId);
    if (req.method === "PUT") {
      let body: unknown;
      try {
        body = await readJson<unknown>(ctx, req);
      } catch (error) {
        const mapped = mapBodyReadError(error, requestId);
        if (mapped) return mapped;
        throw error;
      }
      try {
        snapshots.save(session.user_id, body);
      } catch (error) {
        if (error instanceof ScheduleInputError) {
          return apiError("INVALID_DB_SNAPSHOT", "Pengaturan snapshot database tidak valid.", 400, requestId, error.message);
        }
        throw error;
      }
      ctx.repos.audit.record({
        userId: session.user_id,
        action: "settings.db_snapshot.update",
        requestId,
        statusCode: 200,
      });
      return ok(snapshots.status(), requestId);
    }
    return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
  }

  if (rest === "/db-snapshot/run") {
    if (req.method !== "POST") return apiError("METHOD_NOT_ALLOWED", "Metode tidak diizinkan.", 405, requestId);
    const snapshots = new DbSnapshotService(ctx);
    try {
      // Runs in the background; the dashboard follows it through GET.
      void snapshots.startNow();
    } catch (error) {
      if (error instanceof DbSnapshotBusyError) {
        return apiError("DB_SNAPSHOT_RUNNING", "Snapshot database sedang berjalan.", 409, requestId);
      }
      throw error;
    }
    ctx.repos.audit.record({
      userId: session.user_id,
      action: "settings.db_snapshot.run",
      requestId,
      statusCode: 202,
    });
    return ok(snapshots.status(), requestId, 202);
  }

  return apiError("NOT_FOUND", "Endpoint tidak ditemukan.", 404, requestId);
}
