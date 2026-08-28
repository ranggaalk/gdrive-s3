import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  buildAssertion,
  fetchServiceAccountToken,
  parseServiceAccountKey,
  QUOTA_PROBE_SCOPE,
  ServiceAccountError,
} from "../../apps/server/src/auth/google-service-account.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function keyJson(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: "service_account",
    project_id: "my-project",
    client_email: "quota@my-project.iam.gserviceaccount.com",
    private_key: PEM,
    ...over,
  });
}

describe("parseServiceAccountKey", () => {
  test("reads a plain JSON key", () => {
    const key = parseServiceAccountKey(keyJson());
    expect(key.clientEmail).toBe("quota@my-project.iam.gserviceaccount.com");
    expect(key.projectId).toBe("my-project");
    expect(key.tokenUri).toBe("https://oauth2.googleapis.com/token");
  });

  test("reads the same key base64-encoded, as an env var would carry it", () => {
    const key = parseServiceAccountKey(Buffer.from(keyJson()).toString("base64"));
    expect(key.clientEmail).toBe("quota@my-project.iam.gserviceaccount.com");
  });

  test("restores newlines escaped by a single-line env var", () => {
    // A key pasted into a .env file arrives with literal backslash-n instead
    // of real line breaks, which no PEM parser accepts.
    const escaped = JSON.stringify({
      type: "service_account",
      project_id: "my-project",
      client_email: "quota@my-project.iam.gserviceaccount.com",
      private_key: PEM.split("\n").join("\\n"),
    });
    const key = parseServiceAccountKey(escaped);
    expect(key.privateKey).toBe(PEM);
  });

  test("rejects a key that is not a service account", () => {
    expect(() => parseServiceAccountKey(keyJson({ type: "authorized_user" }))).toThrow(
      ServiceAccountError,
    );
  });

  test("rejects a key with no private key", () => {
    expect(() => parseServiceAccountKey(keyJson({ private_key: "not-a-pem" }))).toThrow(
      /not a PEM private key/,
    );
  });

  test("rejects an empty or non-JSON value", () => {
    expect(() => parseServiceAccountKey("")).toThrow(ServiceAccountError);
    expect(() => parseServiceAccountKey("{ not json")).toThrow(ServiceAccountError);
  });
});

describe("buildAssertion", () => {
  test("produces a JWT Google's key can verify", () => {
    const key = parseServiceAccountKey(keyJson());
    const jwt = buildAssertion(key, QUOTA_PROBE_SCOPE, 1_700_000_000);
    const [header, claims, signature] = jwt.split(".");

    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const payload = JSON.parse(Buffer.from(claims!, "base64url").toString());
    expect(payload).toMatchObject({
      iss: "quota@my-project.iam.gserviceaccount.com",
      scope: QUOTA_PROBE_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });

    const verified = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKey, Buffer.from(signature!, "base64url"));
    expect(verified).toBe(true);
  });

  test("asks only for read-only cloud access", () => {
    // Both are needed and both are read-only: Cloud Monitoring rejects
    // cloud-platform.read-only, and Service Usage does not take monitoring.read.
    expect(QUOTA_PROBE_SCOPE.split(" ")).toEqual([
      "https://www.googleapis.com/auth/monitoring.read",
      "https://www.googleapis.com/auth/cloud-platform.read-only",
    ]);
    for (const scope of QUOTA_PROBE_SCOPE.split(" ")) {
      expect(scope).toMatch(/(\.read-only|\.read)$/);
    }
  });
});

describe("fetchServiceAccountToken", () => {
  test("exchanges the assertion for an access token", async () => {
    const key = parseServiceAccountKey(keyJson());
    let sentBody = "";
    const token = await fetchServiceAccountToken(
      key,
      QUOTA_PROBE_SCOPE,
      (async (_url: string | URL | Request, init?: RequestInit) => {
        sentBody = (init!.body as URLSearchParams).toString();
        return Response.json({ access_token: "ya29.token", expires_in: 3599 });
      }),
    );

    expect(token.accessToken).toBe("ya29.token");
    expect(token.expiresAtMs).toBeGreaterThan(Date.now());
    expect(sentBody).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
  });

  test("surfaces a rejected exchange without leaking the key", async () => {
    const key = parseServiceAccountKey(keyJson());
    const failing = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));

    const error = await fetchServiceAccountToken(key, QUOTA_PROBE_SCOPE, failing).catch((e) => e);
    expect(error).toBeInstanceOf(ServiceAccountError);
    expect((error as Error).message).toContain("invalid_grant");
    expect((error as Error).message).not.toContain("PRIVATE KEY");
  });
});
