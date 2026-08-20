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
import { UploadLockRegistry } from "./util/upload-lock.ts";
import { SessionService } from "./auth/session.ts";
import { TokenProvider } from "./drive/oauth-token.ts";
import { RootFolderService } from "./drive/root-folder.ts";
import { GoogleDriveStorage, type DriveStorage } from "./drive/storage.ts";
import { DriveLimits } from "./drive/limits.ts";
import { ReconcileService } from "./drive/reconcile.ts";
import { BucketService } from "./services/bucket-service.ts";
import { CredentialService } from "./services/credential-service.ts";
import { BucketAccessService } from "./services/bucket-access-service.ts";
import { RateLimits } from "./security/rate-limits.ts";
import { PublicLinkService } from "./services/public-link-service.ts";
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
    driveImports: DriveImportsRepository;
  };
  uploadLocks: UploadLockRegistry;
  sessionService: SessionService;
  tokenProvider: TokenProvider;
  driveStorage: DriveStorage;
  driveLimits: DriveLimits;
  reconcileService: ReconcileService;
  rootFolder: RootFolderService;
  bucketService: BucketService;
  bucketAccess: BucketAccessService;
  credentialService: CredentialService;
  publicLinkService: PublicLinkService;
  presignedUrlService: PresignedUrlService;
  rateLimits: RateLimits;
  // Ephemeral OAuth login flows keyed by state (in-memory, short-lived).
  loginFlows: Map<string, { pkceVerifier: string; createdAt: number }>;
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
  const driveImports = new DriveImportsRepository(db);
  const uploadLocks = new UploadLockRegistry();

  const sessionService = new SessionService(sessions, config);
  const tokenProvider = new TokenProvider(config, oauth);
  // storageOverride lets tests inject InMemoryDriveStorage.
  const driveLimits = new DriveLimits({
    uploads: config.maxUserUploads,
    downloads: config.maxUserDownloads,
    apiRequests: config.maxUserDriveRequests,
  });
  const driveStorage: DriveStorage =
    storageOverride ??
    new GoogleDriveStorage(tokenProvider, driveRoots, driveLimits, config.driveRetryMaxAttempts);
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

  return {
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
      driveImports,
    },
    uploadLocks,
    sessionService,
    tokenProvider,
    driveStorage,
    driveLimits,
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
    credentialService,
    publicLinkService: new PublicLinkService(publicObjectLinks, config),
    presignedUrlService: new PresignedUrlService(config, credentials),
    rateLimits: new RateLimits(config),
    loginFlows: new Map(),
  };
}
