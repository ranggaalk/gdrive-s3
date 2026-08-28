// Startup configuration. Every env var is validated here; the process must
// refuse to boot with an invalid security configuration (AGENTS.md §6, §20).

import { readFileSync } from "node:fs";
import {
  parseServiceAccountKey,
  ServiceAccountError,
  type ServiceAccountKey,
} from "./auth/google-service-account.ts";

export type DeleteMode = "trash" | "permanent";

export interface AppConfig {
  nodeEnv: "development" | "production" | "test";
  isProduction: boolean;
  appName: string;
  appOrigin: string;
  serverHost: string;
  serverPort: number;

  google: {
    // Empty string means the Workspace-domain login path is disabled.
    workspaceDomain: string;
    // Lowercased emails allowed to log in regardless of hosted domain.
    // At least one of workspaceDomain or allowedEmails must be set.
    allowedEmails: string[];
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    driveScope: string;
  };

  /**
   * Optional read-only Google Cloud credential used to read the Drive API's
   * live request quota. Without it the dashboard still reports the usage this
   * gateway observes, but cannot show Google's own limit or remaining figure —
   * Drive API responses carry no quota headers to infer it from.
   */
  driveQuota: {
    projectId: string;
    serviceAccount: ServiceAccountKey | null;
    cacheSeconds: number;
  };

  // Lowercased emails granted admin access (e.g. the Settings page that can
  // change the Google OAuth client credentials at runtime). Empty by default:
  // nobody is admin until explicitly configured.
  adminEmails: string[];

  masterEncryptionKey: Buffer; // exactly 32 bytes
  sessionSecret: Buffer; // >= 32 bytes

  sqlitePath: string;
  multipartTempDir: string;
  multipartTtlHours: number;
  orphanRetentionHours: number;

  driveResumableThresholdBytes: number;
  driveUploadChunkBytes: number;

  s3DeleteMode: DeleteMode;
  s3PublicEndpoint: string;
  s3Region: string;
  s3RequireTls: boolean;
  // "" disables virtual-hosted-style addressing (path-style only). When set,
  // a request Host of "{bucket}.{this value}" is treated as virtual-hosted;
  // any other Host (including the bare domain itself) stays path-style.
  s3VirtualHostedDomain: string;
  /** Whether an unsigned request may be admitted by a public ACL or bucket
   *  policy. Turning this off makes SigV4 mandatory again, whatever any
   *  ACL or policy says. */
  s3AllowAnonymous: boolean;

  maxSinglePutBytes: number;
  maxMultipartObjectBytes: number;
  maxParts: number;
  minMultipartPartBytes: number;

  maxUserUploads: number;
  maxUserDownloads: number;
  maxUserDriveRequests: number;
  driveRetryMaxAttempts: number;
  cleanupBatchSize: number;
  cleanupIntervalMs: number;
  stagingStaleAfterMs: number;
  reconcileBatchSize: number;
  driveImportPageSize: number;
  driveImportBatchSize: number;
  driveImportIntervalMs: number;

  presignedMinExpiresSeconds: number;
  presignedMaxExpiresSeconds: number;
  multipartExpiryBatchSize: number;

  // Milestone 7 hardening knobs.
  maxControlJsonBytes: number;
  maxS3XmlBytes: number;
  serveDashboard: boolean;
  staticRoot: string;
  rateLimit: {
    enabled: boolean;
    loginPerMinute: number;
    credentialCreatePerHour: number;
    signatureFailuresPerMinute: number;
    s3PublicRpsPerIp: number;
    s3AnonymousRpsPerIp: number;
    publicShareRpsPerIp: number;
    mfaVerifyPerMinute: number;
    maxKeys: number;
  };

  logLevel: "debug" | "info" | "warn" | "error";
  trustProxy: boolean;
}

class ConfigError extends Error {}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`Missing required env var: ${key}`);
  }
  return value;
}

function optional(
  env: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const value = env[key];
  return value === undefined || value.trim() === "" ? fallback : value;
}

function parseAllowedEmails(value: string): string[] {
  return [...new Set(
    value
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  )];
}

function parseIntStrict(value: string, key: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(`Env var ${key} must be a non-negative integer, got: ${value}`);
  }
  return n;
}

function parseBool(value: string, key: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigError(`Env var ${key} must be 'true' or 'false', got: ${value}`);
}

function decodeBase64Key(value: string, key: string, minBytes: number, exactBytes?: number): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(value, "base64");
  } catch {
    throw new ConfigError(`Env var ${key} must be valid base64`);
  }
  // Buffer.from silently drops invalid chars; re-encode to detect junk.
  if (buf.length === 0 || buf.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new ConfigError(`Env var ${key} is not clean base64`);
  }
  if (exactBytes !== undefined && buf.length !== exactBytes) {
    throw new ConfigError(`Env var ${key} must decode to exactly ${exactBytes} bytes, got ${buf.length}`);
  }
  if (buf.length < minBytes) {
    throw new ConfigError(`Env var ${key} must decode to at least ${minBytes} bytes, got ${buf.length}`);
  }
  return buf;
}

function validateUrl(value: string, key: string): string {
  try {
    // eslint-disable-next-line no-new
    new URL(value);
  } catch {
    throw new ConfigError(`Env var ${key} must be a valid URL, got: ${value}`);
  }
  return value;
}

const HOSTNAME_PATTERN = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

function validateHostname(value: string, key: string): string {
  if (!HOSTNAME_PATTERN.test(value)) {
    throw new ConfigError(
      `Env var ${key} must be a bare hostname (no scheme, path, or port), got: ${value}`,
    );
  }
  return value.toLowerCase();
}

function validateEndpointUrl(value: string, key: string): string {
  const valid = validateUrl(value, key);
  const url = new URL(valid);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`Env var ${key} must use http or https`);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new ConfigError(
      `Env var ${key} must be an origin without credentials, path, query, or fragment`,
    );
  }
  return url.origin;
}

function loadDriveQuotaConfig(
  env: Record<string, string | undefined>,
): AppConfig["driveQuota"] {
  const inline = optional(env, "GOOGLE_QUOTA_SERVICE_ACCOUNT_JSON", "");
  const file = optional(env, "GOOGLE_QUOTA_SERVICE_ACCOUNT_FILE", "");
  const cacheSeconds = parseIntStrict(
    optional(env, "GOOGLE_QUOTA_CACHE_SECONDS", "60"),
    "GOOGLE_QUOTA_CACHE_SECONDS",
  );
  if (cacheSeconds < 10) {
    // Cloud Monitoring publishes quota samples once a minute and enforces
    // quotas of its own; polling it faster buys nothing.
    throw new ConfigError("GOOGLE_QUOTA_CACHE_SECONDS must be >= 10");
  }

  if (inline !== "" && file !== "") {
    throw new ConfigError(
      "Set only one of GOOGLE_QUOTA_SERVICE_ACCOUNT_JSON or GOOGLE_QUOTA_SERVICE_ACCOUNT_FILE",
    );
  }

  let raw = inline;
  if (file !== "") {
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      throw new ConfigError(
        `GOOGLE_QUOTA_SERVICE_ACCOUNT_FILE could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  let serviceAccount: ServiceAccountKey | null = null;
  if (raw !== "") {
    try {
      serviceAccount = parseServiceAccountKey(raw);
    } catch (error) {
      throw new ConfigError(
        error instanceof ServiceAccountError
          ? `Invalid quota service account key: ${error.message}`
          : `Invalid quota service account key`,
      );
    }
  }

  // The key file names its own project, so only ask for the id when it is
  // absent or the quota lives in a different project.
  const projectId = optional(env, "GOOGLE_QUOTA_PROJECT_ID", serviceAccount?.projectId ?? "");
  if (projectId !== "" && serviceAccount === null) {
    throw new ConfigError(
      "GOOGLE_QUOTA_PROJECT_ID needs GOOGLE_QUOTA_SERVICE_ACCOUNT_JSON or _FILE to read quota with",
    );
  }
  if (serviceAccount !== null && projectId === "") {
    throw new ConfigError(
      "Set GOOGLE_QUOTA_PROJECT_ID: the quota service account key does not name a project",
    );
  }

  return { projectId, serviceAccount, cacheSeconds };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const nodeEnvRaw = optional(env, "NODE_ENV", "development");
  if (!["development", "production", "test"].includes(nodeEnvRaw)) {
    throw new ConfigError(`NODE_ENV must be development|production|test, got: ${nodeEnvRaw}`);
  }
  const nodeEnv = nodeEnvRaw as AppConfig["nodeEnv"];
  const isProduction = nodeEnv === "production";

  const logLevelRaw = optional(env, "LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error"].includes(logLevelRaw)) {
    throw new ConfigError(`LOG_LEVEL must be debug|info|warn|error, got: ${logLevelRaw}`);
  }

  const deleteModeRaw = optional(env, "S3_DELETE_MODE", "trash");
  if (deleteModeRaw !== "trash" && deleteModeRaw !== "permanent") {
    throw new ConfigError(`S3_DELETE_MODE must be trash|permanent, got: ${deleteModeRaw}`);
  }

  const s3RequireTls = parseBool(optional(env, "S3_REQUIRE_TLS", "false"), "S3_REQUIRE_TLS");

  const config: AppConfig = {
    nodeEnv,
    isProduction,
    appName: optional(env, "APP_NAME", "DriveS3 Gateway"),
    appOrigin: validateUrl(optional(env, "APP_ORIGIN", "http://localhost:3000"), "APP_ORIGIN"),
    serverHost: optional(env, "SERVER_HOST", "0.0.0.0"),
    serverPort: parseIntStrict(optional(env, "SERVER_PORT", "3000"), "SERVER_PORT"),

    google: {
      workspaceDomain: optional(env, "GOOGLE_WORKSPACE_DOMAIN", ""),
      allowedEmails: parseAllowedEmails(optional(env, "ALLOWED_EMAILS", "")),
      clientId: required(env, "GOOGLE_CLIENT_ID"),
      clientSecret: required(env, "GOOGLE_CLIENT_SECRET"),
      redirectUri: validateUrl(required(env, "GOOGLE_REDIRECT_URI"), "GOOGLE_REDIRECT_URI"),
      driveScope: optional(
        env,
        "GOOGLE_DRIVE_SCOPE",
        "https://www.googleapis.com/auth/drive",
      ),
    },

    driveQuota: loadDriveQuotaConfig(env),

    adminEmails: parseAllowedEmails(optional(env, "ADMIN_EMAILS", "")),

    masterEncryptionKey: decodeBase64Key(
      required(env, "MASTER_ENCRYPTION_KEY"),
      "MASTER_ENCRYPTION_KEY",
      32,
      32,
    ),
    sessionSecret: decodeBase64Key(required(env, "SESSION_SECRET"), "SESSION_SECRET", 32),

    sqlitePath: optional(env, "SQLITE_PATH", "./data/app.sqlite"),
    multipartTempDir: optional(env, "MULTIPART_TEMP_DIR", "./data/multipart"),
    multipartTtlHours: parseIntStrict(optional(env, "MULTIPART_TTL_HOURS", "24"), "MULTIPART_TTL_HOURS"),
    orphanRetentionHours: parseIntStrict(
      optional(env, "ORPHAN_RETENTION_HOURS", "24"),
      "ORPHAN_RETENTION_HOURS",
    ),

    driveResumableThresholdBytes: parseIntStrict(
      optional(env, "DRIVE_RESUMABLE_THRESHOLD_BYTES", "5242880"),
      "DRIVE_RESUMABLE_THRESHOLD_BYTES",
    ),
    driveUploadChunkBytes: parseIntStrict(
      optional(env, "DRIVE_UPLOAD_CHUNK_BYTES", "8388608"),
      "DRIVE_UPLOAD_CHUNK_BYTES",
    ),

    s3DeleteMode: deleteModeRaw,
    s3PublicEndpoint: validateEndpointUrl(
      optional(env, "S3_PUBLIC_ENDPOINT", "http://localhost:3000"),
      "S3_PUBLIC_ENDPOINT",
    ),
    s3Region: optional(env, "S3_REGION", "us-east-1"),
    s3RequireTls,
    s3VirtualHostedDomain: (() => {
      const raw = optional(env, "S3_VIRTUAL_HOSTED_DOMAIN", "");
      return raw === "" ? "" : validateHostname(raw, "S3_VIRTUAL_HOSTED_DOMAIN");
    })(),
    s3AllowAnonymous: parseBool(
      optional(env, "S3_ALLOW_ANONYMOUS", "true"),
      "S3_ALLOW_ANONYMOUS",
    ),

    maxSinglePutBytes: parseIntStrict(
      optional(env, "MAX_SINGLE_PUT_BYTES", "5368709120"),
      "MAX_SINGLE_PUT_BYTES",
    ),
    maxMultipartObjectBytes: parseIntStrict(
      optional(env, "MAX_MULTIPART_OBJECT_BYTES", "536870912000"),
      "MAX_MULTIPART_OBJECT_BYTES",
    ),
    maxParts: parseIntStrict(optional(env, "MAX_PARTS", "10000"), "MAX_PARTS"),
    minMultipartPartBytes: parseIntStrict(
      optional(env, "MIN_MULTIPART_PART_BYTES", "5242880"),
      "MIN_MULTIPART_PART_BYTES",
    ),

    maxUserUploads: parseIntStrict(optional(env, "MAX_USER_UPLOADS", "2"), "MAX_USER_UPLOADS"),
    maxUserDownloads: parseIntStrict(
      optional(env, "MAX_USER_DOWNLOADS", "4"),
      "MAX_USER_DOWNLOADS",
    ),
    maxUserDriveRequests: parseIntStrict(
      optional(env, "MAX_USER_DRIVE_REQUESTS", "8"),
      "MAX_USER_DRIVE_REQUESTS",
    ),
    driveRetryMaxAttempts: parseIntStrict(
      optional(env, "DRIVE_RETRY_MAX_ATTEMPTS", "5"),
      "DRIVE_RETRY_MAX_ATTEMPTS",
    ),
    cleanupBatchSize: parseIntStrict(
      optional(env, "CLEANUP_BATCH_SIZE", "50"),
      "CLEANUP_BATCH_SIZE",
    ),
    cleanupIntervalMs: parseIntStrict(
      optional(env, "CLEANUP_INTERVAL_MS", "60000"),
      "CLEANUP_INTERVAL_MS",
    ),
    stagingStaleAfterMs: parseIntStrict(
      optional(env, "STAGING_STALE_AFTER_MS", "3600000"),
      "STAGING_STALE_AFTER_MS",
    ),
    reconcileBatchSize: parseIntStrict(
      optional(env, "RECONCILE_BATCH_SIZE", "100"),
      "RECONCILE_BATCH_SIZE",
    ),
    driveImportPageSize: parseIntStrict(
      optional(env, "DRIVE_IMPORT_PAGE_SIZE", "100"),
      "DRIVE_IMPORT_PAGE_SIZE",
    ),
    driveImportBatchSize: parseIntStrict(
      optional(env, "DRIVE_IMPORT_BATCH_SIZE", "5"),
      "DRIVE_IMPORT_BATCH_SIZE",
    ),
    driveImportIntervalMs: parseIntStrict(
      optional(env, "DRIVE_IMPORT_INTERVAL_MS", "2000"),
      "DRIVE_IMPORT_INTERVAL_MS",
    ),
    presignedMinExpiresSeconds: parseIntStrict(
      optional(env, "PRESIGNED_MIN_EXPIRES_SECONDS", "1"),
      "PRESIGNED_MIN_EXPIRES_SECONDS",
    ),
    presignedMaxExpiresSeconds: parseIntStrict(
      optional(env, "PRESIGNED_MAX_EXPIRES_SECONDS", "604800"),
      "PRESIGNED_MAX_EXPIRES_SECONDS",
    ),
    multipartExpiryBatchSize: parseIntStrict(
      optional(env, "MULTIPART_EXPIRY_BATCH_SIZE", "50"),
      "MULTIPART_EXPIRY_BATCH_SIZE",
    ),

    maxControlJsonBytes: parseIntStrict(
      optional(env, "MAX_CONTROL_JSON_BYTES", "65536"),
      "MAX_CONTROL_JSON_BYTES",
    ),
    maxS3XmlBytes: parseIntStrict(
      optional(env, "MAX_S3_XML_BYTES", "1048576"),
      "MAX_S3_XML_BYTES",
    ),
    serveDashboard: parseBool(
      optional(env, "SERVE_DASHBOARD", "true"),
      "SERVE_DASHBOARD",
    ),
    staticRoot: optional(env, "STATIC_ROOT", "./dist/web"),
    rateLimit: {
      enabled: parseBool(optional(env, "RATE_LIMIT_ENABLED", "true"), "RATE_LIMIT_ENABLED"),
      loginPerMinute: parseIntStrict(
        optional(env, "RATE_LIMIT_LOGIN_PER_MINUTE", "10"),
        "RATE_LIMIT_LOGIN_PER_MINUTE",
      ),
      credentialCreatePerHour: parseIntStrict(
        optional(env, "RATE_LIMIT_CREDENTIAL_CREATE_PER_HOUR", "20"),
        "RATE_LIMIT_CREDENTIAL_CREATE_PER_HOUR",
      ),
      signatureFailuresPerMinute: parseIntStrict(
        optional(env, "RATE_LIMIT_SIGNATURE_FAILURES_PER_MINUTE", "30"),
        "RATE_LIMIT_SIGNATURE_FAILURES_PER_MINUTE",
      ),
      s3PublicRpsPerIp: parseIntStrict(
        optional(env, "RATE_LIMIT_S3_PUBLIC_RPS_PER_IP", "200"),
        "RATE_LIMIT_S3_PUBLIC_RPS_PER_IP",
      ),
      s3AnonymousRpsPerIp: parseIntStrict(
        optional(env, "RATE_LIMIT_S3_ANONYMOUS_RPS_PER_IP", "50"),
        "RATE_LIMIT_S3_ANONYMOUS_RPS_PER_IP",
      ),
      publicShareRpsPerIp: parseIntStrict(
        optional(env, "RATE_LIMIT_PUBLIC_SHARE_RPS_PER_IP", "50"),
        "RATE_LIMIT_PUBLIC_SHARE_RPS_PER_IP",
      ),
      mfaVerifyPerMinute: parseIntStrict(
        optional(env, "RATE_LIMIT_MFA_VERIFY_PER_MINUTE", "8"),
        "RATE_LIMIT_MFA_VERIFY_PER_MINUTE",
      ),
      maxKeys: parseIntStrict(
        optional(env, "RATE_LIMIT_MAX_KEYS", "10000"),
        "RATE_LIMIT_MAX_KEYS",
      ),
    },

    logLevel: logLevelRaw as AppConfig["logLevel"],
    trustProxy: parseBool(optional(env, "TRUST_PROXY", "false"), "TRUST_PROXY"),
  };

  // Cross-field security invariants.
  if (config.google.workspaceDomain === "" && config.google.allowedEmails.length === 0) {
    throw new ConfigError(
      "Set GOOGLE_WORKSPACE_DOMAIN and/or ALLOWED_EMAILS so at least one login path is configured",
    );
  }
  if (config.isProduction && config.s3RequireTls === false) {
    throw new ConfigError("S3_REQUIRE_TLS must be true in production");
  }
  if (config.isProduction && config.appOrigin.startsWith("http://")) {
    throw new ConfigError("APP_ORIGIN must use https in production");
  }
  if (config.minMultipartPartBytes <= 0) {
    throw new ConfigError("MIN_MULTIPART_PART_BYTES must be > 0");
  }
  if (config.maxParts <= 0 || config.maxParts > 10000) {
    throw new ConfigError("MAX_PARTS must be between 1 and 10000");
  }
  for (const [key, value] of [
    ["MAX_USER_UPLOADS", config.maxUserUploads],
    ["MAX_USER_DOWNLOADS", config.maxUserDownloads],
    ["MAX_USER_DRIVE_REQUESTS", config.maxUserDriveRequests],
    ["DRIVE_RETRY_MAX_ATTEMPTS", config.driveRetryMaxAttempts],
    ["CLEANUP_BATCH_SIZE", config.cleanupBatchSize],
    ["CLEANUP_INTERVAL_MS", config.cleanupIntervalMs],
    ["STAGING_STALE_AFTER_MS", config.stagingStaleAfterMs],
    ["RECONCILE_BATCH_SIZE", config.reconcileBatchSize],
    ["DRIVE_IMPORT_PAGE_SIZE", config.driveImportPageSize],
    ["DRIVE_IMPORT_BATCH_SIZE", config.driveImportBatchSize],
    ["DRIVE_IMPORT_INTERVAL_MS", config.driveImportIntervalMs],
    ["MULTIPART_EXPIRY_BATCH_SIZE", config.multipartExpiryBatchSize],
  ] as const) {
    if (value <= 0) throw new ConfigError(`${key} must be > 0`);
  }
  if (config.driveImportPageSize > 1000) {
    throw new ConfigError("DRIVE_IMPORT_PAGE_SIZE must be <= 1000");
  }
  if (config.driveUploadChunkBytes % (256 * 1024) !== 0) {
    throw new ConfigError("DRIVE_UPLOAD_CHUNK_BYTES must be a multiple of 262144 bytes");
  }
  if (config.presignedMinExpiresSeconds < 1) {
    throw new ConfigError("PRESIGNED_MIN_EXPIRES_SECONDS must be >= 1");
  }
  if (config.presignedMaxExpiresSeconds > 7 * 24 * 60 * 60) {
    throw new ConfigError("PRESIGNED_MAX_EXPIRES_SECONDS must be <= 604800 (7 days)");
  }
  if (config.presignedMinExpiresSeconds > config.presignedMaxExpiresSeconds) {
    throw new ConfigError("PRESIGNED_MIN_EXPIRES_SECONDS must be <= PRESIGNED_MAX_EXPIRES_SECONDS");
  }
  if (config.maxControlJsonBytes < 1024) {
    throw new ConfigError("MAX_CONTROL_JSON_BYTES must be >= 1024");
  }
  if (config.maxS3XmlBytes < 4096) {
    throw new ConfigError("MAX_S3_XML_BYTES must be >= 4096");
  }
  for (const [key, value] of [
    ["RATE_LIMIT_LOGIN_PER_MINUTE", config.rateLimit.loginPerMinute],
    ["RATE_LIMIT_CREDENTIAL_CREATE_PER_HOUR", config.rateLimit.credentialCreatePerHour],
    ["RATE_LIMIT_SIGNATURE_FAILURES_PER_MINUTE", config.rateLimit.signatureFailuresPerMinute],
    ["RATE_LIMIT_S3_PUBLIC_RPS_PER_IP", config.rateLimit.s3PublicRpsPerIp],
    ["RATE_LIMIT_S3_ANONYMOUS_RPS_PER_IP", config.rateLimit.s3AnonymousRpsPerIp],
    ["RATE_LIMIT_PUBLIC_SHARE_RPS_PER_IP", config.rateLimit.publicShareRpsPerIp],
    ["RATE_LIMIT_MFA_VERIFY_PER_MINUTE", config.rateLimit.mfaVerifyPerMinute],
    ["RATE_LIMIT_MAX_KEYS", config.rateLimit.maxKeys],
  ] as const) {
    if (value <= 0) throw new ConfigError(`${key} must be > 0`);
  }

  return config;
}

export { ConfigError };
