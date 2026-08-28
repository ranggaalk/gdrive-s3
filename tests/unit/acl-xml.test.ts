import { describe, expect, test } from "bun:test";
import {
  ALL_USERS_URI,
  AUTHENTICATED_USERS_URI,
  accessControlPolicyXml,
  aclGrantsAuthenticatedRead,
  aclGrantsPublicRead,
  aclGrantsPublicWrite,
  cannedAclFromXml,
  isBucketAcl,
  isObjectAcl,
} from "../../apps/server/src/s3/acl.ts";
import { S3Error } from "../../apps/server/src/s3/errors.ts";

describe("canned ACL predicates", () => {
  test("recognises the valid bucket and object ACL names", () => {
    for (const acl of ["private", "public-read", "public-read-write", "authenticated-read"]) {
      expect(isBucketAcl(acl)).toBe(true);
      expect(isObjectAcl(acl)).toBe(true);
    }
    // Object-only names are not valid on a bucket.
    expect(isBucketAcl("bucket-owner-read")).toBe(false);
    expect(isObjectAcl("bucket-owner-read")).toBe(true);
    expect(isBucketAcl("nonsense")).toBe(false);
    expect(isObjectAcl("nonsense")).toBe(false);
  });

  test("private grants nothing to the public", () => {
    expect(aclGrantsPublicRead("private")).toBe(false);
    expect(aclGrantsPublicWrite("private")).toBe(false);
    expect(aclGrantsAuthenticatedRead("private")).toBe(false);
  });

  test("public-read grants read but not write", () => {
    expect(aclGrantsPublicRead("public-read")).toBe(true);
    expect(aclGrantsPublicWrite("public-read")).toBe(false);
    // Public implies authenticated.
    expect(aclGrantsAuthenticatedRead("public-read")).toBe(true);
  });

  test("public-read-write grants both", () => {
    expect(aclGrantsPublicRead("public-read-write")).toBe(true);
    expect(aclGrantsPublicWrite("public-read-write")).toBe(true);
  });

  test("authenticated-read excludes anonymous callers", () => {
    expect(aclGrantsPublicRead("authenticated-read")).toBe(false);
    expect(aclGrantsPublicWrite("authenticated-read")).toBe(false);
    expect(aclGrantsAuthenticatedRead("authenticated-read")).toBe(true);
  });
});

describe("AccessControlPolicy XML", () => {
  const owner = { ownerId: "usr_1", ownerName: "eric@x.com" };

  test("private renders only the owner's FULL_CONTROL", () => {
    const xml = accessControlPolicyXml({ acl: "private", ...owner });
    expect(xml).toContain("<ID>usr_1</ID>");
    expect(xml).toContain("<Permission>FULL_CONTROL</Permission>");
    expect(xml).not.toContain(ALL_USERS_URI);
    expect(xml).not.toContain(AUTHENTICATED_USERS_URI);
  });

  test("public-read adds an AllUsers READ grant", () => {
    const xml = accessControlPolicyXml({ acl: "public-read", ...owner });
    expect(xml).toContain(ALL_USERS_URI);
    expect(xml).toContain("<Permission>READ</Permission>");
    expect(xml).not.toContain("<Permission>WRITE</Permission>");
  });

  test("public-read-write adds both AllUsers grants", () => {
    const xml = accessControlPolicyXml({ acl: "public-read-write", ...owner });
    expect(xml).toContain("<Permission>READ</Permission>");
    expect(xml).toContain("<Permission>WRITE</Permission>");
  });

  test("authenticated-read targets AuthenticatedUsers, not AllUsers", () => {
    const xml = accessControlPolicyXml({ acl: "authenticated-read", ...owner });
    expect(xml).toContain(AUTHENTICATED_USERS_URI);
    expect(xml).not.toContain(`<URI>${ALL_USERS_URI}</URI>`);
  });

  test("round-trips every canned ACL back to itself", () => {
    for (const acl of ["private", "public-read", "public-read-write", "authenticated-read"] as const) {
      expect(cannedAclFromXml(accessControlPolicyXml({ acl, ...owner }))).toBe(acl);
    }
  });
});

describe("parsing an AccessControlPolicy body", () => {
  function body(grants: string): string {
    return `<AccessControlPolicy><Owner><ID>usr_1</ID></Owner><AccessControlList>${grants}</AccessControlList></AccessControlPolicy>`;
  }
  const groupGrant = (uri: string, permission: string) =>
    `<Grant><Grantee xsi:type="Group"><URI>${uri}</URI></Grantee><Permission>${permission}</Permission></Grant>`;

  test("reads a public READ grant as public-read", () => {
    expect(cannedAclFromXml(body(groupGrant(ALL_USERS_URI, "READ")))).toBe("public-read");
  });

  test("reads a public WRITE grant as public-read-write", () => {
    expect(cannedAclFromXml(body(groupGrant(ALL_USERS_URI, "WRITE")))).toBe("public-read-write");
  });

  test("treats AllUsers FULL_CONTROL as public-read-write", () => {
    expect(cannedAclFromXml(body(groupGrant(ALL_USERS_URI, "FULL_CONTROL")))).toBe("public-read-write");
  });

  test("reads an authenticated READ grant as authenticated-read", () => {
    expect(cannedAclFromXml(body(groupGrant(AUTHENTICATED_USERS_URI, "READ")))).toBe("authenticated-read");
  });

  test("an owner-only grant list is private", () => {
    const ownerOnly = `<Grant><Grantee xsi:type="CanonicalUser"><ID>usr_1</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant>`;
    expect(cannedAclFromXml(body(ownerOnly))).toBe("private");
  });

  test("public wins over authenticated when both are granted", () => {
    const both = groupGrant(ALL_USERS_URI, "READ") + groupGrant(AUTHENTICATED_USERS_URI, "READ");
    expect(cannedAclFromXml(body(both))).toBe("public-read");
  });

  test("rejects a body with no grants", () => {
    expect(() => cannedAclFromXml(body(""))).toThrow(S3Error);
  });

  test("rejects an unsupported grantee URI rather than approximating it", () => {
    expect(() => cannedAclFromXml(body(groupGrant("http://example.com/group/Other", "READ")))).toThrow(S3Error);
  });

  test("rejects a per-user grant that is not the owner's FULL_CONTROL", () => {
    const userRead = `<Grant><Grantee xsi:type="CanonicalUser"><ID>usr_2</ID></Grantee><Permission>READ</Permission></Grant>`;
    expect(() => cannedAclFromXml(body(userRead))).toThrow(S3Error);
  });

  test("rejects a grant with no permission", () => {
    const noPermission = `<Grant><Grantee xsi:type="Group"><URI>${ALL_USERS_URI}</URI></Grantee></Grant>`;
    expect(() => cannedAclFromXml(body(noPermission))).toThrow(S3Error);
  });
});
