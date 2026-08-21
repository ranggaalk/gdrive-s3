// Integration test harness: builds a fully wired AppContext against an
// in-memory SQLite + in-memory Drive, and gives helpers to seed a user + S3
// credential and to send SigV4-signed requests directly to handleS3.

import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations } from "../../apps/server/src/db/migrate.ts";
import { createLogger } from "../../apps/server/src/observability/logger.ts";
import { createContext, type AppContext } from "../../apps/server/src/context.ts";
import { InMemoryDriveStorage } from "../../apps/server/src/drive/in-memory-storage.ts";
import type { DriveStorage } from "../../apps/server/src/drive/storage.ts";
import type { AppConfig } from "../../apps/server/src/config.ts";
import { handleS3 } from "../../apps/server/src/s3/router.ts";
import {
  buildCanonicalRequest,
  buildStringToSign,
  computeSignature,
  deriveSigningKey,
  sha256Hex,
} from "../../apps/server/src/auth/sigv4-canonical.ts";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: "test",
    isProduction: false,
    appName: "test",
    appOrigin: "http://localhost",
    serverHost: "127.0.0.1",
    serverPort: 0,
    google: {
      workspaceDomain: "x.com",
      clientId: "cid",
      clientSecret: "csecret",
      redirectUri: "http://localhost/cb",
      driveScope: "https://www.googleapis.com/auth/drive",
    },
    masterEncryptionKey: Buffer.alloc(32, 5),
    sessionSecret: Buffer.alloc(32, 6),
    sqlitePath: ":memory:",
    multipartTempDir: "/tmp/mp",
    multipartTtlHours: 24,
    orphanRetentionHours: 24,
    driveResumableThresholdBytes: 5 * 1024 * 1024,
    driveUploadChunkBytes: 8 * 1024 * 1024,
    s3DeleteMode: "permanent",
    s3PublicEndpoint: "http://localhost",
    s3Region: "us-east-1",
    s3RequireTls: false,
    s3VirtualHostedDomain: "",
    maxSinglePutBytes: 100 * 1024 * 1024,
    maxMultipartObjectBytes: 1 * 1024 * 1024 * 1024,
    maxParts: 10000,
    minMultipartPartBytes: 5 * 1024 * 1024,
    maxUserUploads: 4,
    maxUserDownloads: 4,
    maxUserDriveRequests: 8,
    driveRetryMaxAttempts: 5,
    cleanupBatchSize: 32,
    cleanupIntervalMs: 60_000,
    stagingStaleAfterMs: 3600_000,
    reconcileBatchSize: 64,
    driveImportPageSize: 100,
    driveImportBatchSize: 5,
    driveImportIntervalMs: 2000,
    presignedMinExpiresSeconds: 1,
    presignedMaxExpiresSeconds: 604_800,
    multipartExpiryBatchSize: 50,
    maxControlJsonBytes: 65_536,
    maxS3XmlBytes: 1_048_576,
    serveDashboard: false,
    staticRoot: "./dist/web",
    rateLimit: {
      enabled: true,
      loginPerMinute: 100_000,
      credentialCreatePerHour: 100_000,
      signatureFailuresPerMinute: 100_000,
      s3PublicRpsPerIp: 100_000,
      publicShareRpsPerIp: 100_000,
      maxKeys: 10_000,
    },
    logLevel: "error",
    trustProxy: false,
    ...overrides,
  } as AppConfig;
}

export interface Harness {
  ctx: AppContext;
  storage: InMemoryDriveStorage;
  seedUser(email: string): { id: string };
  seedCredential(userId: string): { accessKeyId: string; secretAccessKey: string };
  signAndSend(input: {
    method: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
    accessKeyId: string;
    secretAccessKey: string;
  }): Promise<Response>;
}

export function makeHarness(
  configOverrides: Partial<AppConfig> = {},
  storageOverride?: DriveStorage,
): Harness {
  const config = testConfig(configOverrides);
  const db = openMemoryDatabase();
  runMigrations(db);
  const log = createLogger("error");
  const storage = (storageOverride as InMemoryDriveStorage | undefined) ?? new InMemoryDriveStorage();
  const ctx = createContext(config, db, log, storage);

  const seedUser = (email: string) =>
    ctx.repos.users.upsertOnLogin({
      googleSub: `sub-${email}`,
      email,
      displayName: null,
      hostedDomain: "x.com",
    });

  const seedCredential = (userId: string) => {
    const c = ctx.credentialService.create(userId, "test");
    return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey };
  };

  async function signAndSend(input: {
    method: string;
    path: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Uint8Array | string;
    accessKeyId: string;
    secretAccessKey: string;
  }): Promise<Response> {
    const bodyBytes =
      input.body === undefined
        ? new Uint8Array()
        : typeof input.body === "string"
          ? new TextEncoder().encode(input.body)
          : input.body;
    const payloadHash = sha256Hex(bodyBytes);
    const now = new Date();
    const amzDate =
      now.getUTCFullYear().toString().padStart(4, "0") +
      String(now.getUTCMonth() + 1).padStart(2, "0") +
      String(now.getUTCDate()).padStart(2, "0") +
      "T" +
      String(now.getUTCHours()).padStart(2, "0") +
      String(now.getUTCMinutes()).padStart(2, "0") +
      String(now.getUTCSeconds()).padStart(2, "0") +
      "Z";
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${config.s3Region}/s3/aws4_request`;

    const url = new URL(`http://localhost${input.path}`);
    for (const [k, v] of Object.entries(input.query ?? {})) url.searchParams.set(k, v);

    const headers = new Headers({
      host: "localhost",
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      ...(input.headers ?? {}),
    });

    const signedHeaderNames = ["host", "x-amz-content-sha256", "x-amz-date"];
    for (const name of Object.keys(input.headers ?? {})) {
      const lower = name.toLowerCase();
      if (
        (lower === "content-type" || lower.startsWith("x-amz-")) &&
        !signedHeaderNames.includes(lower)
      ) {
        signedHeaderNames.push(lower);
      }
    }
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
      method: input.method,
      path: url.pathname,
      query: url.searchParams,
      headers,
      signedHeaderNames,
      payloadHash,
    });
    const sts = buildStringToSign({ amzDate, scope, canonicalRequest });
    const key = deriveSigningKey(input.secretAccessKey, dateStamp, config.s3Region, "s3");
    const signature = computeSignature(key, sts);
    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope},SignedHeaders=${signedHeaders},Signature=${signature}`,
    );

    const req = new Request(url.toString(), {
      method: input.method,
      headers,
      body: input.method === "GET" || input.method === "HEAD" ? undefined : bodyBytes,
    });
    return handleS3(ctx, req, `req_${crypto.randomUUID()}`);
  }

  return { ctx, storage, seedUser, seedCredential, signAndSend };
}
