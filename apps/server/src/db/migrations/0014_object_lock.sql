-- Object Lock and Legal Hold: write-once-read-many retention.
--
-- Lock state lives on the *version*, not the key, because that is what
-- retention protects — the whole point is that a locked version cannot be
-- destroyed even as newer versions are written over it. So both `objects`
-- (the current version) and `object_versions` (superseded ones) carry the
-- same three columns.
--
-- Additive throughout: every existing row has no lock, which is exactly how
-- the gateway behaved before this migration.

-- Once enabled a bucket can never turn Object Lock off, which is what makes
-- the guarantee worth anything. Enforced in the service, not by the schema,
-- so the column stays a simple flag.
ALTER TABLE buckets ADD COLUMN object_lock_enabled INTEGER NOT NULL DEFAULT 0;

-- Default retention applied to writes that name none themselves, stored as
-- JSON: {"mode":"GOVERNANCE|COMPLIANCE","days":30} or {"years":1}.
ALTER TABLE buckets ADD COLUMN object_lock_default_json TEXT;

ALTER TABLE objects ADD COLUMN lock_mode TEXT
  CHECK (lock_mode IS NULL OR lock_mode IN ('GOVERNANCE', 'COMPLIANCE'));
ALTER TABLE objects ADD COLUMN retain_until TEXT;
ALTER TABLE objects ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0;

ALTER TABLE object_versions ADD COLUMN lock_mode TEXT
  CHECK (lock_mode IS NULL OR lock_mode IN ('GOVERNANCE', 'COMPLIANCE'));
ALTER TABLE object_versions ADD COLUMN retain_until TEXT;
ALTER TABLE object_versions ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0;

-- Carried through staging so a PUT's lock lands in the same transaction that
-- publishes the object. A window where the bytes exist but the lock does not
-- would be a window in which they could be deleted.
ALTER TABLE object_staging ADD COLUMN lock_mode TEXT;
ALTER TABLE object_staging ADD COLUMN retain_until TEXT;
ALTER TABLE object_staging ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0;
