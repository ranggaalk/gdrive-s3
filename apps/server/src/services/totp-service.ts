// TOTP 2FA business logic: setup, confirmation, login-time verification,
// and disable — all backed by TotpRepository + the pure crypto in
// security/totp.ts.

import type { AppContext } from "../context.ts";
import {
  base32Encode,
  buildOtpauthUri,
  generateRecoveryCode,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotpCode,
} from "../security/totp.ts";
import { openFromString, sealToString, aad } from "../security/encryption.ts";

const RECOVERY_CODE_COUNT = 10;

export class TotpAlreadyEnabledError extends Error {}
export class TotpNotPendingError extends Error {}
export class TotpInvalidCodeError extends Error {}
export class TotpNotEnabledError extends Error {}

export interface TotpStatus {
  enabled: boolean;
  pendingSetup: boolean;
  recoveryCodesRemaining: number;
}

export interface TotpSetupResult {
  otpauthUri: string;
  manualEntryKey: string;
}

export class TotpService {
  constructor(private readonly ctx: AppContext) {}

  private decryptSecret(encryptedSecret: string, userId: string): Buffer {
    const hex = openFromString(encryptedSecret, this.ctx.config.masterEncryptionKey, aad.totpSecret(userId));
    return Buffer.from(hex, "hex");
  }

  status(userId: string): TotpStatus {
    const user = this.ctx.repos.users.findById(userId);
    const secret = this.ctx.repos.totp.findSecret(userId);
    return {
      enabled: !!user?.totp_enabled,
      pendingSetup: !!secret && !secret.confirmed_at,
      recoveryCodesRemaining: this.ctx.repos.totp.countUnusedRecoveryCodes(userId),
    };
  }

  /** Begins (or restarts) setup: a fresh secret, not yet active until confirmSetup(). */
  startSetup(userId: string, accountLabel: string): TotpSetupResult {
    const user = this.ctx.repos.users.findById(userId);
    if (user?.totp_enabled) throw new TotpAlreadyEnabledError();
    const secret = generateTotpSecret();
    const encrypted = sealToString(secret.toString("hex"), this.ctx.config.masterEncryptionKey, aad.totpSecret(userId));
    this.ctx.repos.totp.savePendingSecret(userId, encrypted);
    return {
      otpauthUri: buildOtpauthUri({ secret, accountLabel, issuer: this.ctx.config.appName }),
      manualEntryKey: base32Encode(secret),
    };
  }

  /** Proves the user actually scanned the secret; enables 2FA and issues recovery codes. */
  confirmSetup(userId: string, code: string): string[] {
    const row = this.ctx.repos.totp.findSecret(userId);
    if (!row || row.confirmed_at) throw new TotpNotPendingError();
    const secret = this.decryptSecret(row.encrypted_secret, userId);
    if (!verifyTotpCode(secret, code)) throw new TotpInvalidCodeError();
    this.ctx.repos.totp.confirm(userId);
    return this.regenerateRecoveryCodes(userId);
  }

  /** Invalidates any existing recovery codes and issues a fresh set (shown once). */
  regenerateRecoveryCodes(userId: string): string[] {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode());
    this.ctx.repos.totp.replaceRecoveryCodes(
      userId,
      codes.map((code) => hashRecoveryCode(code)),
    );
    return codes;
  }

  /** Requires re-proving 2FA (code or recovery code) before turning it off. */
  disable(userId: string, code: string): void {
    const user = this.ctx.repos.users.findById(userId);
    if (!user?.totp_enabled) throw new TotpNotEnabledError();
    if (!this.verifyCodeOrRecovery(userId, code)) throw new TotpInvalidCodeError();
    this.ctx.repos.totp.disable(userId);
  }

  /** A confirmed TOTP code or an unused recovery code — used at login and to
   * re-confirm sensitive actions (disable, regenerate recovery codes). */
  verifyCodeOrRecovery(userId: string, code: string): boolean {
    const row = this.ctx.repos.totp.findSecret(userId);
    if (row?.confirmed_at) {
      const secret = this.decryptSecret(row.encrypted_secret, userId);
      if (verifyTotpCode(secret, code)) return true;
    }
    const recovery = this.ctx.repos.totp.findUnusedRecoveryCodeByHash(userId, hashRecoveryCode(code));
    if (recovery && this.ctx.repos.totp.consumeRecoveryCode(recovery.id)) return true;
    return false;
  }
}
