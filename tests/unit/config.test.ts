import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { loadConfig, ConfigError } from "../../apps/server/src/config.ts";

const key32 = Buffer.alloc(32, 7).toString("base64");

function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: "development",
    GOOGLE_WORKSPACE_DOMAIN: "example.com",
    GOOGLE_CLIENT_ID: "cid",
    GOOGLE_CLIENT_SECRET: "csecret",
    GOOGLE_REDIRECT_URI: "http://localhost:3000/auth/google/callback",
    MASTER_ENCRYPTION_KEY: key32,
    SESSION_SECRET: key32,
    ...overrides,
  } as Record<string, string | undefined>;
}

describe("loadConfig", () => {
  test("loads valid config with defaults", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.serverPort).toBe(3000);
    expect(cfg.s3PublicEndpoint).toBe("http://localhost:3000");
    expect(cfg.s3Region).toBe("us-east-1");
    expect(cfg.google.driveScope).toBe("https://www.googleapis.com/auth/drive");
    expect(cfg.masterEncryptionKey.length).toBe(32);
    expect(cfg.s3DeleteMode).toBe("trash");
    expect(cfg.isProduction).toBe(false);
  });

  test("preserves configured S3 endpoint and region", () => {
    const cfg = loadConfig(baseEnv({
      S3_PUBLIC_ENDPOINT: "https://storage.example.test/",
      S3_REGION: "ap-southeast-3",
    }));
    expect(cfg.s3PublicEndpoint).toBe("https://storage.example.test");
    expect(cfg.s3Region).toBe("ap-southeast-3");
  });

  test("rejects S3 endpoints with query or credentials", () => {
    expect(() => loadConfig(baseEnv({ S3_PUBLIC_ENDPOINT: "https://x.test/?secret=x" }))).toThrow(ConfigError);
    expect(() => loadConfig(baseEnv({ S3_PUBLIC_ENDPOINT: "https://user@x.test" }))).toThrow(ConfigError);
    expect(() => loadConfig(baseEnv({ S3_PUBLIC_ENDPOINT: "https://x.test/prefix" }))).toThrow(ConfigError);
    expect(() => loadConfig(baseEnv({ S3_PUBLIC_ENDPOINT: "ftp://x.test" }))).toThrow(ConfigError);
  });

  test("rejects missing required var", () => {
    expect(() => loadConfig(baseEnv({ GOOGLE_CLIENT_ID: undefined }))).toThrow(ConfigError);
  });

  test("allows ALLOWED_EMAILS to substitute for GOOGLE_WORKSPACE_DOMAIN", () => {
    const cfg = loadConfig(
      baseEnv({ GOOGLE_WORKSPACE_DOMAIN: undefined, ALLOWED_EMAILS: "User@Example.com, a@b.com" }),
    );
    expect(cfg.google.workspaceDomain).toBe("");
    expect(cfg.google.allowedEmails).toEqual(["user@example.com", "a@b.com"]);
  });

  test("rejects config with neither GOOGLE_WORKSPACE_DOMAIN nor ALLOWED_EMAILS", () => {
    expect(() => loadConfig(baseEnv({ GOOGLE_WORKSPACE_DOMAIN: undefined }))).toThrow(ConfigError);
  });

  test("rejects master key that is not 32 bytes", () => {
    const short = Buffer.alloc(16, 1).toString("base64");
    expect(() => loadConfig(baseEnv({ MASTER_ENCRYPTION_KEY: short }))).toThrow(ConfigError);
  });

  test("rejects session secret shorter than 32 bytes", () => {
    const short = Buffer.alloc(16, 1).toString("base64");
    expect(() => loadConfig(baseEnv({ SESSION_SECRET: short }))).toThrow(ConfigError);
  });

  test("requires TLS in production", () => {
    expect(() =>
      loadConfig(
        baseEnv({
          NODE_ENV: "production",
          APP_ORIGIN: "https://app.example.com",
          S3_REQUIRE_TLS: "false",
        }),
      ),
    ).toThrow(ConfigError);
  });

  test("rejects http APP_ORIGIN in production", () => {
    expect(() =>
      loadConfig(
        baseEnv({
          NODE_ENV: "production",
          S3_REQUIRE_TLS: "true",
          APP_ORIGIN: "http://app.example.com",
        }),
      ),
    ).toThrow(ConfigError);
  });

  test("rejects invalid boolean", () => {
    expect(() => loadConfig(baseEnv({ TRUST_PROXY: "yes" }))).toThrow(ConfigError);
  });

  test("loads Milestone 7 hardening defaults", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.maxControlJsonBytes).toBe(65_536);
    expect(cfg.maxS3XmlBytes).toBe(1_048_576);
    expect(cfg.serveDashboard).toBe(true);
    expect(cfg.staticRoot).toBe("./dist/web");
    expect(cfg.rateLimit).toEqual({
      enabled: true,
      loginPerMinute: 10,
      credentialCreatePerHour: 20,
      signatureFailuresPerMinute: 30,
      s3AnonymousRpsPerIp: 50,
      s3PublicRpsPerIp: 200,
      publicShareRpsPerIp: 50,
      mfaVerifyPerMinute: 8,
      maxKeys: 10_000,
    });
  });

  test("rejects unsafe body limits", () => {
    expect(() => loadConfig(baseEnv({ MAX_CONTROL_JSON_BYTES: "1023" }))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(baseEnv({ MAX_S3_XML_BYTES: "4095" }))).toThrow(ConfigError);
  });

  test("rejects disabled-capacity rate limit", () => {
    expect(() =>
      loadConfig(baseEnv({ RATE_LIMIT_SIGNATURE_FAILURES_PER_MINUTE: "0" })),
    ).toThrow(ConfigError);
    expect(() => loadConfig(baseEnv({ RATE_LIMIT_MAX_KEYS: "0" }))).toThrow(ConfigError);
  });

  test("defaults S3_VIRTUAL_HOSTED_DOMAIN to disabled", () => {
    expect(loadConfig(baseEnv()).s3VirtualHostedDomain).toBe("");
  });

  test("lowercases a valid S3_VIRTUAL_HOSTED_DOMAIN", () => {
    const cfg = loadConfig(baseEnv({ S3_VIRTUAL_HOSTED_DOMAIN: "Storage.Example.Com" }));
    expect(cfg.s3VirtualHostedDomain).toBe("storage.example.com");
  });

  test("rejects an S3_VIRTUAL_HOSTED_DOMAIN with a scheme, path, or port", () => {
    expect(() =>
      loadConfig(baseEnv({ S3_VIRTUAL_HOSTED_DOMAIN: "https://storage.example.com" })),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(baseEnv({ S3_VIRTUAL_HOSTED_DOMAIN: "storage.example.com/prefix" })),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig(baseEnv({ S3_VIRTUAL_HOSTED_DOMAIN: "storage.example.com:8787" })),
    ).toThrow(ConfigError);
  });
});

describe("drive quota config", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyJson = JSON.stringify({
    type: "service_account",
    project_id: "quota-project",
    client_email: "quota@quota-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });

  test("is disabled by default", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.driveQuota.serviceAccount).toBeNull();
    expect(cfg.driveQuota.projectId).toBe("");
    expect(cfg.driveQuota.cacheSeconds).toBe(60);
  });

  test("takes the project id from the key file when not given one", () => {
    const cfg = loadConfig(baseEnv({ GOOGLE_QUOTA_SERVICE_ACCOUNT_JSON: keyJson }));
    expect(cfg.driveQuota.projectId).toBe("quota-project");
    expect(cfg.driveQuota.serviceAccount?.clientEmail).toBe(
      "quota@quota-project.iam.gserviceaccount.com",
    );
  });

  test("an explicit project id wins, so quota can live in another project", () => {
    const cfg = loadConfig(
      baseEnv({ GOOGLE_QUOTA_SERVICE_ACCOUNT_JSON: keyJson, GOOGLE_QUOTA_PROJECT_ID: "other" }),
    );
    expect(cfg.driveQuota.projectId).toBe("other");
  });

  test("accepts the key base64-encoded", () => {
    const cfg = loadConfig(
      baseEnv({ GOOGLE_QUOTA_SERVICE_ACCOUNT_JSON: Buffer.from(keyJson).toString("base64") }),
    );
    expect(cfg.driveQuota.serviceAccount).not.toBeNull();
  });

  test("refuses a project id with no credential to read it with", () => {
    expect(() => loadConfig(baseEnv({ GOOGLE_QUOTA_PROJECT_ID: "p" }))).toThrow(ConfigError);
  });

  test("refuses a malformed service account key", () => {
    expect(() => loadConfig(baseEnv({ GOOGLE_QUOTA_SERVICE_ACCOUNT_JSON: "{}" }))).toThrow(
      /Invalid quota service account key/,
    );
  });

  test("refuses both inline and file forms at once", () => {
    expect(() =>
      loadConfig(
        baseEnv({
          GOOGLE_QUOTA_SERVICE_ACCOUNT_JSON: keyJson,
          GOOGLE_QUOTA_SERVICE_ACCOUNT_FILE: "/tmp/key.json",
        }),
      ),
    ).toThrow(ConfigError);
  });

  test("refuses a cache window too short to be worth polling", () => {
    expect(() =>
      loadConfig(baseEnv({ GOOGLE_QUOTA_SERVICE_ACCOUNT_JSON: keyJson, GOOGLE_QUOTA_CACHE_SECONDS: "5" })),
    ).toThrow(/GOOGLE_QUOTA_CACHE_SECONDS/);
  });

  test("reports an unreadable key file instead of booting without quota", () => {
    expect(() =>
      loadConfig(baseEnv({ GOOGLE_QUOTA_SERVICE_ACCOUNT_FILE: "/nonexistent/key.json" })),
    ).toThrow(/could not be read/);
  });
});
