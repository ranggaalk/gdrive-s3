// Thin fetch wrapper for the control-plane API. Unwraps the { data } envelope
// and carries the CSRF token on mutating requests.

export interface Me {
  id: string;
  email: string;
  displayName: string | null;
  hostedDomain: string;
  isAdmin: boolean;
  csrfToken: string;
}

export interface DriveStatus {
  connected: boolean;
  hasRootFolder: boolean;
  requiresReauthorization: boolean;
  reauthorizationUrl: string | null;
  lastRefreshAt: string | null;
  lastError: string | null;
}

export type StorageKind = "my_drive" | "shared_drive";
export type BucketRole = "owner" | "editor" | "viewer";

export interface Bucket {
  id: string;
  name: string;
  region: string;
  status: string;
  createdAt: string;
  storageKind: StorageKind;
  storageDisplayName: string;
  storageStatus: string;
  effectiveRole: BucketRole;
  ownedByMe: boolean;
  objectCount?: number;
  multipartOpen?: number;
  /** Whether an ACL or policy exposes this bucket to the anonymous public. */
  isPublic?: boolean;
}

export interface DriveFolderSummary {
  id: string;
  name: string;
}

export interface DriveImportJob {
  id: string;
  bucketId: string;
  sourceFolderId: string;
  sourceFolderName: string;
  sourceKind: StorageKind;
  sourceDriveId: string | null;
  phase: "scan" | "copy";
  status: "queued" | "running" | "cancel_requested" | "completed" | "cancelled" | "failed";
  discovered: number;
  imported: number;
  conflicts: number;
  unsupported: number;
  failed: number;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DriveImportIssue {
  id: string;
  key: string;
  name: string;
  status: "conflict" | "unsupported" | "failed";
  reason: string | null;
}

export interface SharedDriveSummary {
  id: string;
  name: string;
  canAddChildren: boolean;
  canDownload: boolean;
  canTrashChildren: boolean;
}

export interface BucketMember {
  user_id: string;
  email: string;
  display_name: string | null;
  role: "viewer" | "editor";
  access_status: string;
}

export type CompatStatus = "supported" | "unsupported" | "untested";
export type CompatSource = "aws-sdk" | "aws-cli" | "rclone" | "mc" | "unit";

export interface CompatibilityItem {
  feature: string;
  status: CompatStatus;
  verifiedBy?: CompatSource[];
  notes?: string;
}

export interface S3ConnectionConfig {
  s3Endpoint: string;
  s3Region: string;
}

export interface GatewayStatus extends S3ConnectionConfig {
  multipartOpen: number;
  compatibility: CompatibilityItem[];
}

export interface CredentialSummary {
  id: string;
  access_key_id: string;
  label: string;
  status: "active" | "revoked";
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface CreatedCredential extends S3ConnectionConfig {
  id: string;
  accessKeyId: string;
  secretAccessKey: string;
  label: string;
  createdAt: string;
}

export interface ObjectItem {
  id: string;
  key: string;
  size: number;
  contentType: string;
  etag: string;
  status: string;
  lastModified: string;
}

export interface AuditItem {
  id: string;
  action: string;
  bucketName: string | null;
  objectKey: string | null;
  statusCode: number | null;
  requestId: string;
  createdAt: string;
}

export type DriveCallKind = "api" | "upload" | "download";

export interface DriveQuotaWindow {
  windowSeconds: number;
  requests: number;
  throttled: number;
  errors: number;
  byKind: Record<DriveCallKind, number>;
  perMinute: number;
}

export interface DriveThrottleEvent {
  at: string;
  userId: string | null;
  kind: DriveCallKind;
  status: number;
  reason: string | null;
  retryAfterMs: number | null;
}

export interface DriveQuotaUser {
  userId: string;
  email: string | null;
  requestsLastHour: number;
  throttledLastHour: number;
  lastCallAt: string;
}

export interface DriveQuotaRow {
  metric: string;
  displayName: string;
  unit: string;
  limit: number | null;
  /** null when Google reported no usage for this limit — never an estimate. */
  consumed: number | null;
  remaining: number | null;
  usedRatio: number | null;
  consumedAt: string | null;
  scope: "project" | "user" | "other";
}

export interface DriveQuota {
  observed: {
    since: string;
    totalRequests: number;
    totalThrottled: number;
    windows: DriveQuotaWindow[];
    recentThrottles: DriveThrottleEvent[];
    users: DriveQuotaUser[];
    usersTracked: number;
  };
  concurrency: {
    uploadsPerUser: number;
    downloadsPerUser: number;
    apiRequestsPerUser: number;
    retryMaxAttempts: number;
  };
  storage: {
    limitBytes: number | null;
    usageBytes: number;
    usageInDriveBytes: number;
    usageInDriveTrashBytes: number;
    emailAddress: string | null;
    remainingBytes: number | null;
    usedRatio: number | null;
  } | null;
  storageError: string | null;
  live:
    | { configured: boolean; error: string; rows?: undefined }
    | {
        configured: true;
        projectId: string;
        rows: DriveQuotaRow[];
        sampledAt: string | null;
        /** Why `consumed` is missing, when limits read but Monitoring did not. */
        usageError: string | null;
        fetchedAt: string;
        error?: undefined;
      };
  canSeeUsers: boolean;
}

let csrfToken: string | null = null;

/**
 * Localized text for the server's error codes.
 *
 * The server answers in one language, so its `message` is a developer-facing
 * fallback rather than something a user should read. LocaleProvider registers
 * the active dictionary here, and `unwrap` resolves the code through it — one
 * place, so every call site gets localized errors without changing.
 */
let apiErrorMessages: Record<string, string> = {};

export function setApiErrorMessages(messages: Record<string, string>): void {
  apiErrorMessages = messages;
}

/** An error response from the control plane, carrying its stable code. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class MfaRequiredError extends Error {
  constructor() {
    super("MFA_REQUIRED");
  }
}

async function unwrap<T>(res: Response): Promise<T> {
  const json = (await res.json()) as { data?: T; error?: { code: string; message: string } };
  if (!res.ok || json.error) {
    const code = json.error?.code ?? "";
    // Prefer the localized text; fall back to the server's message so an
    // unmapped code still says something specific rather than nothing.
    const message =
      apiErrorMessages[code] ?? json.error?.message ?? `request failed: ${res.status}`;
    throw new ApiError(code, message);
  }
  return json.data as T;
}

function mutate(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: {
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  };
}

function mutateRaw(method: string, body: BodyInit, contentType: string): RequestInit {
  return {
    method,
    headers: {
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      "Content-Type": contentType || "application/octet-stream",
    },
    body,
  };
}

export async function getMe(): Promise<Me | null> {
  const res = await fetch("/api/me");
  if (res.status === 401) {
    const json = (await res.json().catch(() => null)) as { error?: { code: string } } | null;
    if (json?.error?.code === "MFA_REQUIRED") throw new MfaRequiredError();
    return null;
  }
  const me = await unwrap<Me>(res);
  csrfToken = me.csrfToken;
  return me;
}

export const getDriveStatus = async () => unwrap<DriveStatus>(await fetch("/api/drive/status"));
export const getDriveQuota = async () => unwrap<DriveQuota>(await fetch("/api/drive/quota"));
export const reconnectDrive = async () =>
  unwrap(await fetch("/api/drive/reconnect", mutate("POST")));

export const listBuckets = async () => unwrap<Bucket[]>(await fetch("/api/buckets"));
export const getBucket = async (id: string) =>
  unwrap<Bucket>(await fetch(`/api/buckets/${encodeURIComponent(id)}`));
export type TrafficRange = "1h" | "24h" | "7d";
export interface TrafficPoint {
  t: string;
  requests: number;
  errors: number;
  bytesIn: number;
  bytesOut: number;
}
export interface BucketTraffic {
  range: TrafficRange;
  granularity: "minute" | "hour" | "day";
  points: TrafficPoint[];
}
export const getBucketTraffic = async (bucketId: string, range: TrafficRange) =>
  unwrap<BucketTraffic>(
    await fetch(`/api/buckets/${encodeURIComponent(bucketId)}/traffic?range=${range}`),
  );
export const getOverviewTraffic = async (range: TrafficRange) =>
  unwrap<BucketTraffic>(await fetch(`/api/traffic?range=${range}`));
export const listSharedDrives = async () =>
  unwrap<{ items: SharedDriveSummary[]; nextPageToken: string | null }>(
    await fetch("/api/drive/shared-drives"),
  );
export const listDriveFolders = async (input: {
  kind: StorageKind;
  driveId?: string;
  parentId?: string;
  pageToken?: string;
}) => {
  const query = new URLSearchParams({ kind: input.kind });
  if (input.driveId) query.set("driveId", input.driveId);
  if (input.parentId) query.set("parentId", input.parentId);
  if (input.pageToken) query.set("pageToken", input.pageToken);
  return unwrap<{ current: DriveFolderSummary | null; items: DriveFolderSummary[]; nextPageToken: string | null }>(
    await fetch(`/api/drive/folders?${query}`),
  );
};
export const listDriveImports = async (bucketId: string) =>
  unwrap<DriveImportJob[]>(await fetch(`/api/buckets/${encodeURIComponent(bucketId)}/imports`));
export const createDriveImport = async (
  bucketId: string,
  source: { sourceKind: StorageKind; sourceDriveId?: string; sourceFolderId: string },
) => unwrap<DriveImportJob>(
  await fetch(`/api/buckets/${encodeURIComponent(bucketId)}/imports`, mutate("POST", source)),
);
export const getDriveImport = async (bucketId: string, jobId: string) =>
  unwrap<DriveImportJob>(
    await fetch(`/api/buckets/${encodeURIComponent(bucketId)}/imports/${encodeURIComponent(jobId)}`),
  );
export const listDriveImportIssues = async (bucketId: string, jobId: string) =>
  unwrap<{ items: DriveImportIssue[]; hasMore: boolean; nextAfter: string | null }>(
    await fetch(`/api/buckets/${encodeURIComponent(bucketId)}/imports/${encodeURIComponent(jobId)}/items`),
  );
export const cancelDriveImport = async (bucketId: string, jobId: string) =>
  unwrap(await fetch(
    `/api/buckets/${encodeURIComponent(bucketId)}/imports/${encodeURIComponent(jobId)}/cancel`,
    mutate("POST"),
  ));
export const createBucket = async (
  name: string,
  storage: { kind: StorageKind; driveId?: string } = { kind: "my_drive" },
) => unwrap<Bucket>(await fetch("/api/buckets", mutate("POST", { name, storage })));
export const deleteBucket = async (id: string) =>
  unwrap(await fetch(`/api/buckets/${id}`, mutate("DELETE")));
export const listBucketMembers = async (bucketId: string) =>
  unwrap<BucketMember[]>(await fetch(`/api/buckets/${bucketId}/members`));
export const addBucketMember = async (
  bucketId: string,
  email: string,
  role: "viewer" | "editor",
) =>
  unwrap<BucketMember>(
    await fetch(`/api/buckets/${bucketId}/members`, mutate("POST", { email, role })),
  );
export const updateBucketMember = async (
  bucketId: string,
  userId: string,
  role: "viewer" | "editor",
) =>
  unwrap(
    await fetch(`/api/buckets/${bucketId}/members/${userId}`, mutate("PATCH", { role })),
  );
export const removeBucketMember = async (bucketId: string, userId: string) =>
  unwrap(
    await fetch(`/api/buckets/${bucketId}/members/${userId}`, mutate("DELETE")),
  );

export interface ObjectPage {
  items: ObjectItem[];
  hasMore: boolean;
  nextAfter: string | null;
}

export interface PublicLinkSummary {
  id: string;
  label: string;
  status: "active" | "revoked";
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
}

export interface CreatedPublicLink extends PublicLinkSummary {
  url: string;
}

export interface PresignedLink {
  url: string;
  expiresAt: string;
  credentialId: string;
}

export type BucketAcl =
  | "private"
  | "public-read"
  | "public-read-write"
  | "authenticated-read";

export type SseAlgorithm = "AES256" | "aws:kms";

export interface BucketAccessConfig {
  acl: BucketAcl;
  /** The raw policy JSON, or null when the bucket has none. */
  policy: string | null;
  policyUpdatedAt: string | null;
  isPublic: boolean;
  defaultSseAlgorithm: SseAlgorithm | null;
  defaultKmsKeyId: string | null;
  versioning: BucketVersioning;
  /** How many superseded versions and delete markers the bucket holds. */
  retainedVersions: number;
  objectLockEnabled: boolean;
  objectLockDefault: { mode: LockMode; days: number } | null;
}

export type LockMode = "GOVERNANCE" | "COMPLIANCE";

export type BucketVersioning = "Disabled" | "Enabled" | "Suspended";

export interface ObjectVersion {
  versionId: string;
  isLatest: boolean;
  isDeleteMarker: boolean;
  size: number;
  etag: string | null;
  lastModified: string;
}

export interface KmsKey {
  id: string;
  alias: string;
  version: number;
  status: "active" | "disabled";
  rotatedAt: string | null;
  createdAt: string;
  /** How many objects still reference this key. */
  objectCount: number;
}

export interface PresignedPostForm {
  url: string;
  /** Hidden inputs the form must submit, in order, before the file input. */
  fields: Record<string, string>;
  expiresAt: string;
  credentialId: string;
  keyTemplate: string;
  maxBytes: number;
}

export const listObjects = async (
  bucketId: string,
  prefix = "",
  after = "",
  limit = 100,
) => {
  const query = new URLSearchParams({ prefix, limit: String(limit) });
  if (after) query.set("after", after);
  return unwrap<ObjectPage>(
    await fetch(`/api/buckets/${encodeURIComponent(bucketId)}/objects?${query}`),
  );
};

export const uploadObject = async (bucketId: string, key: string, file: File) =>
  unwrap<ObjectItem>(
    await fetch(
      `/api/buckets/${encodeURIComponent(bucketId)}/objects?key=${encodeURIComponent(key)}`,
      mutateRaw("POST", file, file.type),
    ),
  );

export const deleteObject = async (bucketId: string, objectId: string) =>
  unwrap(
    await fetch(
      `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectId)}`,
      mutate("DELETE"),
    ),
  );

export const objectDownloadUrl = (bucketId: string, objectId: string) =>
  `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectId)}/download`;
export const objectPreviewUrl = (bucketId: string, objectId: string) =>
  `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectId)}/preview`;

export const createPresignedLink = async (
  bucketId: string,
  objectId: string,
  credentialId: string,
  expiresSeconds: number,
) => unwrap<PresignedLink>(await fetch(
  `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectId)}/presigned-links`,
  mutate("POST", { credentialId, expiresSeconds }),
));

export const getBucketAccess = async (bucketId: string) =>
  unwrap<BucketAccessConfig>(
    await fetch(`/api/buckets/${encodeURIComponent(bucketId)}/access`),
  );

export const updateBucketAccess = async (
  bucketId: string,
  changes: {
    acl?: BucketAcl;
    policy?: string | null;
    defaultSseAlgorithm?: SseAlgorithm | null;
    defaultKmsKeyId?: string | null;
    versioning?: Exclude<BucketVersioning, "Disabled">;
    objectLockEnabled?: true;
    objectLockDefault?: { mode: LockMode; days: number } | null;
  },
) => unwrap<BucketAccessConfig>(await fetch(
  `/api/buckets/${encodeURIComponent(bucketId)}/access`,
  mutate("PUT", changes),
));

export const copyObjectTo = async (
  bucketId: string,
  objectId: string,
  targetBucketId: string,
  targetKey: string,
) => unwrap<{ key: string; bucketId: string; size: number }>(await fetch(
  `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectId)}/copy`,
  mutate("POST", { targetBucketId, targetKey }),
));

export const listObjectVersions = async (bucketId: string, objectId: string) =>
  unwrap<ObjectVersion[]>(await fetch(
    `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectId)}/versions`,
  ));

export const deleteObjectVersion = async (
  bucketId: string,
  objectId: string,
  versionId: string,
) => unwrap(await fetch(
  `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectId)}/versions/${encodeURIComponent(versionId)}`,
  mutate("DELETE"),
));

export const pruneBucketVersions = async (bucketId: string) =>
  unwrap<{ removed: number }>(await fetch(
    `/api/buckets/${encodeURIComponent(bucketId)}/versions`,
    mutate("DELETE"),
  ));

export const listKmsKeys = async () =>
  unwrap<KmsKey[]>(await fetch("/api/security/kms"));

export const createKmsKey = async (alias: string) =>
  unwrap<KmsKey>(await fetch("/api/security/kms", mutate("POST", { alias })));

export const rotateKmsKey = async (id: string) =>
  unwrap<KmsKey>(
    await fetch(`/api/security/kms/${encodeURIComponent(id)}/rotate`, mutate("POST")),
  );

export const setKmsKeyStatus = async (id: string, status: "active" | "disabled") =>
  unwrap<KmsKey>(
    await fetch(`/api/security/kms/${encodeURIComponent(id)}`, mutate("PATCH", { status })),
  );

export const createPresignedPost = async (
  bucketId: string,
  credentialId: string,
  keyPrefix: string,
  expiresSeconds: number,
  maxBytes: number,
) => unwrap<PresignedPostForm>(await fetch(
  `/api/buckets/${encodeURIComponent(bucketId)}/presigned-post`,
  mutate("POST", { credentialId, keyPrefix, expiresSeconds, maxBytes }),
));

export const listPublicLinks = async (bucketId: string, objectId: string) =>
  unwrap<PublicLinkSummary[]>(await fetch(
    `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectId)}/public-links`,
  ));

export const createPublicLink = async (
  bucketId: string,
  objectId: string,
  label: string,
  expiresAt: string | null,
) => unwrap<CreatedPublicLink>(await fetch(
  `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectId)}/public-links`,
  mutate("POST", { label, expiresAt }),
));

export const revokePublicLink = async (bucketId: string, objectId: string, linkId: string) =>
  unwrap(await fetch(
    `/api/buckets/${encodeURIComponent(bucketId)}/objects/${encodeURIComponent(objectId)}/public-links/${encodeURIComponent(linkId)}`,
    mutate("DELETE"),
  ));

export const listCredentials = async () =>
  unwrap<CredentialSummary[]>(await fetch("/api/credentials"));
export const createCredential = async (label: string) =>
  unwrap<CreatedCredential>(await fetch("/api/credentials", mutate("POST", { label })));
export const rotateCredential = async (id: string) =>
  unwrap<CreatedCredential>(
    await fetch(`/api/credentials/${encodeURIComponent(id)}/rotate`, mutate("POST")),
  );
export const revokeCredential = async (id: string) =>
  unwrap(await fetch(`/api/credentials/${encodeURIComponent(id)}/revoke`, mutate("POST")));
export const deleteCredential = async (id: string) =>
  unwrap(await fetch(`/api/credentials/${encodeURIComponent(id)}`, mutate("DELETE")));

export const listAudit = async (before = "") => {
  const query = before ? `?before=${encodeURIComponent(before)}` : "";
  return unwrap<{ items: AuditItem[]; nextBefore: string | null }>(await fetch(`/api/audit${query}`));
};

export const getGatewayStatus = async () =>
  unwrap<GatewayStatus>(await fetch("/api/status"));

export interface ReconcileResult {
  examined: number;
  active: number;
  missing: number;
  externallyModified: number;
  errors: number;
  nextAfterUpdated: string | null;
}

export const reconcileDrive = async () =>
  unwrap<ReconcileResult>(
    await fetch("/api/drive/reconcile", mutate("POST")),
  );

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

export const getSettingsStatus = async () =>
  unwrap<{ googleOAuth: GoogleOAuthSettingsStatus; rootFolderName: RootFolderNameStatus }>(
    await fetch("/api/settings"),
  );

export const updateGoogleOAuthSettings = async (clientId: string, clientSecret: string) =>
  unwrap<{ googleOAuth: GoogleOAuthSettingsStatus }>(
    await fetch("/api/settings/google-oauth", mutate("PUT", { clientId, clientSecret })),
  );

export const resetGoogleOAuthSettings = async () =>
  unwrap<{ googleOAuth: GoogleOAuthSettingsStatus }>(
    await fetch("/api/settings/google-oauth", mutate("DELETE")),
  );

export const updateRootFolderNameSetting = async (name: string) =>
  unwrap<{ rootFolderName: RootFolderNameStatus }>(
    await fetch("/api/settings/root-folder-name", mutate("PUT", { name })),
  );

export const resetRootFolderNameSetting = async () =>
  unwrap<{ rootFolderName: RootFolderNameStatus }>(
    await fetch("/api/settings/root-folder-name", mutate("DELETE")),
  );

export interface BackupAccount {
  id: string;
  email: string;
  status: "active" | "reauthorization_required" | "error";
  lastError: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type BackupTransferStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | "completed"
  | "cancelled"
  | "failed";

export interface BackupTransfer {
  id: string;
  bucketId: string;
  backupAccountId: string;
  status: BackupTransferStatus;
  total: number;
  skipped: number;
  copied: number;
  failed: number;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

export const listBackupAccounts = async () =>
  unwrap<BackupAccount[]>(await fetch("/api/backup-accounts"));

export const startBackupAccountLink = () => {
  window.location.href = "/auth/google/link-start";
};

export const deleteBackupAccount = async (id: string) =>
  unwrap(await fetch(`/api/backup-accounts/${encodeURIComponent(id)}`, mutate("DELETE")));

export const listBucketBackups = async (bucketId: string) =>
  unwrap<BackupTransfer[]>(await fetch(`/api/buckets/${encodeURIComponent(bucketId)}/backups`));

export const startBucketBackup = async (bucketId: string, backupAccountId: string) =>
  unwrap<BackupTransfer>(
    await fetch(`/api/buckets/${encodeURIComponent(bucketId)}/backups`, mutate("POST", { backupAccountId })),
  );

export const getBucketBackup = async (bucketId: string, transferId: string) =>
  unwrap<BackupTransfer>(
    await fetch(`/api/buckets/${encodeURIComponent(bucketId)}/backups/${encodeURIComponent(transferId)}`),
  );

export const cancelBucketBackup = async (bucketId: string, transferId: string) =>
  unwrap(
    await fetch(
      `/api/buckets/${encodeURIComponent(bucketId)}/backups/${encodeURIComponent(transferId)}/cancel`,
      mutate("POST"),
    ),
  );

// Gateway-wide backup history (/api/backups). The bucket-scoped calls above
// only ever see one bucket; these answer "what has been backed up anywhere,
// and where did each object end up".

export interface BackupHistoryItem extends BackupTransfer {
  bucketName: string;
  accountEmail: string;
  startedAt: string | null;
  updatedAt: string;
}

/** How many ledger lines the run still owns. A later run that re-copied the
 *  same object takes its line over, so this can sit below the run's own
 *  counters — the detail view says so rather than looking like lost rows. */
export interface BackupHistoryDetail extends BackupHistoryItem {
  ledger: { copied: number; failed: number };
}

export interface BackupObjectItem {
  objectId: string;
  objectKey: string;
  objectEtag: string;
  status: "copied" | "failed";
  destinationFileId: string | null;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
}

export interface BackupAccountSummary {
  backupAccountId: string;
  email: string;
  accountStatus: BackupAccount["status"];
  runs: number;
  activeRuns: number;
  lastRunAt: string | null;
  lastStatus: BackupTransferStatus | null;
  copiedTotal: number;
  skippedTotal: number;
  failedTotal: number;
  objectsOnRecord: number;
}

export interface BackupSummary {
  totals: {
    accounts: number;
    runs: number;
    activeRuns: number;
    copied: number;
    skipped: number;
    failed: number;
    objectsOnRecord: number;
  };
  accounts: BackupAccountSummary[];
}

export interface BackupHistoryFilters {
  accountId?: string;
  bucketId?: string;
  status?: BackupTransferStatus;
  before?: string | null;
  limit?: number;
}

function historyQuery(filters: BackupHistoryFilters): string {
  const params = new URLSearchParams();
  if (filters.accountId) params.set("accountId", filters.accountId);
  if (filters.bucketId) params.set("bucketId", filters.bucketId);
  if (filters.status) params.set("status", filters.status);
  if (filters.before) params.set("before", filters.before);
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const listBackupHistory = async (filters: BackupHistoryFilters = {}) =>
  unwrap<{ items: BackupHistoryItem[]; nextBefore: string | null }>(
    await fetch(`/api/backups${historyQuery(filters)}`),
  );

export const getBackupSummary = async () =>
  unwrap<BackupSummary>(await fetch("/api/backups/summary"));

export const getBackupRun = async (transferId: string) =>
  unwrap<BackupHistoryDetail>(await fetch(`/api/backups/${encodeURIComponent(transferId)}`));

export const listBackupRunObjects = async (
  transferId: string,
  options: { status?: "copied" | "failed"; before?: string | null; limit?: number } = {},
) => {
  const params = new URLSearchParams();
  if (options.status) params.set("status", options.status);
  if (options.before) params.set("before", options.before);
  if (options.limit) params.set("limit", String(options.limit));
  const query = params.toString();
  return unwrap<{ items: BackupObjectItem[]; nextBefore: string | null }>(
    await fetch(`/api/backups/${encodeURIComponent(transferId)}/objects${query ? `?${query}` : ""}`),
  );
};

// Login-time 2FA verification (/auth/mfa/*, deliberately outside /api/* —
// see server routes/mfa-auth.ts). getMfaLoginStatus also refreshes the
// module-level csrfToken since the normal /api/me bootstrap never succeeds
// while a session is mfa_pending.
export interface MfaLoginStatus {
  pending: boolean;
  csrfToken: string;
}

export const getMfaLoginStatus = async () => {
  const status = await unwrap<MfaLoginStatus>(await fetch("/auth/mfa/status"));
  csrfToken = status.csrfToken;
  return status;
};

export const verifyMfaLogin = async (code: string) =>
  unwrap<{ ok: true }>(await fetch("/auth/mfa/verify", mutate("POST", { code })));

// TOTP 2FA setup/management for the current user (/api/security/totp/*).
export interface TotpStatus {
  enabled: boolean;
  pendingSetup: boolean;
  recoveryCodesRemaining: number;
}

export interface TotpSetupInfo {
  otpauthUri: string;
  manualEntryKey: string;
}

export const getTotpStatus = async () => unwrap<TotpStatus>(await fetch("/api/security/totp"));

export const startTotpSetup = async () =>
  unwrap<TotpSetupInfo>(await fetch("/api/security/totp/setup", mutate("POST")));

export const confirmTotpSetup = async (code: string) =>
  unwrap<{ recoveryCodes: string[] }>(
    await fetch("/api/security/totp/confirm", mutate("POST", { code })),
  );

export const disableTotp = async (code: string) =>
  unwrap<{ disabled: true }>(await fetch("/api/security/totp/disable", mutate("POST", { code })));

export const regenerateRecoveryCodes = async (code: string) =>
  unwrap<{ recoveryCodes: string[] }>(
    await fetch("/api/security/totp/recovery-codes", mutate("POST", { code })),
  );
