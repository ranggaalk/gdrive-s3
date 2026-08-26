import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { makeHarness, type Harness } from "./_helpers.ts";

const contexts: AppContext[] = [];
afterEach(() => {
  while (contexts.length) contexts.pop()!.db.close();
});

async function badSignatureRequest(h: Harness, cred: { accessKeyId: string }): Promise<Response> {
  // Real access key + wrong secret so SigV4 rejects with SignatureDoesNotMatch.
  return h.signAndSend({
    method: "GET",
    path: "/",
    accessKeyId: cred.accessKeyId,
    secretAccessKey: "wrongsecret",
  });
}

describe("rate limiting", () => {
  test("throttles bad signatures with SlowDown once the bucket empties", async () => {
    const h = makeHarness({
      rateLimit: {
        enabled: true,
        loginPerMinute: 100_000,
        credentialCreatePerHour: 100_000,
        signatureFailuresPerMinute: 2,
        s3PublicRpsPerIp: 100_000,
        publicShareRpsPerIp: 100_000,
        mfaVerifyPerMinute: 100_000,
        maxKeys: 10,
      },
    });
    contexts.push(h.ctx);
    const user = h.seedUser("rl@x.com");
    const cred = h.seedCredential(user.id);

    const first = await badSignatureRequest(h, cred);
    expect(first.status).toBe(403);
    expect(await first.text()).toContain("SignatureDoesNotMatch");

    const second = await badSignatureRequest(h, cred);
    expect(second.status).toBe(403);

    const throttled = await badSignatureRequest(h, cred);
    expect(throttled.status).toBe(503);
    expect(await throttled.text()).toContain("SlowDown");
    expect(throttled.headers.get("retry-after")).toBeTruthy();
  });

  test("throttles unauthenticated flood before hitting the verifier", async () => {
    const h = makeHarness({
      rateLimit: {
        enabled: true,
        loginPerMinute: 100_000,
        credentialCreatePerHour: 100_000,
        signatureFailuresPerMinute: 100_000,
        s3PublicRpsPerIp: 1,
        publicShareRpsPerIp: 100_000,
        mfaVerifyPerMinute: 100_000,
        maxKeys: 10,
      },
    });
    contexts.push(h.ctx);
    const user = h.seedUser("rl2@x.com");
    const cred = h.seedCredential(user.id);

    const first = await badSignatureRequest(h, cred);
    expect(first.status).toBe(403); // still hits the SigV4 verifier

    const flooded = await badSignatureRequest(h, cred);
    expect(flooded.status).toBe(503);
    expect(await flooded.text()).toContain("SlowDown");
  });
});
