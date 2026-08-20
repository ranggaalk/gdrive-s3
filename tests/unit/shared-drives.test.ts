import { describe, expect, test } from "bun:test";
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations } from "../../apps/server/src/db/migrate.ts";
import { UsersRepository } from "../../apps/server/src/db/repositories/users.ts";
import { BucketsRepository } from "../../apps/server/src/db/repositories/buckets.ts";
import { DriveTargetsRepository } from "../../apps/server/src/db/repositories/drive-targets.ts";
import { BucketMembersRepository } from "../../apps/server/src/db/repositories/bucket-members.ts";
import {
  buildAuthUrl,
  hasRequiredScopes,
} from "../../apps/server/src/auth/google-oauth.ts";
import { testConfig } from "../integration/_helpers.ts";

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const users = new UsersRepository(db);
  const buckets = new BucketsRepository(db);
  const targets = new DriveTargetsRepository(db);
  const members = new BucketMembersRepository(db);
  const owner = users.upsertOnLogin({
    googleSub: "owner",
    email: "owner@x.com",
    displayName: "Owner",
    hostedDomain: "x.com",
  });
  const viewer = users.upsertOnLogin({
    googleSub: "viewer",
    email: "viewer@x.com",
    displayName: "Viewer",
    hostedDomain: "x.com",
  });
  return { db, users, buckets, targets, members, owner, viewer };
}

describe("Shared Drive persistence", () => {
  test("new users receive a backward-compatible My Drive target", () => {
    const { db, targets, owner } = setup();
    const target = targets.findMyDrive(owner.id);
    expect(target).not.toBeNull();
    expect(target!.kind).toBe("my_drive");
    const bucket = new BucketsRepository(db).create(
      owner.id,
      "legacy-bucket",
      "us-east-1",
      "folder",
    );
    expect(bucket.drive_target_id).toBe(target!.id);
    db.close();
  });

  test("selected members see a Shared Drive bucket with their role", () => {
    const { db, buckets, targets, members, owner, viewer } = setup();
    const target = targets.createSharedDrive({
      ownerUserId: owner.id,
      sharedDriveId: "drive-finance",
      displayName: "Finance",
      rootFolderId: "root-finance",
    });
    const bucket = buckets.create(
      owner.id,
      "reports",
      "us-east-1",
      "folder-reports",
      target.id,
    );
    members.add({
      bucketId: bucket.id,
      userId: viewer.id,
      role: "viewer",
      createdBy: owner.id,
    });
    expect(buckets.findAccessibleByName(viewer.id, "reports")?.effective_role).toBe("viewer");
    expect(buckets.findAccessibleByName(viewer.id, "reports")?.storage_kind).toBe("shared_drive");
    expect(buckets.findAccessibleByName(viewer.id, "reports")?.storage_display_name).toBe("Finance");
    db.close();
  });

  test("membership cannot be added to My Drive buckets", () => {
    const { db, buckets, members, owner, viewer } = setup();
    const bucket = buckets.create(owner.id, "private", "us-east-1", "folder");
    expect(() =>
      members.add({
        bucketId: bucket.id,
        userId: viewer.id,
        role: "viewer",
        createdBy: owner.id,
      }),
    ).toThrow();
    db.close();
  });
});

describe("OAuth Shared Drive scopes", () => {
  test("auth URL uses configured Drive scopes and detects old grants", () => {
    const config = testConfig({
      google: {
        workspaceDomain: "x.com",
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "http://localhost/callback",
        driveScope: "https://www.googleapis.com/auth/drive",
      },
    });
    const url = new URL(
      buildAuthUrl(config, {
        state: "state",
        pkceChallenge: "challenge",
        promptConsent: true,
      }),
    );
    expect(url.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/drive");
    expect(hasRequiredScopes(config, "openid email profile https://www.googleapis.com/auth/drive.file")).toBe(false);
    expect(hasRequiredScopes(config, "https://www.googleapis.com/auth/drive")).toBe(true);
    expect(
      hasRequiredScopes(
        config,
        "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/drive",
      ),
    ).toBe(true);
  });
});
