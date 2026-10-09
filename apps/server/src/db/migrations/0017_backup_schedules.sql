-- Scheduled backups. A schedule belongs to one (bucket, destination) pair, the
-- same pair a manual run targets, and does nothing but enqueue ordinary runs
-- into backup_transfers when it falls due -- the worker, the ledger and the
-- history are the ones manual runs already use.
--
-- `enabled` is the one switch that decides whether a schedule fires. The
-- scheduler turns it off itself when a schedule cannot work (repeated failed
-- runs, a bucket its owner no longer owns) and says why in paused_reason; the
-- owner turning it back on clears the reason.

CREATE TABLE backup_schedules (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bucket_id TEXT NOT NULL REFERENCES buckets(id) ON DELETE CASCADE,
  backup_account_id TEXT NOT NULL REFERENCES backup_accounts(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- 'on_change' is reserved for the quiet-period mode planned in
  -- docs/plans/backup-on-change-schedules.md, and refused by the code until
  -- then. It is allowed here now because widening a CHECK later means
  -- rebuilding this table, and dropping it would null out every
  -- backup_transfers.schedule_id that points at it.
  frequency TEXT NOT NULL CHECK (frequency IN ('interval', 'daily', 'weekly', 'on_change')),
  -- 'interval' only.
  interval_minutes INTEGER,
  -- 'daily' and 'weekly': wall-clock "HH:MM" in `timezone`.
  time_of_day TEXT,
  -- 'weekly' only: ISO weekdays, "1,3,5" for Monday, Wednesday, Friday.
  days_of_week TEXT,
  -- IANA name, e.g. Asia/Jakarta.
  timezone TEXT NOT NULL,
  -- Skip a slot outright, without a run row, when nothing needs copying.
  skip_if_unchanged INTEGER NOT NULL DEFAULT 1 CHECK (skip_if_unchanged IN (0, 1)),
  next_run_at TEXT,
  last_checked_at TEXT,
  last_outcome TEXT,
  last_transfer_id TEXT REFERENCES backup_transfers(id) ON DELETE SET NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bucket_id, backup_account_id)
);
CREATE INDEX idx_backup_schedules_due ON backup_schedules(enabled, next_run_at);
CREATE INDEX idx_backup_schedules_owner ON backup_schedules(owner_user_id);

-- What started a run. A scheduled run is queued behind manual ones, and its
-- outcome is reported back to the schedule that queued it.
ALTER TABLE backup_transfers ADD COLUMN triggered_by TEXT NOT NULL DEFAULT 'manual'
  CHECK (triggered_by IN ('manual', 'schedule'));
ALTER TABLE backup_transfers ADD COLUMN schedule_id TEXT
  REFERENCES backup_schedules(id) ON DELETE SET NULL;
