// S3 canned ACLs and the AccessControlPolicy XML around them.
//
// This gateway stores the canned ACL name rather than a grant list. Real S3
// lets you build arbitrary grantee/permission pairs, but every grantee here is
// either a DriveS3 user (already modelled by bucket_members) or the anonymous
// public, so the canned names cover the whole space this system can express.
// GET ?acl therefore renders the canned ACL back out as grants, and PUT ?acl
// accepts either the header or an XML body that matches one of them.
//
// Kept free of I/O so it can be unit-tested on its own.

import { S3Error } from "./errors.ts";
import { tag, xmlDocument } from "./xml.ts";

export const BUCKET_ACLS = [
  "private",
  "public-read",
  "public-read-write",
  "authenticated-read",
] as const;

export const OBJECT_ACLS = [
  ...BUCKET_ACLS,
  "bucket-owner-read",
  "bucket-owner-full-control",
] as const;

export type BucketAcl = (typeof BUCKET_ACLS)[number];
export type ObjectAcl = (typeof OBJECT_ACLS)[number];

/** The URI S3 uses for "anyone, authenticated or not". */
export const ALL_USERS_URI = "http://acs.amazonaws.com/groups/global/AllUsers";
/** "Any AWS account" — here, any authenticated DriveS3 user. */
export const AUTHENTICATED_USERS_URI =
  "http://acs.amazonaws.com/groups/global/AuthenticatedUsers";

export function isBucketAcl(value: string): value is BucketAcl {
  return (BUCKET_ACLS as readonly string[]).includes(value);
}

export function isObjectAcl(value: string): value is ObjectAcl {
  return (OBJECT_ACLS as readonly string[]).includes(value);
}

/** Does this ACL let an anonymous caller read? */
export function aclGrantsPublicRead(acl: string): boolean {
  return acl === "public-read" || acl === "public-read-write";
}

/** Does this ACL let an anonymous caller write? */
export function aclGrantsPublicWrite(acl: string): boolean {
  return acl === "public-read-write";
}

/** Does this ACL let any *authenticated* user read? */
export function aclGrantsAuthenticatedRead(acl: string): boolean {
  return acl === "authenticated-read" || aclGrantsPublicRead(acl);
}

interface Grant {
  granteeXml: string;
  permission: string;
}

function groupGrant(uri: string, permission: string): Grant {
  return {
    granteeXml:
      `<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group">` +
      `${tag("URI", uri)}</Grantee>`,
    permission,
  };
}

function ownerGrant(ownerId: string, ownerName: string, permission: string): Grant {
  return {
    granteeXml:
      `<Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser">` +
      `${tag("ID", ownerId)}${tag("DisplayName", ownerName)}</Grantee>`,
    permission,
  };
}

/** Expand a canned ACL into the grant list S3 would report for it. */
export function grantsForAcl(acl: string, ownerId: string, ownerName: string): Grant[] {
  // The owner always keeps full control; canned ACLs only add to that.
  const grants: Grant[] = [ownerGrant(ownerId, ownerName, "FULL_CONTROL")];
  if (aclGrantsPublicRead(acl)) grants.push(groupGrant(ALL_USERS_URI, "READ"));
  if (aclGrantsPublicWrite(acl)) grants.push(groupGrant(ALL_USERS_URI, "WRITE"));
  if (acl === "authenticated-read") {
    grants.push(groupGrant(AUTHENTICATED_USERS_URI, "READ"));
  }
  return grants;
}

export function accessControlPolicyXml(input: {
  acl: string;
  ownerId: string;
  ownerName: string;
}): string {
  const grants = grantsForAcl(input.acl, input.ownerId, input.ownerName)
    .map((grant) => `<Grant>${grant.granteeXml}${tag("Permission", grant.permission)}</Grant>`)
    .join("");
  return xmlDocument(
    "AccessControlPolicy",
    `<Owner>${tag("ID", input.ownerId)}${tag("DisplayName", input.ownerName)}</Owner>` +
      `<AccessControlList>${grants}</AccessControlList>`,
  );
}

/**
 * Reduce an AccessControlPolicy body back to the canned ACL it corresponds to.
 *
 * Anything that cannot be expressed as a canned name is rejected rather than
 * silently approximated — quietly rounding a grant list to the nearest canned
 * ACL could grant broader access than the caller asked for.
 */
export function cannedAclFromXml(body: string): BucketAcl {
  const grants = [...body.matchAll(/<Grant\b[\s\S]*?<\/Grant>/g)].map((m) => m[0]);
  if (grants.length === 0) {
    throw new S3Error("MalformedACLError", { Reason: "No grants in the ACL body." });
  }

  let publicRead = false;
  let publicWrite = false;
  let authenticatedRead = false;

  for (const grant of grants) {
    const uri = /<URI>([\s\S]*?)<\/URI>/.exec(grant)?.[1]?.trim();
    const permission = /<Permission>([\s\S]*?)<\/Permission>/.exec(grant)?.[1]?.trim();
    if (!permission) {
      throw new S3Error("MalformedACLError", { Reason: "Grant is missing a permission." });
    }
    // A canonical-user grant is the owner's own FULL_CONTROL, which every
    // canned ACL already implies. Per-user grants to *other* users are not
    // expressible here — bucket_members is the mechanism for that.
    if (!uri) {
      if (permission !== "FULL_CONTROL") {
        throw new S3Error("MalformedACLError", {
          Reason: "Per-user grants other than the owner's FULL_CONTROL are not supported.",
        });
      }
      continue;
    }
    if (uri === ALL_USERS_URI) {
      if (permission === "READ" || permission === "FULL_CONTROL") publicRead = true;
      if (permission === "WRITE" || permission === "FULL_CONTROL") publicWrite = true;
      continue;
    }
    if (uri === AUTHENTICATED_USERS_URI) {
      if (permission === "READ" || permission === "FULL_CONTROL") authenticatedRead = true;
      continue;
    }
    throw new S3Error("MalformedACLError", { Reason: `Unsupported grantee URI: ${uri}` });
  }

  if (publicWrite) return "public-read-write";
  if (publicRead) return "public-read";
  if (authenticatedRead) return "authenticated-read";
  return "private";
}
