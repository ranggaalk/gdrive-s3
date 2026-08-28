-- ACL and bucket policy.
--
-- Both are additive: every existing bucket and object becomes 'private',
-- which is exactly the behaviour before this migration — access decided
-- solely by ownership and bucket_members. Nothing opens up until an operator
-- explicitly sets an ACL or attaches a policy.

ALTER TABLE buckets ADD COLUMN acl TEXT NOT NULL DEFAULT 'private'
  CHECK (acl IN ('private', 'public-read', 'public-read-write', 'authenticated-read'));

ALTER TABLE objects ADD COLUMN acl TEXT NOT NULL DEFAULT 'private'
  CHECK (acl IN ('private', 'public-read', 'public-read-write', 'authenticated-read',
                 'bucket-owner-read', 'bucket-owner-full-control'));

-- One policy document per bucket, mirroring S3 where PutBucketPolicy replaces
-- the whole document rather than merging statements.
CREATE TABLE bucket_policies (
  bucket_id TEXT PRIMARY KEY REFERENCES buckets(id) ON DELETE CASCADE,
  policy_json TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
