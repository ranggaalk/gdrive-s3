import { describe, expect, test } from "bun:test";
import {
  COMPAT_MATRIX,
  compatMatrix,
  type CompatSource,
} from "../../apps/server/src/compat/matrix.ts";

const ALLOWED_SOURCES = new Set<CompatSource>(["aws-sdk", "aws-cli", "rclone", "mc", "unit"]);

describe("S3 compatibility matrix", () => {
  test("has no duplicate feature labels", () => {
    const labels = COMPAT_MATRIX.map((row) => row.feature);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("requires evidence for every supported claim", () => {
    const unsupportedClaims = COMPAT_MATRIX.filter(
      (row) => row.status === "supported" && (!row.verifiedBy || row.verifiedBy.length === 0),
    );
    expect(unsupportedClaims).toEqual([]);
  });

  test("does not attach verifiedBy to untested or unsupported rows", () => {
    const dishonest = COMPAT_MATRIX.filter(
      (row) => row.status !== "supported" && row.verifiedBy && row.verifiedBy.length > 0,
    );
    expect(dishonest).toEqual([]);
  });

  test("uses only known verification sources", () => {
    const unknown = COMPAT_MATRIX.flatMap((row) => row.verifiedBy ?? []).filter(
      (source) => !ALLOWED_SOURCES.has(source),
    );
    expect(unknown).toEqual([]);
  });

  test("returns a mutable copy rather than exposing source rows", () => {
    const first = compatMatrix();
    const second = compatMatrix();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(COMPAT_MATRIX[0]);
  });

  test("records passing external-client compatibility smokes", () => {
    const byFeature = new Map(COMPAT_MATRIX.map((row) => [row.feature, row]));
    expect(byFeature.get("AWS CLI compatibility smoke")).toMatchObject({
      status: "supported",
      verifiedBy: ["aws-cli"],
    });
    expect(byFeature.get("rclone compatibility smoke")).toMatchObject({
      status: "supported",
      verifiedBy: ["rclone"],
    });
    expect(byFeature.get("MinIO mc compatibility smoke")).toMatchObject({
      status: "supported",
      verifiedBy: ["mc"],
    });
  });

  test("keeps explicitly out-of-scope S3 features unsupported", () => {
    const byFeature = new Map(COMPAT_MATRIX.map((row) => [row.feature, row.status]));
    expect(byFeature.get("Object Lock / Legal Hold")).toBe("unsupported");

  });

  test("virtual-hosted style bucket endpoint is supported with unit evidence", () => {
    const byFeature = new Map(COMPAT_MATRIX.map((row) => [row.feature, row]));
    expect(byFeature.get("Virtual-hosted style bucket endpoint")).toMatchObject({
      status: "supported",
      verifiedBy: ["unit"],
    });
  });

  test("ACL and bucket policy are supported with unit evidence", () => {
    const byFeature = new Map(COMPAT_MATRIX.map((row) => [row.feature, row]));
    expect(byFeature.get("ACL & Bucket Policy")).toMatchObject({
      status: "supported",
      verifiedBy: ["unit"],
    });
  });

  test("object versioning is supported with unit evidence", () => {
    const byFeature = new Map(COMPAT_MATRIX.map((row) => [row.feature, row]));
    expect(byFeature.get("Object versioning")).toMatchObject({
      status: "supported",
      verifiedBy: ["unit"],
    });
  });

  test("server-side encryption is supported with unit evidence", () => {
    const byFeature = new Map(COMPAT_MATRIX.map((row) => [row.feature, row]));
    expect(byFeature.get("SSE-KMS / Server-side encryption")).toMatchObject({
      status: "supported",
      verifiedBy: ["unit"],
    });
  });

  test("SigV4A and PresignedPost are tracked as separate supported rows", () => {
    const byFeature = new Map(COMPAT_MATRIX.map((row) => [row.feature, row]));
    expect(byFeature.get("SigV4A (AWS4-ECDSA-P256-SHA256)")).toMatchObject({
      status: "supported",
      verifiedBy: ["unit"],
    });
    expect(byFeature.get("PresignedPost (browser form POST)")).toMatchObject({
      status: "supported",
      verifiedBy: ["unit"],
    });
    // The combined row they replaced must not linger.
    expect(byFeature.has("SigV4A / PresignedPost (form)")).toBe(false);
  });
});
