import { describe, expect, test } from "bun:test";
import { FaultInjectingDriveStorage } from "../../apps/server/src/drive/fault-injection.ts";
import { InMemoryDriveStorage } from "../../apps/server/src/drive/in-memory-storage.ts";
import { DriveError } from "../../apps/server/src/drive/errors.ts";
import { driveErrorToS3Error } from "../../apps/server/src/s3/errors.ts";

const baseInput = {
  userId: "u",
  parentFolderId: "root",
  bucketId: "b",
  bucketName: "bucket",
};

describe("FaultInjectingDriveStorage", () => {
  test("fails the configured window then heals", async () => {
    const storage = new FaultInjectingDriveStorage(new InMemoryDriveStorage(), {
      createBucketFolder: { kind: "rate_limit_429", after: 1, count: 2 },
    });
    await expect(storage.createBucketFolder(baseInput)).resolves.toStartWith("folder_");
    await expect(storage.createBucketFolder(baseInput)).rejects.toMatchObject({
      category: "rate_limit",
      retryable: true,
      status: 429,
    });
    await expect(storage.createBucketFolder(baseInput)).rejects.toBeInstanceOf(DriveError);
    await expect(storage.createBucketFolder(baseInput)).resolves.toStartWith("folder_");
  });

  test("isolates counters per operation", async () => {
    const storage = new FaultInjectingDriveStorage(new InMemoryDriveStorage(), {
      ensureUserRoot: { kind: "server_500" },
      createBucketFolder: { kind: "quota_403" },
    });
    await expect(storage.ensureUserRoot({ userId: "u" })).rejects.toMatchObject({
      category: "server_error",
    });
    await expect(storage.createBucketFolder(baseInput)).rejects.toMatchObject({
      category: "quota_exceeded",
    });
  });
});

describe("driveErrorToS3Error", () => {
  const error = (category: ConstructorParameters<typeof DriveError>[0]["category"]) =>
    new DriveError({ status: 500, category, message: category });

  test("maps quota/rate/network/token failures to stable S3 codes", () => {
    expect(driveErrorToS3Error(error("quota_exceeded")).code).toBe("ServiceUnavailable");
    expect(driveErrorToS3Error(error("rate_limit")).code).toBe("SlowDown");
    expect(driveErrorToS3Error(error("network")).code).toBe("ServiceUnavailable");
    expect(driveErrorToS3Error(error("unauthorized")).code).toBe("AccessDenied");
  });

  test("maps missing Drive media to NoSuchKey", () => {
    expect(driveErrorToS3Error(error("not_found")).code).toBe("NoSuchKey");
  });
});
