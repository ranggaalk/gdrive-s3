// Application context: constructs shared services and repositories once at
// startup and passes them to route handlers.

import type { Database } from "bun:sqlite";
import type { AppConfig } from "./config.ts";
import type { Logger } from "./observability/logger.ts";
import { UsersRepository } from "./db/repositories/users.ts";
import { OAuthAccountsRepository } from "./db/repositories/oauth-accounts.ts";
import { SessionsRepository } from "./db/repositories/sessions.ts";
import { DriveRootsRepository } from "./db/repositories/drive-roots.ts";
import { BucketsRepository } from "./db/repositories/buckets.ts";
import { ObjectsRepository } from "./db/repositories/objects.ts";
import { S3CredentialsRepository } from "./db/repositories/s3-credentials.ts";
import { AuditLogsRepository } from "./db/repositories/audit-logs.ts";
import { ObjectStagingRepository } from "./db/repositories/object-staging.ts";
import { PendingCleanupRepository } from "./db/repositories/pending-cleanup.ts";
import { MultipartUploadsRepository } from "./db/repositories/multipart-uploads.ts";
import { MultipartPartsRepository } from "./db/repositories/multipart-parts.ts";
import { DriveTargetsRepository } from "./db/repositories/drive-targets.ts";
import { BucketMembersRepository } from "./db/repositories/bucket-members.ts";
import { PublicObjectLinksRepository } from "./db/repositories/public-object-links.ts";
import { DriveImportsRepository } from "./db/repositories/drive-imports.ts";
import { SettingsRepository } from "./db/repositories/settings.ts";
import { BackupAccountsRepository } from "./db/repositories/backup-accounts.ts";
import { BackupTransfersRepository } from "./db/repositories/backup-transfers.ts";
import { TotpRepository } from "./db/repositories/totp.ts";
import { UploadLockRegistry } from "./util/upload-lock.ts";
import { SessionService } from "./auth/session.ts";
import { TokenProvider } from "./drive/oauth-token.ts";
import { BackupTokenProvider } from "./drive/backup-token-provider.ts";
import { RuntimeSettingsService } from "./services/runtime-settings-service.ts";
import { RootFolderService } from "./drive/root-folder.ts";
import { GoogleDriveStorage, type DriveStorage } from "./drive/storage.ts";
import { DriveLimits } from "./drive/limits.ts";
import { DriveQuotaMeter } from "./drive/quota-meter.ts";
import { DriveQuotaService } from "./services/drive-quota-service.ts";
import { ReconcileService } from "./drive/reconcile.ts";
import { BucketService } from "./services/bucket-service.ts";
import { CredentialService } from "./services/credential-service.ts";
import { BucketAccessService } from "./services/bucket-access-service.ts";
import { RateLimits } from "./security/rate-limits.ts";
import { PublicLinkService } from "./services/public-link-service.ts";
import { AuthorizationService } from "./services/authorization-service.ts";
import { BucketPoliciesRepository } from "./db/repositories/bucket-policies.ts";
import { KmsKeysRepository } from "./db/repositories/kms-keys.ts";
import { ObjectVersionsRepository } from "./db/repositories/object-versions.ts";
import { ObjectEncryptionRepository } from "./db/repositories/object-encryption.ts";
import { KmsService } from "./security/kms.ts";
import { ObjectCopyService } from "./services/object-copy-service.ts";
import { PresignedUrlService } from "./services/presigned-url-service.ts";

export interface AppContext {
  config: AppConfig;
  db: Database;
  log: Logger;
  repos: {
    users: UsersRepository;
    oauth: OAuthAccountsRepository;
    sessions: SessionsRepository;
    driveRoots: DriveRootsRepository;
    buckets: BucketsRepository;
    objects: ObjectsRepository;
    credentials: S3CredentialsRepository;
    audit: AuditLogsRepository;
    objectStaging: ObjectStagingRepository;
    pendingCleanup: PendingCleanupRepository;
    multipartUploads: MultipartUploadsRepository;
    multipartParts: MultipartPartsRepository;
    driveTargets: DriveTargetsRepository;
    bucketMembers: BucketMembersRepository;
    publicObjectLinks: PublicObjectLinksRepository;
    bucketPolicies: BucketPoliciesRepository;
    kmsKeys: KmsKeysRepository;
    objectEncryption: ObjectEncryptionRepository;
    objectVersions: ObjectVersionsRepository;
    driveImports: DriveImportsRepository;
    settings: SettingsRepository;
    backupAccounts: BackupAccountsRepository;
    backupTransfers: BackupTransfersRepository;
    totp: TotpRepository;
  };
  uploadLocks: UploadLockRegistry;
  sessionService: SessionService;
  tokenProvider: TokenProvider;
  backupTokenProvider: BackupTokenProvider;
  runtimeSettings: RuntimeSettingsService;
  driveStorage: DriveStorage;
  driveLimits: DriveLimits;
  driveQuotaMeter: DriveQuotaMeter;
  driveQuotaService: DriveQuotaService;
  reconcileService: ReconcileService;
  rootFolder: RootFolderService;
  bucketService: BucketService;
  bucketAccess: BucketAccessService;
  authorization: AuthorizationService;
  kms: KmsService;
  objectCopyService: ObjectCopyService;
  credentialService: CredentialService;
  publicLinkService: PublicLinkService;
  presignedUrlService: PresignedUrlService;
  rateLimits: RateLimits;
  // Ephemeral OAuth login flows keyed by state (in-memory, short-lived).
  loginFlows: Map<string, { pkceVerifier: string; createdAt: number }>;
  // Ephemeral backup-account link flows keyed by state (in-memory, short-lived).
  backupLinkFlows: Map<string, { pkceVerifier: string; userId: string; createdAt: number }>;
}

export function createContext(
  config: AppConfig,
  db: Database,
  log: Logger,
  storageOverride?: DriveStorage,
): AppContext {
  const users = new UsersRepository(db);
  const oauth = new OAuthAccountsRepository(db);
  const sessions = new SessionsRepository(db);
  const driveRoots = new DriveRootsRepository(db);
  const buckets = new BucketsRepository(db);
  const objects = new ObjectsRepository(db);
  const credentials = new S3CredentialsRepository(db);
  const audit = new AuditLogsRepository(db);
  const objectStaging = new ObjectStagingRepository(db);
  const pendingCleanup = new PendingCleanupRepository(db);
  const multipartUploads = new MultipartUploadsRepository(db);
  const multipartParts = new MultipartPartsRepository(db);
  const driveTargets = new DriveTargetsRepository(db);
  const bucketMembers = new BucketMembersRepository(db);
  const publicObjectLinks = new PublicObjectLinksRepository(db);
  const bucketPolicies = new BucketPoliciesRepository(db);
  const kmsKeys = new KmsKeysRepository(db);
  const objectEncryption = new ObjectEncryptionRepository(db);
  const objectVersions = new ObjectVersionsRepository(db);
  const driveImports = new DriveImportsRepository(db);
  const settings = new SettingsRepository(db);
  const backupAccounts = new BackupAccountsRepository(db);
  const backupTransfers = new BackupTransfersRepository(db);
  const totp = new TotpRepository(db);
  const uploadLocks = new UploadLockRegistry();

  const sessionService = new SessionService(sessions, config);
  const runtimeSettings = new RuntimeSettingsService(config, settings);
  const tokenProvider = new TokenProvider(config, oauth, runtimeSettings);
  const backupTokenProvider = new BackupTokenProvider(config, backupAccounts, runtimeSettings);
  // storageOverride lets tests inject InMemoryDriveStorage.
  const driveLimits = new DriveLimits({
    uploads: config.maxUserUploads,
    downloads: config.maxUserDownloads,
    apiRequests: config.maxUserDriveRequests,
  });
  const driveQuotaMeter = new DriveQuotaMeter();
  const driveStorage: DriveStorage =
    storageOverride ??
    new GoogleDriveStorage(
      tokenProvider,
      driveRoots,
      runtimeSettings,
      driveLimits,
      config.driveRetryMaxAttempts,
      driveQuotaMeter,
    );
  const rootFolder = new RootFolderService(driveStorage);
  const bucketService = new BucketService(
    buckets,
    driveStorage,
    rootFolder,
    driveTargets,
    config.s3Region,
    config.s3DeleteMode,
  );
  const bucketAccess = new BucketAccessService(
    buckets,
    bucketMembers,
    users,
    driveTargets,
    driveStorage,
  );
  const credentialService = new CredentialService(credentials, config, db, audit);

  const ctx: AppContext = {
    config,
    db,
    log,
    repos: {
      users,
      oauth,
      sessions,
      driveRoots,
      buckets,
      objects,
      credentials,
      audit,
      objectStaging,
      pendingCleanup,
      multipartUploads,
      multipartParts,
      driveTargets,
      bucketMembers,
      publicObjectLinks,
      bucketPolicies,
      kmsKeys,
      objectEncryption,
      objectVersions,
      driveImports,
      settings,
      backupAccounts,
      backupTransfers,
      totp,
    },
    uploadLocks,
    sessionService,
    tokenProvider,
    backupTokenProvider,
    runtimeSettings,
    driveStorage,
    driveLimits,
    driveQuotaMeter,
    driveQuotaService: new DriveQuotaService(config, driveQuotaMeter, driveStorage),
    reconcileService: new ReconcileService(
      config,
      driveStorage,
      objects,
      buckets,
      driveTargets,
      audit,
      log,
    ),
    rootFolder,
    bucketService,
    bucketAccess,
    authorization: new AuthorizationService(buckets, bucketPolicies, users, bucketMembers, objects),
    kms: new KmsService(config, kmsKeys),
    credentialService,
    publicLinkService: new PublicLinkService(publicObjectLinks, config),
    presignedUrlService: new PresignedUrlService(config, credentials),
    rateLimits: new RateLimits(config),
    loginFlows: new Map(),
    backupLinkFlows: new Map(),
    // Assigned below: this service takes the completed context, which does not
    // exist until the literal is built.
    objectCopyService: undefined as unknown as ObjectCopyService,
  };
  ctx.objectCopyService = new ObjectCopyService(ctx);
  return ctx;
}
