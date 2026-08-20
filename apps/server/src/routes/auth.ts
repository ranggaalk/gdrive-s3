// OAuth routes (AGENTS.md §7): /auth/google/start and /auth/google/callback,
// plus /auth/logout. State + PKCE are held server-side keyed by `state`.

import type { AppContext } from "../context.ts";
import {
  buildAuthUrl,
  exchangeCode,
  generatePkce,
  generateState,
  verifyIdToken,
} from "../auth/google-oauth.ts";
import { sealToString, aad } from "../security/encryption.ts";
import { readCookie, SESSION_COOKIE } from "../auth/session.ts";
import { clientIpFrom, rawClientIp, type HasRequestIp } from "../util/client-ip.ts";
import { retryAfterSeconds } from "../security/rate-limits.ts";

const FLOW_TTL_MS = 10 * 60 * 1000;

function pruneFlows(ctx: AppContext): void {
  const cutoff = Date.now() - FLOW_TTL_MS;
  for (const [state, flow] of ctx.loginFlows) {
    if (flow.createdAt < cutoff) ctx.loginFlows.delete(state);
  }
}

function proxyClientIp(ctx: AppContext, req: Request): string | null {
  if (!ctx.config.trustProxy) return null;
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0]!.trim() : null;
}

export async function handleAuthStart(
  ctx: AppContext,
  req: Request,
  server: HasRequestIp | null,
): Promise<Response> {
  const decision = ctx.rateLimits.take("login", clientIpFrom(req, server, ctx.config));
  if (!decision.allowed) {
    ctx.log.warn("login throttled", { ipHash: clientIpFrom(req, server, ctx.config) });
    return new Response("Too many login attempts. Try again later.\n", {
      status: 429,
      headers: { "Retry-After": retryAfterSeconds(decision) },
    });
  }
  pruneFlows(ctx);
  const state = generateState();
  const pkce = generatePkce();
  ctx.loginFlows.set(state, { pkceVerifier: pkce.verifier, createdAt: Date.now() });
  const url = buildAuthUrl(ctx.config, {
    state,
    pkceChallenge: pkce.challenge,
    promptConsent: true,
  });
  return new Response(null, { status: 302, headers: { Location: url } });
}

export async function handleAuthCallback(
  ctx: AppContext,
  req: Request,
  server: HasRequestIp | null,
): Promise<Response> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  const redirectHome = (query: string) =>
    new Response(null, {
      status: 302,
      headers: { Location: new URL(query || "/", ctx.config.appOrigin).toString() },
    });

  if (oauthError) return redirectHome("?login_error=denied");
  if (!code || !state) return redirectHome("?login_error=invalid");

  const flow = ctx.loginFlows.get(state);
  ctx.loginFlows.delete(state);
  if (!flow) return redirectHome("?login_error=state");

  try {
    const tokens = await exchangeCode(ctx.config, code, flow.pkceVerifier);
    const claims = await verifyIdToken(ctx.config, tokens.id_token);

    const user = ctx.repos.users.upsertOnLogin({
      googleSub: claims.sub,
      email: claims.email,
      displayName: claims.name ?? null,
      hostedDomain: claims.hd!,
    });

    // Google may omit refresh_token on incremental consent. Preserve the
    // existing encrypted token while still recording the newly granted scope.
    if (tokens.refresh_token) {
      const encrypted = sealToString(
        tokens.refresh_token,
        ctx.config.masterEncryptionKey,
        aad.oauthRefreshToken(user.id),
      );
      ctx.repos.oauth.upsert(user.id, encrypted, tokens.scope);
    } else if (ctx.repos.oauth.find(user.id)) {
      ctx.repos.oauth.updateScopes(user.id, tokens.scope);
    }

    // Ensure the Drive root folder (best effort; failures surface in status).
    try {
      await ctx.rootFolder.ensure(user.id);
    } catch (err) {
      ctx.log.warn("root folder ensure failed on login", {
        userId: user.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const session = ctx.sessionService.establish({
      userId: user.id,
      userAgent: req.headers.get("user-agent"),
      ip: proxyClientIp(ctx, req) ?? rawClientIp(req, server, ctx.config),
    });

    return new Response(null, {
      status: 302,
      headers: {
        Location: ctx.config.appOrigin,
        "Set-Cookie": session.setCookie,
      },
    });
  } catch (err) {
    ctx.log.warn("oauth callback failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return redirectHome("?login_error=auth");
  }
}

export async function handleLogout(ctx: AppContext, req: Request): Promise<Response> {
  const rawId = readCookie(req.headers.get("cookie"), SESSION_COOKIE);
  const setCookie = rawId ? ctx.sessionService.destroy(rawId) : "";
  const headers: Record<string, string> = { Location: "/" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(null, { status: 302, headers });
}
