import { describe, expect, test } from "bun:test";
import { ChunkReader } from "../../apps/server/src/backup/chunk-reader.ts";
import {
  DestinationInputError,
  parseRcloneInput,
  parseS3Input,
} from "../../apps/server/src/backup/destination-config.ts";
import {
  assertPublicEndpoint,
  isPrivateAddress,
  PrivateEndpointError,
} from "../../apps/server/src/backup/endpoint-guard.ts";
import {
  partSizeFor,
  S3Client,
  S3RequestError,
  uploadStream,
} from "../../apps/server/src/backup/s3-client.ts";

const MIB = 1024 * 1024;

const settings = {
  s3PartSizeBytes: 16 * MIB,
  s3AllowPrivateEndpoints: false,
  rcloneBinary: "rclone",
  rcloneConfigPath: "",
  rcloneRemotes: ["nas"],
};

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

describe("isPrivateAddress", () => {
  test.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1%eth0",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:0.0.0.0",
    "not-an-ip",
  ])("%s is private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])(
    "%s is public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe("assertPublicEndpoint", () => {
  test("refuses a name that resolves to any private address", async () => {
    const lookup = async () => ["93.184.216.34", "10.0.0.5"];
    await expect(assertPublicEndpoint("https://sneaky.example", lookup)).rejects.toBeInstanceOf(
      PrivateEndpointError,
    );
  });

  test("accepts a name that resolves only to public addresses", async () => {
    await assertPublicEndpoint("https://s3.example", async () => ["93.184.216.34"]);
  });

  test("checks an IP literal without a lookup", async () => {
    const lookup = async () => {
      throw new Error("should not be called");
    };
    await expect(assertPublicEndpoint("https://[fd00::1]:9000", lookup)).rejects.toBeInstanceOf(
      PrivateEndpointError,
    );
  });
});

describe("parseS3Input", () => {
  const base = {
    endpoint: "https://s3.eu-west-1.amazonaws.com/",
    bucket: "my-backups",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
  };

  test("normalizes the endpoint and prefix and derives a label", () => {
    const parsed = parseS3Input({ ...base, prefix: "/nightly/gateway/", region: "EU-WEST-1" }, settings);
    expect(parsed.config).toEqual({
      endpoint: "https://s3.eu-west-1.amazonaws.com",
      region: "eu-west-1",
      bucket: "my-backups",
      prefix: "nightly/gateway",
      forcePathStyle: false,
      accessKeyId: "AKIAEXAMPLE",
      storageClass: null,
    });
    expect(parsed.label).toBe("my-backups/nightly/gateway · s3.eu-west-1.amazonaws.com");
  });

  test.each([
    [{ endpoint: "http://s3.example" }, "https"],
    [{ endpoint: "https://user:pw@s3.example" }, "credentials"],
    [{ endpoint: "https://s3.example?x=1" }, "without a path"],
    [{ prefix: "a/./b" }, "segments"],
    [{ bucket: "UPPER" }, "path-style"],
    [{ region: "us east" }, "region"],
    [{ storageClass: "glacier ir" }, "storageClass"],
    [{ accessKeyId: "has space" }, "accessKeyId"],
    [{ bucket: undefined }, "bucket is required"],
  ])("refuses %j", (override, message) => {
    expect(() => parseS3Input({ ...base, ...override }, settings)).toThrow(message);
  });

  test("plain http is accepted once private endpoints are allowed", () => {
    const parsed = parseS3Input(
      { ...base, endpoint: "http://minio.lan:9000", forcePathStyle: true, bucket: "Legacy_Bucket" },
      { ...settings, s3AllowPrivateEndpoints: true },
    );
    expect(parsed.config.endpoint).toBe("http://minio.lan:9000");
  });
});

describe("parseRcloneInput", () => {
  test("takes an allowlisted remote and a relative path", () => {
    expect(parseRcloneInput({ remote: "nas", path: "backups/" }, settings)).toEqual({
      config: { remote: "nas", path: "backups" },
      label: "nas:backups",
    });
  });

  test("refuses anything the operator did not offer", () => {
    expect(() => parseRcloneInput({ remote: "local" }, settings)).toThrow(DestinationInputError);
    expect(() => parseRcloneInput({ remote: "nas" }, { ...settings, rcloneRemotes: [] })).toThrow(
      "not enabled",
    );
  });

  test("refuses paths that leave the remote's root", () => {
    expect(() => parseRcloneInput({ remote: "nas", path: "/etc" }, settings)).toThrow("leading");
    expect(() => parseRcloneInput({ remote: "nas", path: "a/../../etc" }, settings)).toThrow("segments");
  });
});

describe("ChunkReader", () => {
  test("cuts fixed-size pieces across the source's own chunk boundaries", async () => {
    const reader = new ChunkReader(streamOf("abc", "defgh", "i", "jklmnop"));
    const pieces: string[] = [];
    for (;;) {
      const piece = await reader.read(4);
      if (piece.byteLength === 0) break;
      pieces.push(new TextDecoder().decode(piece));
    }
    expect(pieces).toEqual(["abcd", "efgh", "ijkl", "mnop"]);
  });

  test("the last piece is short, and reads after the end are empty", async () => {
    const reader = new ChunkReader(streamOf("abcdef"));
    expect(new TextDecoder().decode(await reader.read(4))).toBe("abcd");
    expect(new TextDecoder().decode(await reader.read(4))).toBe("ef");
    expect((await reader.read(4)).byteLength).toBe(0);
  });
});

describe("partSizeFor", () => {
  test("keeps the configured size until an object would need too many parts", () => {
    expect(partSizeFor(10 * MIB, 16 * MIB)).toBe(16 * MIB);
    expect(partSizeFor(1024 * 1024 * MIB, 16 * MIB)).toBe(105 * MIB);
  });
});

describe("S3RequestError", () => {
  test("separates destination faults, object faults and transient ones", () => {
    expect(new S3RequestError(403, "InvalidAccessKeyId", "").destinationLevel).toBe(true);
    expect(new S3RequestError(404, "NoSuchBucket", "").destinationLevel).toBe(true);
    expect(new S3RequestError(301, null, "").destinationLevel).toBe(true);
    expect(new S3RequestError(400, "InvalidDigest", "").destinationLevel).toBe(false);
    expect(new S3RequestError(400, "InvalidDigest", "").retryable).toBe(false);
    expect(new S3RequestError(503, "SlowDown", "").retryable).toBe(true);
    expect(new S3RequestError(400, "RequestTimeout", "").retryable).toBe(true);
  });
});

describe("uploadStream", () => {
  function recordingClient(failPart: number | null) {
    const calls: string[] = [];
    const client = new S3Client({
      endpoint: "https://s3.example",
      region: "us-east-1",
      bucket: "b",
      forcePathStyle: true,
      accessKeyId: "AK",
      secretAccessKey: "SK",
      maxAttempts: 1,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url.pathname}${url.search}`);
        if (method === "POST" && url.searchParams.has("uploads")) {
          return new Response("<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>");
        }
        const partNumber = url.searchParams.get("partNumber");
        if (method === "PUT" && partNumber) {
          if (Number(partNumber) === failPart) {
            return new Response("<Error><Code>InvalidDigest</Code><Message>bad</Message></Error>", { status: 400 });
          }
          return new Response(null, { headers: { etag: `"etag-${partNumber}"` } });
        }
        return new Response(null, { status: method === "DELETE" ? 204 : 200 });
      },
    });
    return { client, calls };
  }

  test("a body that fits in one part is a single PUT", async () => {
    const { client, calls } = recordingClient(null);
    await uploadStream(client, "k", streamOf("tiny"), { partSize: 8, headers: new Headers() });
    expect(calls).toEqual(["PUT /b/k"]);
  });

  test("a failed part aborts the upload so no parts are left behind", async () => {
    const { client, calls } = recordingClient(2);
    await expect(
      uploadStream(client, "k", streamOf("aaaa", "bbbb", "cc"), { partSize: 4, headers: new Headers() }),
    ).rejects.toThrow("InvalidDigest");
    expect(calls).toEqual([
      "POST /b/k?uploads=",
      "PUT /b/k?partNumber=1&uploadId=up-1",
      "PUT /b/k?partNumber=2&uploadId=up-1",
      "DELETE /b/k?uploadId=up-1",
    ]);
  });

  test("a key is sent exactly as signed, with reserved characters escaped", async () => {
    const { client, calls } = recordingClient(null);
    await uploadStream(client, "photos/a b+c*(1).txt", streamOf("x"), { partSize: 8, headers: new Headers() });
    expect(calls).toEqual(["PUT /b/photos/a%20b%2Bc%2A%281%29.txt"]);
  });
});
