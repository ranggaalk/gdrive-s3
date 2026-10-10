-- "On change" backup schedules: the frequency 0017 reserved. Instead of a
-- clock, such a schedule waits for its bucket to go quiet -- no new writes for
-- quiet_minutes -- and then queues one run that copies everything, so a bulk
-- upload lands at the destination whole rather than spread over several runs.
-- A bucket that never goes quiet is still backed up once its pending changes
-- have waited max_wait_minutes.
--
-- Columns are added in place. backup_schedules must not be rebuilt: migrations
-- run inside a transaction, where PRAGMA foreign_keys = OFF has no effect, so
-- dropping the table would fire ON DELETE SET NULL on every
-- backup_transfers.schedule_id that points at it (the same trap 0013 notes for
-- objects). 0017 already allows 'on_change' in the frequency CHECK for this
-- reason.

-- 'on_change' only; NULL for every other frequency.
ALTER TABLE backup_schedules ADD COLUMN quiet_minutes INTEGER;
ALTER TABLE backup_schedules ADD COLUMN max_wait_minutes INTEGER;
-- When the scheduler first noticed changes not yet backed up; the maximum wait
-- counts from here. NULL when nothing is waiting.
ALTER TABLE backup_schedules ADD COLUMN pending_since TEXT;

-- The newest write to a bucket's active objects, MAX(updated_at), by index
-- seek: an on-change schedule asks every minute.
CREATE INDEX idx_objects_bucket_status_updated ON objects(bucket_id, status, updated_at);
