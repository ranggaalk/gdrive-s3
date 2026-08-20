import { describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";
import { DriveImportService } from "../../apps/server/src/services/drive-import-service.ts";
import { DriveImportWorker } from "../../apps/server/src/jobs/drive-import.ts";
import { ObjectService } from "../../apps/server/src/services/object-service.ts";

async function drain(worker: DriveImportWorker, max = 30): Promise<void> {
  for (let i = 0; i < max; i++) {
    const result = await worker.runOnce();
    if (!result.processed) return;
  }
  throw new Error("import worker did not drain");
}

describe("historical Drive import", () => {
  test("copies nested binary files and reports existing-key conflicts", async () => {
    const { ctx, storage, seedUser } = makeHarness({ driveImportPageSize: 1, driveImportBatchSize: 1 });
    const user = seedUser("owner@x.com");
    const bucket = await ctx.bucketService.create(user.id, "archive");
    const accessible = ctx.bucketAccess.findById(user.id, bucket.id, "owner")!;

    const sourceRoot = storage.seedSource({ name: "Existing", mimeType: "application/vnd.google-apps.folder" });
    const reports = storage.seedSource({
      parentId: sourceRoot,
      name: "reports",
      mimeType: "application/vnd.google-apps.folder",
    });
    storage.seedSource({ parentId: reports, name: "2026.pdf", bytes: new TextEncoder().encode("pdf") });
    storage.seedSource({ parentId: sourceRoot, name: "existing.txt", bytes: new TextEncoder().encode("source") });

    await new ObjectService(ctx).upload({
      actorUserId: user.id,
      bucket: accessible,
      key: "existing.txt",
      requestId: "seed-existing",
      body: new Blob(["destination"]).stream(),
      contentLength: 11,
      metadata: {
        contentType: "text/plain",
        userMetadata: {},
        cacheControl: null,
        contentDisposition: null,
        contentEncoding: null,
        contentLanguage: null,
        expiresAt: null,
      },
    });

    const job = await new DriveImportService(ctx).create({
      userId: user.id,
      bucketId: bucket.id,
      sourceKind: "my_drive",
      sourceFolderId: sourceRoot,
    });
    await drain(new DriveImportWorker(ctx));

    const completed = ctx.repos.driveImports.findOwned(user.id, bucket.id, job.id)!;
    expect(completed.status).toBe("completed");
    expect(completed.imported_count).toBe(1);
    expect(completed.conflict_count).toBe(1);
    expect(ctx.repos.objects.findByKey(bucket.id, "reports/2026.pdf")).not.toBeNull();
    const existing = ctx.repos.objects.findByKey(bucket.id, "existing.txt")!;
    expect(existing.size_bytes).toBe(11);
  });
});
