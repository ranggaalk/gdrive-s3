# Plan: "on change" backup schedules

Status: **not started** — written to be picked up by another agent.
Prerequisite: the `feat/backup-scheduler` branch (scheduled bucket backups and
database snapshots) is merged into `master`. Start a new branch from `master`,
e.g. `feat/backup-on-change-schedules`.

## Why

Bucket schedules today are clock-based: every N minutes/hours, daily, or weekly.
With "skip if unchanged" on, an every-15-minutes schedule is close to
continuous backup, but it is blind to *when* writes happen. If someone uploads
10,000 files over 40 minutes, slots fire in the middle of the upload: several
runs each copy part of it, and the destination briefly holds a half-uploaded
folder.

An **on change** schedule waits for the bucket to go quiet — no new writes for
`quietMinutes` — then queues one run that copies everything. A bucket that never
goes quiet is still backed up once its oldest pending change has waited
`maxWaitMinutes`.

No Redis, no event bus: the scheduler already ticks every
`BACKUP_SCHEDULER_TICK_SECONDS` and everything it needs is in SQLite.

## Read these first

| File | What it does |
|---|---|
| `apps/server/src/backup/schedule-time.ts` | `ScheduleTiming`, `normalizeTiming`, `nextRunAt` (pure, unit-tested) |
| `apps/server/src/db/migrations/0017_backup_schedules.sql` | `backup_schedules`; its `frequency` CHECK **already allows `'on_change'`** |
| `apps/server/src/db/repositories/backup-schedules.ts` | schedule rows, `listDue`, atomic `claimSlot`, `recordOutcome`, `pause` |
| `apps/server/src/services/backup-schedule-service.ts` | `create`/`update`, `runDue` → `fire`, `recordRunResult`, failure counting |
| `apps/server/src/jobs/backup-scheduler.ts` | the tick; takes an injectable clock `() => Date` |
| `apps/server/src/db/repositories/backup-transfers.ts` | `hasObjectsNeedingWork`, run creation with `triggeredBy`/`scheduleId` |
| `apps/server/src/routes/api-backup-schedules.ts` | `/api/backup-schedules` and `scheduleView` |
| `apps/server/src/services/db-snapshot-service.ts` | DB snapshots reuse `normalizeTiming`; they must **not** accept `on_change` |
| `apps/web/src/components/backup-schedules.tsx` | `ScheduleTimingFields` (shared with the DB snapshot card), dialog, list, `scheduleSummary` |
| `apps/web/src/components/db-snapshot-card.tsx` | uses `ScheduleTimingFields`; must not offer `on_change` |
| `apps/web/src/lib/i18n/id.ts`, `en.ts` | `backupSchedule` section; `id.ts` is the source of truth for the dictionary type |
| `tests/integration/backup-scheduler.test.ts` | scheduler end to end with a fake clock and an S3 destination |
| `docs/OPERATIONS.md` §10 | operator docs for schedules |

## Behaviour

A schedule with `frequency = 'on_change'` has two settings:

- `quietMinutes` — whole minutes, 1–1440, default 10. How long the bucket must
  have had no new writes.
- `maxWaitMinutes` — whole minutes, `quietMinutes`–10080, default 360. The
  longest a pending change waits for the bucket to go quiet.

`intervalMinutes`, `timeOfDay` and `daysOfWeek` are null. `timezone` stays
required by the table; store whatever the client sends (it is unused).
`skip_if_unchanged` is forced to 1 — an on-change schedule never runs without
changes — and the UI hides that toggle for it.

### Checking cadence

`nextRunAt(timing, after)` for `on_change` returns `after + 60s`. This keeps
the scheduler loop exactly as it is: the schedule "falls due" once a minute,
`claimSlot` takes the slot atomically, and `fire()` decides whether to queue.

### What `fire()` does for an on-change schedule

The ownership and destination checks at the top of `fire()` stay as they are.
Then:

```text
pending = hasObjectsNeedingWork(bucket, destination)
if not pending:
    set pending_since = NULL
    leave last_outcome alone          # don't overwrite "completed" every minute
    return
if pending_since is NULL:
    pending_since = now               # first tick that saw unbacked changes
lastWrite = MAX(objects.updated_at) for the bucket's active objects
quiet   = lastWrite <= now - quietMinutes
overdue = pending_since <= now - maxWaitMinutes
if quiet or overdue:
    queue a run (triggeredBy 'schedule', scheduleId)
        ok                      -> pending_since = NULL, outcome 'queued'
        BackupAlreadyActive     -> keep pending_since, outcome 'skipped_active'
        BackupTransferInvalid   -> countFailure(... 'skipped_destination' ...)
else:
    outcome 'waiting_quiet'
```

Notes:

- `pending_since` is when the scheduler first *noticed* unbacked changes, not
  when they were written. It is off by at most one check (a minute), and it
  makes the max-wait check a column read instead of a `MIN()` over the ledger
  join. It persists, so the max wait holds across restarts.
- Deletions are not changes here: backups never propagate deletes, and
  `MAX(updated_at)` over active objects ignores them naturally.
- `objects.updated_at` also moves on non-content changes (ACL updates in
  `objects.ts`). That can only delay a run by up to `quietMinutes`; it is fine.
- The fake clock in tests drives the scheduler, but `objects.updated_at` comes
  from the real clock. Tests set `updated_at` with SQL relative to the fake
  `now`.
- Failure counting, auto-pause, "run now" and `recordRunResult` are unchanged.

## Changes

### Database — `0019_backup_on_change.sql`

Only `ALTER TABLE … ADD COLUMN` and `CREATE INDEX`. **Do not rebuild
`backup_schedules`:** migrations run inside a transaction, so
`PRAGMA foreign_keys = OFF` has no effect, and dropping the table would fire
`ON DELETE SET NULL` on every `backup_transfers.schedule_id` (see the note at
the top of `0013_versioning.sql` for the same trap). The `frequency` CHECK
already allows `'on_change'`; that is why it was widened before shipping.

```sql
ALTER TABLE backup_schedules ADD COLUMN quiet_minutes INTEGER;
ALTER TABLE backup_schedules ADD COLUMN max_wait_minutes INTEGER;
ALTER TABLE backup_schedules ADD COLUMN pending_since TEXT;
-- MAX(updated_at) per bucket over active objects, by index seek.
CREATE INDEX idx_objects_bucket_status_updated ON objects(bucket_id, status, updated_at);
```

### Server

- `schedule-time.ts`: add `"on_change"` to `ScheduleFrequency`; add
  `quietMinutes` and `maxWaitMinutes` (`number | null`) to `ScheduleTiming`.
  `normalizeTiming(input, minInterval, options?)` validates them for
  `on_change` and nulls them for every other frequency. Give it an option such
  as `{ allowOnChange: boolean }`, default `false`, so the DB snapshot service
  keeps refusing `on_change` without changes of its own. Bucket schedules pass
  `true`. `nextRunAt` handles `on_change` as above.
- `backup-schedules.ts` (repository): read/write the three new columns
  (`timingOf`, `create`, `update`); add `setPendingSince(id, value | null)`.
  Add `"waiting_quiet"` to `BackupScheduleOutcome`. `update()` should clear
  `pending_since` when the frequency changes.
- `backup-transfers.ts` (repository): add
  `lastObjectWriteAt(bucketId): string | null` —
  `SELECT MAX(updated_at) FROM objects WHERE bucket_id = ? AND status = 'active'`.
- `backup-schedule-service.ts`: `timingFrom` picks up `quietMinutes` and
  `maxWaitMinutes`; `create`/`update` force `skip_if_unchanged` for
  `on_change`; `fire()` branches as above.
- `api-backup-schedules.ts`: `scheduleView` adds `quietMinutes`,
  `maxWaitMinutes`, `pendingSince`. No new routes or error codes are needed;
  validation errors already map to `INVALID_BACKUP_SCHEDULE` with `detail`.

### Web

- `client.ts`: add `"on_change"` to `BackupScheduleFrequency`, `"waiting_quiet"`
  to `BackupScheduleOutcome`, and `quietMinutes`, `maxWaitMinutes`,
  `pendingSince` to the schedule types.
- `ScheduleTimingFields`: a fourth frequency button, "On change", shown only
  with a new `allowOnChange` prop (the bucket schedule dialog passes it; the DB
  snapshot card does not). For `on_change`, show two selects instead of the
  clock fields:
  - quiet: 5, 10, 15, 30, 60 minutes;
  - max wait: 1, 3, 6, 12, 24 hours (only values ≥ quiet).

  Extend `TimingDraft`, `draftFromTiming`, `timingFromDraft` and `timingReady`.
- `BackupScheduleDialog`: hide the skip toggle when the frequency is
  `on_change`.
- `scheduleSummary`: e.g. "After 10 quiet minutes (at most 6 hours)".
- Schedule list and the Objects-page panel: for `on_change`, show "Waiting for
  the bucket to go quiet since <time>" when `pendingSince` is set, and "Up to
  date" otherwise, instead of "Next: <time>" (the next *check* is meaningless
  to a user).
- i18n (`id.ts` first, then `en.ts`): frequency label, the quiet and max-wait
  labels and option text, the summary, the waiting/up-to-date lines, and
  `outcome.waiting_quiet`. `tests/unit/i18n-coverage.test.ts` and the
  `Dictionary` type catch anything missing.

### Docs

- `docs/OPERATIONS.md` §10: describe the on-change mode, `pending_since`, and
  that ACL changes count as writes.
- `README.md`, Bucket backup section: mention it in the scheduling paragraph.
- Delete this plan file, or mark it done, in the same change.

## Tests

Unit (`tests/unit/backup-schedule-time.test.ts`):

- `normalizeTiming` accepts `on_change` with valid quiet/max wait, rejects a
  quiet below 1 or above 1440, a max wait below quiet or above 10080, and
  rejects `on_change` when `allowOnChange` is not set.
- `nextRunAt` for `on_change` is exactly 60 seconds later.

Integration (`tests/integration/backup-scheduler.test.ts`, reusing its
`setup()`, `tick()` and `runs()` helpers; quiet 10, max wait 60):

1. No changes: ticks queue nothing, and `pendingSince` stays null.
2. Burst then quiet: objects written (set their `updated_at` to fake `t0`).
   At `t0+5m` the outcome is `waiting_quiet`, there is no run, and
   `pendingSince` is set. At `t0+11m` one scheduled run is queued and
   `pendingSince` goes back to null.
3. Never quiet: before each tick, bump an object's `updated_at` to the fake
   now. No run until `pendingSince + 60m`, then exactly one.
4. `pendingSince` survives a new `BackupScheduleService` and worker instance
   (simulated restart), and the max wait still counts from it.
5. A run already active gives `skipped_active` and keeps `pendingSince`.
6. Creating an on-change schedule with `skipIfUnchanged: false` stores it
   as `true`.
7. `PUT /api/settings/db-snapshot` with `frequency: "on_change"` returns 400
   `INVALID_DB_SNAPSHOT`.
8. Migration: an existing interval schedule is unchanged after 0019 (null new
   columns, still fires).

## Done when

- `bun run typecheck`, `bun test` and `bun run build:web` pass.
- The boot-time schema drift check passes on a database migrated from 0018.
- The behaviour above holds in the integration tests.
- The docs are updated and this plan is removed or marked done.

## House rules

- One branch per feature, off `master`. Commit messages are a plain
  imperative sentence and a prose body; **no `Co-Authored-By` or other
  trailers**.
- Server error messages stay as they are; the dashboard localises by error
  code, and `detail` carries untranslated specifics.
- Comments explain *why*, as in the surrounding code.
- Pushing over SSH may fail in an agent's shell. Pushing over HTTPS with the
  `gh` credential helper works:
  `git -c credential.helper= -c credential.helper='!gh auth git-credential' push …`.
  Push only the branch — never tags or `--mirror`.
