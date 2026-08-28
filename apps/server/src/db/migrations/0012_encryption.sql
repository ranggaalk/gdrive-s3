-- Server-side encryption: local customer master keys (CMKs) and the per-object
-- data keys they wrap.
--
-- Additive throughout: existing objects have no object_encryption row and are
-- read as plaintext, exactly as before. Encryption only applies to objects
-- written after a bucket default or an explicit request header asks for it.

CREATE TABLE kms_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  -- AES-256 key material, encrypted under MASTER_ENCRYPTION_KEY.
  encrypted_material TEXT NOT NULL,
  -- Bumped on every rotation; objects record the version they were written
  -- under so a rotation never strands existing data.
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  rotated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, alias)
);

CREATE INDEX idx_kms_keys_user ON kms_keys(user_id, status);

-- Superseded CMK material. Retained so objects written before a rotation stay
-- readable; dropping a row here permanently destroys access to those objects.
CREATE TABLE kms_key_versions (
  kms_key_id TEXT NOT NULL REFERENCES kms_keys(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  encrypted_material TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kms_key_id, version)
);

-- One row per encrypted object. Absent means the object is stored in the
-- clear, which is what every pre-existing object is.
CREATE TABLE object_encryption (
  object_id TEXT PRIMARY KEY REFERENCES objects(id) ON DELETE CASCADE,
  sse_algorithm TEXT NOT NULL
    CHECK (sse_algorithm IN ('AES256', 'aws:kms')),
  -- Null for SSE-S3 and SSE-C, which do not involve a CMK.
  kms_key_id TEXT REFERENCES kms_keys(id) ON DELETE RESTRICT,
  kms_key_version INTEGER,
  -- Null for SSE-C: the customer holds the key, so there is nothing to store.
  wrapped_data_key TEXT,
  iv TEXT NOT NULL,
  -- MD5 of the customer-provided key, so a wrong key is rejected rather than
  -- silently returning garbage. Only set for SSE-C.
  customer_key_md5 TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_object_encryption_key ON object_encryption(kms_key_id);

-- Bucket-level default encryption, applied when a PUT names none itself.
ALTER TABLE buckets ADD COLUMN default_sse_algorithm TEXT
  CHECK (default_sse_algorithm IS NULL OR default_sse_algorithm IN ('AES256', 'aws:kms'));
ALTER TABLE buckets ADD COLUMN default_kms_key_id TEXT
  REFERENCES kms_keys(id) ON DELETE SET NULL;

-- Carried through staging so encryption metadata commits in the same
-- transaction that publishes the object.
ALTER TABLE object_staging ADD COLUMN sse_algorithm TEXT;
ALTER TABLE object_staging ADD COLUMN sse_kms_key_id TEXT;
ALTER TABLE object_staging ADD COLUMN sse_kms_key_version INTEGER;
ALTER TABLE object_staging ADD COLUMN sse_wrapped_data_key TEXT;
ALTER TABLE object_staging ADD COLUMN sse_iv TEXT;
ALTER TABLE object_staging ADD COLUMN sse_customer_key_md5 TEXT;

-- Multipart uploads pick their data key at CreateMultipartUpload so every part
-- and the final assembly share one key.
ALTER TABLE multipart_uploads ADD COLUMN sse_algorithm TEXT;
ALTER TABLE multipart_uploads ADD COLUMN sse_kms_key_id TEXT;
ALTER TABLE multipart_uploads ADD COLUMN sse_kms_key_version INTEGER;
ALTER TABLE multipart_uploads ADD COLUMN sse_wrapped_data_key TEXT;
ALTER TABLE multipart_uploads ADD COLUMN sse_iv TEXT;
ALTER TABLE multipart_uploads ADD COLUMN sse_customer_key_md5 TEXT;
