// End-to-end coverage for TOTP 2FA: setup -> confirm -> pending-session
// login verification (code + recovery code) -> disable. Exercises the real
// handleApi dispatcher and the mfa-auth routes together, the same way a
// browser session would hit them.

import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
import { handleMfaStatus, handleMfaVerify } from "../../apps/server/src/routes/mfa-auth.ts";
import { base32Decode, generateTotpCode } from "../../apps/server/src/security/totp.ts";
import { makeHarness } from "./_helpers.ts";

function unwrap<T>(body: unknown): T {
  return (body as { data: T }).data;
}

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

let ctxToClose: AppContext | null = null;
afterEach(() => {
  ctxToClose?.db.close();
  ctxToClose = null;
});

const ORIGIN = "http://localhost";

describe("TOTP 2FA", () => {
  test("full lifecycle: setup, confirm, login verify (code + recovery), disable", async () => {
    const { ctx, seedUser } = makeHarness();
    ctxToClose = ctx;
    const user = seedUser("2fa@example.com");
    const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
    const cookie = `drives3_sid=${session.rawId}`;
    const authedHeaders = { cookie, origin: ORIGIN, "x-csrf-token": session.csrfSecret };

    // 1. Starts disabled.
    const statusBefore = unwrap<{ enabled: boolean; pendingSetup: boolean; recoveryCodesRemaining: number }>(
      await (await handleApi(ctx, new Request(`${ORIGIN}/api/security/totp`, { headers: { cookie } }), "r1")).json(),
    );
    expect(statusBefore).toEqual({ enabled: false, pendingSetup: false, recoveryCodesRemaining: 0 });

    // 2. Setup returns a scannable secret.
    const setupRes = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/security/totp/setup`, { method: "POST", headers: authedHeaders }),
      "r2",
    );
    expect(setupRes.status).toBe(200);
    const setup = unwrap<{ otpauthUri: string; manualEntryKey: string }>(await setupRes.json());
    expect(setup.otpauthUri).toStartWith("otpauth://totp/");
    const secret = base32Decode(setup.manualEntryKey);

    // 3. Confirming with the right code enables 2FA and issues recovery codes.
    const confirmRes = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/security/totp/confirm`, {
        method: "POST",
        headers: { ...authedHeaders, "content-type": "application/json" },
        body: JSON.stringify({ code: generateTotpCode(secret) }),
      }),
      "r3",
    );
    expect(confirmRes.status).toBe(200);
    const { recoveryCodes } = unwrap<{ recoveryCodes: string[] }>(await confirmRes.json());
    expect(recoveryCodes).toHaveLength(10);

    const statusAfter = unwrap<{ enabled: boolean; pendingSetup: boolean; recoveryCodesRemaining: number }>(
      await (await handleApi(ctx, new Request(`${ORIGIN}/api/security/totp`, { headers: { cookie } }), "r4")).json(),
    );
    expect(statusAfter).toEqual({ enabled: true, pendingSetup: false, recoveryCodesRemaining: 10 });

    // 4. Simulate a fresh login: a pending session must not pass the normal gate.
    const pendingSession = ctx.sessionService.establish({
      userId: user.id,
      userAgent: "test",
      ip: null,
      mfaPending: true,
    });
    const pendingCookie = `drives3_sid=${pendingSession.rawId}`;

    const meWhilePending = await handleApi(ctx, new Request(`${ORIGIN}/api/me`, { headers: { cookie: pendingCookie } }), "r5");
    expect(meWhilePending.status).toBe(401);
    expect(errorCode(await meWhilePending.json())).toBe("MFA_REQUIRED");

    const mfaStatusRes = await handleMfaStatus(ctx, new Request(`${ORIGIN}/auth/mfa/status`, { headers: { cookie: pendingCookie } }), "r6");
    const mfaStatus = unwrap<{ pending: boolean; csrfToken: string }>(await mfaStatusRes.json());
    expect(mfaStatus.pending).toBe(true);

    // 5. Wrong code is rejected.
    const wrongVerify = await handleMfaVerify(
      ctx,
      new Request(`${ORIGIN}/auth/mfa/verify`, {
        method: "POST",
        headers: { cookie: pendingCookie, origin: ORIGIN, "x-csrf-token": mfaStatus.csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ code: "000000" }),
      }),
      "r7",
    );
    expect(wrongVerify.status).toBe(401);
    expect(errorCode(await wrongVerify.json())).toBe("INVALID_CODE");

    // 6. Correct code clears mfa_pending; the normal gate then passes.
    const rightVerify = await handleMfaVerify(
      ctx,
      new Request(`${ORIGIN}/auth/mfa/verify`, {
        method: "POST",
        headers: { cookie: pendingCookie, origin: ORIGIN, "x-csrf-token": mfaStatus.csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ code: generateTotpCode(secret) }),
      }),
      "r8",
    );
    expect(rightVerify.status).toBe(200);

    const meAfterVerify = await handleApi(ctx, new Request(`${ORIGIN}/api/me`, { headers: { cookie: pendingCookie } }), "r9");
    expect(meAfterVerify.status).toBe(200);

    // 7. A recovery code also clears a pending session, and is single-use.
    const recoverySession = ctx.sessionService.establish({
      userId: user.id,
      userAgent: "test",
      ip: null,
      mfaPending: true,
    });
    const recoveryCookie = `drives3_sid=${recoverySession.rawId}`;
    const recoveryStatus = unwrap<{ csrfToken: string }>(
      await (await handleMfaStatus(ctx, new Request(`${ORIGIN}/auth/mfa/status`, { headers: { cookie: recoveryCookie } }), "r10")).json(),
    );
    const usedCode = recoveryCodes[0]!;
    const recoveryVerify = await handleMfaVerify(
      ctx,
      new Request(`${ORIGIN}/auth/mfa/verify`, {
        method: "POST",
        headers: { cookie: recoveryCookie, origin: ORIGIN, "x-csrf-token": recoveryStatus.csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ code: usedCode }),
      }),
      "r11",
    );
    expect(recoveryVerify.status).toBe(200);

    const statusAfterRecoveryUse = unwrap<{ recoveryCodesRemaining: number }>(
      await (await handleApi(ctx, new Request(`${ORIGIN}/api/security/totp`, { headers: { cookie } }), "r12")).json(),
    );
    expect(statusAfterRecoveryUse.recoveryCodesRemaining).toBe(9);

    // Reusing the same recovery code fails.
    const reuseSession = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null, mfaPending: true });
    const reuseCookie = `drives3_sid=${reuseSession.rawId}`;
    const reuseStatus = unwrap<{ csrfToken: string }>(
      await (await handleMfaStatus(ctx, new Request(`${ORIGIN}/auth/mfa/status`, { headers: { cookie: reuseCookie } }), "r13")).json(),
    );
    const reuseVerify = await handleMfaVerify(
      ctx,
      new Request(`${ORIGIN}/auth/mfa/verify`, {
        method: "POST",
        headers: { cookie: reuseCookie, origin: ORIGIN, "x-csrf-token": reuseStatus.csrfToken, "content-type": "application/json" },
        body: JSON.stringify({ code: usedCode }),
      }),
      "r14",
    );
    expect(reuseVerify.status).toBe(401);

    // 8. Disable requires re-proving 2FA.
    const disableWrong = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/security/totp/disable`, {
        method: "POST",
        headers: { ...authedHeaders, "content-type": "application/json" },
        body: JSON.stringify({ code: "000000" }),
      }),
      "r15",
    );
    expect(disableWrong.status).toBe(400);
    expect(errorCode(await disableWrong.json())).toBe("TOTP_INVALID_CODE");

    const disableRight = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/security/totp/disable`, {
        method: "POST",
        headers: { ...authedHeaders, "content-type": "application/json" },
        body: JSON.stringify({ code: generateTotpCode(secret) }),
      }),
      "r16",
    );
    expect(disableRight.status).toBe(200);
    expect(unwrap<{ disabled: boolean }>(await disableRight.json())).toEqual({ disabled: true });

    const statusFinal = unwrap<{ enabled: boolean; recoveryCodesRemaining: number }>(
      await (await handleApi(ctx, new Request(`${ORIGIN}/api/security/totp`, { headers: { cookie } }), "r17")).json(),
    );
    expect(statusFinal.enabled).toBe(false);
    expect(statusFinal.recoveryCodesRemaining).toBe(0);
  });

  test("regenerating recovery codes invalidates the old set", async () => {
    const { ctx, seedUser } = makeHarness();
    ctxToClose = ctx;
    const user = seedUser("regen@example.com");
    const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
    const cookie = `drives3_sid=${session.rawId}`;
    const authedHeaders = { cookie, origin: ORIGIN, "x-csrf-token": session.csrfSecret, "content-type": "application/json" };

    const setup = unwrap<{ manualEntryKey: string }>(
      await (await handleApi(ctx, new Request(`${ORIGIN}/api/security/totp/setup`, { method: "POST", headers: authedHeaders }), "r1")).json(),
    );
    const secret = base32Decode(setup.manualEntryKey);
    const { recoveryCodes: original } = unwrap<{ recoveryCodes: string[] }>(
      await (
        await handleApi(
          ctx,
          new Request(`${ORIGIN}/api/security/totp/confirm`, {
            method: "POST",
            headers: authedHeaders,
            body: JSON.stringify({ code: generateTotpCode(secret) }),
          }),
          "r2",
        )
      ).json(),
    );

    const { recoveryCodes: regenerated } = unwrap<{ recoveryCodes: string[] }>(
      await (
        await handleApi(
          ctx,
          new Request(`${ORIGIN}/api/security/totp/recovery-codes`, {
            method: "POST",
            headers: authedHeaders,
            body: JSON.stringify({ code: generateTotpCode(secret) }),
          }),
          "r3",
        )
      ).json(),
    );
    expect(regenerated).toHaveLength(10);
    expect(new Set(regenerated).has(original[0]!)).toBe(false);

    // An old code no longer works to re-confirm a sensitive action.
    const disableWithOldCode = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/security/totp/disable`, {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({ code: original[1]! }),
      }),
      "r4",
    );
    expect(disableWithOldCode.status).toBe(400);

    // A code from the new set works.
    const disableWithNewCode = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/security/totp/disable`, {
        method: "POST",
        headers: authedHeaders,
        body: JSON.stringify({ code: regenerated[0]! }),
      }),
      "r5",
    );
    expect(disableWithNewCode.status).toBe(200);
  });
});
