// Overlays DB-stored runtime settings on top of boot-time env config, so an
// admin can change the Google OAuth client credentials from the Settings
// page without a restart. Absent DB rows fall back to env (today's
// behavior); every write re-reads into an in-memory cache so it takes
// effect on the very next request.

import type { AppConfig } from "../config.ts";
import type { GoogleOAuthCredentials } from "../auth/google-oauth.ts";
import { SettingsRepository } from "../db/repositories/settings.ts";
import { openFromString, sealToString, aad } from "../security/encryption.ts";

const KEY_CLIENT_ID = "google_client_id";
const KEY_CLIENT_SECRET = "google_client_secret";
const KEY_ROOT_FOLDER_NAME = "root_folder_name";

// The visible name given to the per-user root folder created in Google
// Drive on first use. Purely cosmetic — folders are actually located via
// appProperties markers (see drive/storage.ts), never by matching this
// name — so changing it is safe and only affects folders created from now
// on. Bracketed so it reads as a marker, not an ordinary folder someone
// might rename or move by mistake.
export const DEFAULT_ROOT_FOLDER_NAME = "[DRIVE-S3-GATEWAY]";
const MAX_ROOT_FOLDER_NAME_LENGTH = 255;

export type SettingSource = "env" | "database";
export type NameSettingSource = "default" | "custom";

export interface GoogleOAuthSettingsStatus {
  clientId: string;
  clientIdSource: SettingSource;
  clientSecretSource: SettingSource;
  updatedAt: string | null;
}

export interface RootFolderNameStatus {
  name: string;
  source: NameSettingSource;
  updatedAt: string | null;
}

export class RuntimeSettingsService {
  private clientId: string;
  private clientSecret: string;
  private clientIdFromDb = false;
  private clientSecretFromDb = false;
  private googleOAuthUpdatedAt: string | null = null;

  private rootFolderName: string = DEFAULT_ROOT_FOLDER_NAME;
  private rootFolderNameFromDb = false;
  private rootFolderNameUpdatedAt: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly settingsRepo: SettingsRepository,
  ) {
    this.clientId = config.google.clientId;
    this.clientSecret = config.google.clientSecret;
    this.reload();
  }

  private reload(): void {
    const idRow = this.settingsRepo.get(KEY_CLIENT_ID);
    const secretRow = this.settingsRepo.get(KEY_CLIENT_SECRET);

    this.clientIdFromDb = idRow !== null;
    this.clientId = idRow?.value ?? this.config.google.clientId;

    if (secretRow) {
      this.clientSecret = openFromString(
        secretRow.value,
        this.config.masterEncryptionKey,
        aad.appSetting(KEY_CLIENT_SECRET),
      );
      this.clientSecretFromDb = true;
    } else {
      this.clientSecret = this.config.google.clientSecret;
      this.clientSecretFromDb = false;
    }

    this.googleOAuthUpdatedAt = secretRow?.updated_at ?? idRow?.updated_at ?? null;

    const rootFolderRow = this.settingsRepo.get(KEY_ROOT_FOLDER_NAME);
    this.rootFolderNameFromDb = rootFolderRow !== null;
    this.rootFolderName = rootFolderRow?.value ?? DEFAULT_ROOT_FOLDER_NAME;
    this.rootFolderNameUpdatedAt = rootFolderRow?.updated_at ?? null;
  }

  getGoogleOAuthCredentials(): GoogleOAuthCredentials {
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }

  getGoogleOAuthStatus(): GoogleOAuthSettingsStatus {
    return {
      clientId: this.clientId,
      clientIdSource: this.clientIdFromDb ? "database" : "env",
      clientSecretSource: this.clientSecretFromDb ? "database" : "env",
      updatedAt: this.googleOAuthUpdatedAt,
    };
  }

  updateGoogleOAuthCredentials(input: GoogleOAuthCredentials, updatedByUserId: string): void {
    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret.trim();
    if (!clientId || !clientSecret) {
      throw new Error("Client ID dan Client Secret wajib diisi.");
    }
    this.settingsRepo.set(KEY_CLIENT_ID, clientId, updatedByUserId);
    this.settingsRepo.set(
      KEY_CLIENT_SECRET,
      sealToString(clientSecret, this.config.masterEncryptionKey, aad.appSetting(KEY_CLIENT_SECRET)),
      updatedByUserId,
    );
    this.reload();
  }

  resetGoogleOAuthCredentials(): void {
    this.settingsRepo.delete(KEY_CLIENT_ID);
    this.settingsRepo.delete(KEY_CLIENT_SECRET);
    this.reload();
  }

  getRootFolderName(): string {
    return this.rootFolderName;
  }

  getRootFolderNameStatus(): RootFolderNameStatus {
    return {
      name: this.rootFolderName,
      source: this.rootFolderNameFromDb ? "custom" : "default",
      updatedAt: this.rootFolderNameUpdatedAt,
    };
  }

  updateRootFolderName(name: string, updatedByUserId: string): void {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("Nama folder wajib diisi.");
    }
    if (trimmed.length > MAX_ROOT_FOLDER_NAME_LENGTH) {
      throw new Error(`Nama folder maksimal ${MAX_ROOT_FOLDER_NAME_LENGTH} karakter.`);
    }
    // Google Drive folder names can't contain "/" (it flattens path
    // separators); reject early instead of letting the Drive API 400 later.
    if (trimmed.includes("/")) {
      throw new Error("Nama folder tidak boleh mengandung karakter '/'.");
    }
    this.settingsRepo.set(KEY_ROOT_FOLDER_NAME, trimmed, updatedByUserId);
    this.reload();
  }

  resetRootFolderName(): void {
    this.settingsRepo.delete(KEY_ROOT_FOLDER_NAME);
    this.reload();
  }
}
