-- Migration 0004: explicit Drive targets and selected-user bucket access.
-- Existing rows remain My Drive-backed and keep their stable bucket/object IDs.

CREATE TABLE drive_targets (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('my_drive', 'shared_drive')),
  shared_drive_id TEXT,
  root_folder_id TEXT,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'reauthorization_required', 'inaccessible', 'read_only', 'error')),
  last_error TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'my_drive' AND shared_drive_id IS NULL) OR
    (kind = 'shared_drive' AND shared_drive_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_drive_targets_my_drive_owner
  ON drive_targets(owner_user_id)
  WHERE kind = 'my_drive';

CREATE UNIQUE INDEX idx_drive_targets_shared_drive_owner
  ON drive_targets(owner_user_id, shared_drive_id)
  WHERE kind = 'shared_drive';

CREATE INDEX idx_drive_targets_owner
  ON drive_targets(owner_user_id, kind);

-- Users created after this migration receive their default target eagerly, so
-- legacy repository/test inserts remain backward compatible.
CREATE TRIGGER trg_users_default_drive_target
AFTER INSERT ON users
BEGIN
  INSERT INTO drive_targets
    (id, owner_user_id, kind, shared_drive_id, root_folder_id, display_name,
     status, created_at, updated_at)
  VALUES (
    'dt_legacy_' || NEW.id, NEW.id, 'my_drive', NULL, NULL, 'My Drive',
    'active', NEW.created_at, NEW.updated_at
  );
END;

ALTER TABLE buckets ADD COLUMN drive_target_id TEXT REFERENCES drive_targets(id);

-- Give every existing user a legacy My Drive target. A user can legitimately
-- have no cached root yet; root_folder_id remains nullable until first use.
INSERT INTO drive_targets
  (id, owner_user_id, kind, shared_drive_id, root_folder_id, display_name,
   status, verified_at, created_at, updated_at)
SELECT
  'dt_legacy_' || u.id,
  u.id,
  'my_drive',
  NULL,
  r.drive_folder_id,
  'My Drive',
  'active',
  r.verified_at,
  u.created_at,
  u.updated_at
FROM users u
LEFT JOIN drive_roots r ON r.user_id = u.id;

UPDATE buckets
   SET drive_target_id = 'dt_legacy_' || user_id
 WHERE drive_target_id IS NULL;

CREATE INDEX idx_buckets_drive_target
  ON buckets(drive_target_id);

-- Preserve compatibility with callers that omit the newly-added column while
-- ensuring every persisted bucket is linked to its owner's My Drive target.
CREATE TRIGGER trg_buckets_default_drive_target
AFTER INSERT ON buckets
WHEN NEW.drive_target_id IS NULL
BEGIN
  UPDATE buckets
     SET drive_target_id = (
       SELECT id FROM drive_targets
        WHERE owner_user_id = NEW.user_id AND kind = 'my_drive'
     )
   WHERE id = NEW.id;
END;

CREATE TRIGGER trg_buckets_drive_target_required_update
BEFORE UPDATE OF drive_target_id ON buckets
WHEN NEW.drive_target_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'bucket drive target is required');
END;

CREATE TRIGGER trg_buckets_drive_target_immutable
BEFORE UPDATE OF drive_target_id ON buckets
WHEN OLD.drive_target_id IS NOT NULL AND NEW.drive_target_id != OLD.drive_target_id
BEGIN
  SELECT RAISE(ABORT, 'bucket drive target is immutable');
END;

CREATE TRIGGER trg_buckets_drive_target_owner_insert
BEFORE INSERT ON buckets
WHEN NEW.drive_target_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM drive_targets t
   WHERE t.id = NEW.drive_target_id AND t.owner_user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'bucket drive target owner mismatch');
END;

CREATE TRIGGER trg_buckets_drive_target_owner_update
BEFORE UPDATE OF drive_target_id, user_id ON buckets
WHEN NOT EXISTS (
  SELECT 1 FROM drive_targets t
   WHERE t.id = NEW.drive_target_id AND t.owner_user_id = NEW.user_id
)
BEGIN
  SELECT RAISE(ABORT, 'bucket drive target owner mismatch');
END;

CREATE TABLE bucket_members (
  bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  access_status TEXT NOT NULL DEFAULT 'active'
    CHECK (access_status IN ('active', 'inaccessible', 'reauthorization_required')),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(bucket_id, user_id)
);

CREATE INDEX idx_bucket_members_user
  ON bucket_members(user_id, bucket_id);

CREATE TRIGGER trg_bucket_members_shared_only_insert
BEFORE INSERT ON bucket_members
WHEN NOT EXISTS (
  SELECT 1
    FROM buckets b
    JOIN drive_targets t ON t.id = b.drive_target_id
   WHERE b.id = NEW.bucket_id
     AND t.kind = 'shared_drive'
     AND b.user_id != NEW.user_id
     AND b.user_id = NEW.created_by
)
BEGIN
  SELECT RAISE(ABORT, 'bucket membership requires a shared-drive bucket owner');
END;

CREATE TRIGGER trg_bucket_members_shared_only_update
BEFORE UPDATE ON bucket_members
WHEN NOT EXISTS (
  SELECT 1
    FROM buckets b
    JOIN drive_targets t ON t.id = b.drive_target_id
   WHERE b.id = NEW.bucket_id
     AND t.kind = 'shared_drive'
     AND b.user_id != NEW.user_id
     AND b.user_id = NEW.created_by
)
BEGIN
  SELECT RAISE(ABORT, 'bucket membership requires a shared-drive bucket owner');
END;

ALTER TABLE object_staging ADD COLUMN drive_target_id TEXT REFERENCES drive_targets(id);
ALTER TABLE multipart_uploads ADD COLUMN drive_target_id TEXT REFERENCES drive_targets(id);
ALTER TABLE pending_cleanup ADD COLUMN drive_target_id TEXT REFERENCES drive_targets(id);

UPDATE object_staging
   SET drive_target_id = (
     SELECT b.drive_target_id FROM buckets b WHERE b.id = object_staging.bucket_id
   )
 WHERE drive_target_id IS NULL;

UPDATE multipart_uploads
   SET drive_target_id = (
     SELECT b.drive_target_id FROM buckets b WHERE b.id = multipart_uploads.bucket_id
   )
 WHERE drive_target_id IS NULL;

-- Existing cleanup rows are necessarily legacy My Drive work.
UPDATE pending_cleanup
   SET drive_target_id = 'dt_legacy_' || user_id
 WHERE drive_target_id IS NULL;

CREATE INDEX idx_object_staging_drive_target ON object_staging(drive_target_id);
CREATE INDEX idx_multipart_drive_target ON multipart_uploads(drive_target_id);
CREATE INDEX idx_pending_cleanup_drive_target ON pending_cleanup(drive_target_id);
