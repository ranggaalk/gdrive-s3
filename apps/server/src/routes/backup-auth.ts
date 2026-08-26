// Links a secondary Google Drive account as a manual backup destination.
// Reuses the same /auth/google/callback endpoint as login (see auth.ts) —
// registering a second redirect URI in Google Cloud Console just for this
// would be extra deployment friction, and the callback can already tell
// login and link flows apart by which flow-map the `state` belongs to.

import type { AppContext } from "../context.ts";
import { buildAuthUrl, generatePkce, generateState } from "../auth/google-oauth.ts";
import { readCookie, SESSION_COOKIE } from "../auth/session.ts";
import { BackupAccountService, BackupLinkError } from "../services/backup-account-service.ts";

const FLOW_TTL_MS = 10 * 60 * 1000;

function pruneFlows(ctx: AppContext): void {
  const cutoff = Date.now() - FLOW_TTL_MS;
  for (const [state, flow] of ctx.backupLinkFlows) {
    if (flow.createdAt < cutoff) ctx.backupLinkFlows.delete(state);
  }
}

export async function handleBackupLinkStart(ctx: AppContext, req: Request): Promise<Response> {
  const rawId = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  const session = ctx.sessionService.resolve(rawId);
  if (!session) {
    return new Response(null, { status: 302, headers: { Location: "/" } });
  }
  pruneFlows(ctx);
  const state = generateState();
  const pkce = generatePkce();
  ctx.backupLinkFlows.set(state, {
    pkceVerifier: pkce.verifier,
    userId: session.user_id,
    createdAt: Date.now(),
  });
  // promptConsent forces Google to return a refresh_token even if this exact
  // Google account already granted access before (e.g. relinking).
  const url = buildAuthUrl(ctx.config, ctx.runtimeSettings.getGoogleOAuthCredentials(), {
    state,
    pkceChallenge: pkce.challenge,
    promptConsent: true,
  });
  return new Response(null, { status: 302, headers: { Location: url } });
}

export async function finishBackupLink(
  ctx: AppContext,
  code: string,
  flow: { pkceVerifier: string; userId: string },
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await new BackupAccountService(ctx).link({
      ownerUserId: flow.userId,
      code,
      pkceVerifier: flow.pkceVerifier,
      signal,
    });
    return { ok: true };
  } catch (error) {
    if (error instanceof BackupLinkError) return { ok: false, error: error.message };
    ctx.log.warn("backup account link failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, error: "Gagal menghubungkan akun Drive." };
  }
}
