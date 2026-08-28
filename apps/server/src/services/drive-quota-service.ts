// Assembles the Drive API quota view from three sources, kept separate in the
// response because they answer different questions and have different
// trustworthiness:
//
//   observed  what this gateway sent to Google, counted as it happened
//   storage   the account's storage quota, read live from Drive (about.get)
//   live      Google's own request-quota limit and consumption, read from the
//             Cloud project (needs a service-account credential)
//
// Nothing here estimates a remaining request quota. When the live probe is not
// configured or fails, the response says so rather than filling the gap with a
// number derived from the observed count — the gateway only sees its own
// traffic, so such a number would be wrong whenever anything else uses the
// same Google Cloud project.

import type { AppConfig } from "../config.ts";
import type { DriveStorage, DriveStorageQuota } from "../drive/storage.ts";
import type { DriveObservedUsage, DriveQuotaMeter } from "../drive/quota-meter.ts";
import { DriveQuotaProbe, type LiveQuotaResult } from "../drive/quota-probe.ts";
import { DriveError } from "../drive/errors.ts";
import { TokenRevokedError } from "../drive/oauth-token.ts";

export interface StorageQuotaView extends DriveStorageQuota {
  usedRatio: number | null;
  remainingBytes: number | null;
}

export interface DriveQuotaSnapshot {
  observed: DriveObservedUsage;
  /** Gateway-side concurrency caps, for comparison with Google's own limits. */
  concurrency: {
    uploadsPerUser: number;
    downloadsPerUser: number;
    apiRequestsPerUser: number;
    retryMaxAttempts: number;
  };
  storage: StorageQuotaView | null;
  storageError: string | null;
  live: LiveQuotaResult;
}

const NOT_CONFIGURED: LiveQuotaResult = {
  configured: false,
  error:
    "Live quota is not configured. Drive API responses carry no quota headers, " +
    "so reading the real limit needs a read-only Google Cloud service account.",
};

export class DriveQuotaService {
  private readonly probe: DriveQuotaProbe | null;

  constructor(
    private readonly config: AppConfig,
    private readonly meter: DriveQuotaMeter,
    private readonly storage: DriveStorage,
    probe?: DriveQuotaProbe | null,
  ) {
    if (probe !== undefined) {
      this.probe = probe;
    } else if (config.driveQuota.serviceAccount && config.driveQuota.projectId) {
      this.probe = new DriveQuotaProbe({
        projectId: config.driveQuota.projectId,
        key: config.driveQuota.serviceAccount,
        cacheMs: config.driveQuota.cacheSeconds * 1000,
      });
    } else {
      this.probe = null;
    }
  }

  /**
   * `includeUsers` carries the per-user breakdown, which shows one user how
   * busy the others have been — admin-only.
   */
  async snapshot(input: {
    userId: string;
    includeUsers: boolean;
    signal?: AbortSignal;
  }): Promise<DriveQuotaSnapshot> {
    const observed = this.meter.snapshot();
    const [storage, live] = await Promise.all([
      this.readStorage(input.userId, input.signal),
      this.probe ? this.probe.read(input.signal) : Promise.resolve(NOT_CONFIGURED),
    ]);

    return {
      observed: input.includeUsers ? observed : { ...observed, users: [] },
      concurrency: {
        uploadsPerUser: this.config.maxUserUploads,
        downloadsPerUser: this.config.maxUserDownloads,
        apiRequestsPerUser: this.config.maxUserDriveRequests,
        retryMaxAttempts: this.config.driveRetryMaxAttempts,
      },
      storage: storage.quota,
      storageError: storage.error,
      live,
    };
  }

  private async readStorage(
    userId: string,
    signal?: AbortSignal,
  ): Promise<{ quota: StorageQuotaView | null; error: string | null }> {
    try {
      const quota = await this.storage.getStorageQuota({ userId, signal });
      const remainingBytes =
        quota.limitBytes === null ? null : Math.max(0, quota.limitBytes - quota.usageBytes);
      const usedRatio =
        quota.limitBytes === null || quota.limitBytes === 0
          ? null
          : Math.round((quota.usageBytes / quota.limitBytes) * 10_000) / 10_000;
      return { quota: { ...quota, remainingBytes, usedRatio }, error: null };
    } catch (error) {
      // A disconnected Drive account must not take the whole panel down: the
      // observed counters and the project quota are still worth showing.
      if (error instanceof TokenRevokedError) return { quota: null, error: "token_revoked" };
      if (error instanceof DriveError) return { quota: null, error: error.category };
      return { quota: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
