// Scheduled backups: the dialog that creates and edits a schedule, and the
// list of every schedule on the Backup page. A schedule only queues ordinary
// runs, so everything about what a run did stays in the backup history.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CalendarClock, Pause, Pencil, Play, Plus, Power, Trash2 } from "lucide-react";
import { Alert, AlertDialog, Button, Card, Chip, Input, Label, Modal, TextField, Tooltip } from "@heroui/react";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { useToast } from "@/components/toast-provider";
import { Select } from "@/components/ui/select";
import type { Dictionary } from "@/lib/i18n/types";
import {
  createBackupSchedule,
  deleteBackupSchedule,
  errorText,
  listBackupSchedules,
  runBackupScheduleNow,
  updateBackupSchedule,
  type BackupAccount,
  type BackupSchedule,
  type BackupScheduleFrequency,
  type BackupScheduleOptions,
  type BackupScheduleOutcome,
} from "../api/client.ts";

const INTERVAL_CHOICES = [15, 30, 60, 120, 180, 240, 360, 720, 1440];
// Indonesia's three zones first: the people running this gateway mostly live
// in them. The browser's own zone and UTC are always offered as well.
const ZONE_CHOICES = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "UTC"];

export const OUTCOME_COLOR: Record<BackupScheduleOutcome, "success" | "warning" | "danger" | "default" | "accent"> = {
  queued: "accent",
  skipped_unchanged: "default",
  skipped_active: "default",
  skipped_destination: "warning",
  completed: "success",
  failed: "danger",
  cancelled: "default",
  paused: "warning",
  error: "danger",
};

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** One line saying when a schedule runs. */
export function scheduleSummary(
  schedule: Pick<BackupSchedule, "frequency" | "intervalMinutes" | "timeOfDay" | "daysOfWeek" | "timezone">,
  t: Dictionary,
): string {
  const s = t.backupSchedule;
  if (schedule.frequency === "interval") return s.summaryInterval(s.intervalOption(schedule.intervalMinutes ?? 0));
  const time = schedule.timeOfDay ?? "";
  if (schedule.frequency === "daily") return s.summaryDaily(time, schedule.timezone);
  const days = (schedule.daysOfWeek ?? []).map((day) => s.weekdaysShort[day - 1]).join(", ");
  return s.summaryWeekly(days, time, schedule.timezone);
}

export function formatWhen(iso: string | null): string | null {
  return iso ? new Date(iso).toLocaleString() : null;
}

interface ScheduleDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (schedule: BackupSchedule) => void;
  /** The schedule being edited; null to create one. */
  schedule: BackupSchedule | null;
  buckets: Array<{ id: string; name: string }>;
  destinations: BackupAccount[];
  fixedBucketId?: string;
  fixedAccountId?: string;
  minIntervalMinutes: number;
}

export function BackupScheduleDialog({
  isOpen,
  onOpenChange,
  onSaved,
  schedule,
  buckets,
  destinations,
  fixedBucketId,
  fixedAccountId,
  minIntervalMinutes,
}: ScheduleDialogProps) {
  const { t } = useLocale();
  const s = t.backupSchedule;
  const [bucketId, setBucketId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [frequency, setFrequency] = useState<BackupScheduleFrequency>("daily");
  const [intervalMinutes, setIntervalMinutes] = useState("360");
  const [timeOfDay, setTimeOfDay] = useState("02:00");
  const [days, setDays] = useState<number[]>([1]);
  const [timezone, setTimezone] = useState(browserZone());
  const [skipIfUnchanged, setSkipIfUnchanged] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setBucketId(schedule?.bucketId ?? fixedBucketId ?? "");
    setAccountId(schedule?.backupAccountId ?? fixedAccountId ?? "");
    setFrequency(schedule?.frequency ?? "daily");
    setIntervalMinutes(String(schedule?.intervalMinutes ?? Math.max(360, minIntervalMinutes)));
    setTimeOfDay(schedule?.timeOfDay ?? "02:00");
    setDays(schedule?.daysOfWeek ?? [1]);
    setTimezone(schedule?.timezone ?? browserZone());
    setSkipIfUnchanged(schedule?.skipIfUnchanged ?? true);
  }, [isOpen, schedule, fixedBucketId, fixedAccountId, minIntervalMinutes]);

  const intervalOptions = [...new Set([...INTERVAL_CHOICES.filter((m) => m >= minIntervalMinutes), Number(intervalMinutes)])]
    .sort((a, b) => a - b)
    .map((minutes) => ({ value: String(minutes), label: s.intervalOption(minutes) }));
  const zoneOptions = [...new Set([timezone, browserZone(), ...ZONE_CHOICES])].map((zone) => ({ value: zone, label: zone }));

  const toggleDay = (day: number) =>
    setDays((current) => (current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b)));

  const ready =
    Boolean(bucketId && accountId) &&
    (frequency === "interval" || /^\d{2}:\d{2}$/.test(timeOfDay)) &&
    (frequency !== "weekly" || days.length > 0);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    const timing = {
      frequency,
      intervalMinutes: frequency === "interval" ? Number(intervalMinutes) : null,
      timeOfDay: frequency === "interval" ? null : timeOfDay,
      daysOfWeek: frequency === "weekly" ? days : null,
      timezone,
    };
    try {
      const saved = schedule
        ? await updateBackupSchedule(schedule.id, { ...timing, skipIfUnchanged })
        : await createBackupSchedule({ ...timing, bucketId, backupAccountId: accountId, skipIfUnchanged });
      onSaved(saved);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const choosing = !schedule;
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => { if (!saving) onOpenChange(open); }}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label={t.common.close} />
          <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col">
            <Modal.Header>
              <Modal.Heading>{schedule ? s.editTitle : s.createTitle}</Modal.Heading>
              <p className="text-sm text-muted">{s.dialogDescription}</p>
            </Modal.Header>
            <Modal.Body className="space-y-5">
              {error ? <ErrorAlert message={error} /> : null}
              {schedule ? (
                <p className="rounded-xl border p-3 text-sm">
                  <span className="font-medium">{schedule.bucketName}</span> → {schedule.accountLabel}
                </p>
              ) : null}
              {choosing && !fixedBucketId ? (
                <Select
                  label={s.bucketLabel}
                  value={bucketId}
                  onValueChange={setBucketId}
                  placeholder={s.pickBucket}
                  options={buckets.map((bucket) => ({ value: bucket.id, label: bucket.name }))}
                />
              ) : null}
              {choosing && !fixedAccountId ? (
                <Select
                  label={s.destinationLabel}
                  value={accountId}
                  onValueChange={setAccountId}
                  placeholder={s.pickDestination}
                  options={destinations.map((account) => ({ value: account.id, label: account.label }))}
                />
              ) : null}

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">{s.frequencyLabel}</legend>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ["interval", s.frequencyInterval],
                      ["daily", s.frequencyDaily],
                      ["weekly", s.frequencyWeekly],
                    ] as const
                  ).map(([value, label]) => (
                    <Button
                      key={value}
                      fullWidth
                      size="sm"
                      variant={frequency === value ? "primary" : "outline"}
                      onPress={() => setFrequency(value)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </fieldset>

              {frequency === "interval" ? (
                <Select label={s.intervalLabel} value={intervalMinutes} onValueChange={setIntervalMinutes} options={intervalOptions} />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField fullWidth value={timeOfDay} onChange={setTimeOfDay}>
                    <Label>{s.timeLabel}</Label>
                    <Input type="time" />
                  </TextField>
                  <Select label={s.timezoneLabel} value={timezone} onValueChange={setTimezone} options={zoneOptions} />
                </div>
              )}

              {frequency === "weekly" ? (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-foreground">{s.daysLabel}</legend>
                  <div className="grid grid-cols-7 gap-1">
                    {s.weekdaysShort.map((name, index) => {
                      const day = index + 1;
                      const on = days.includes(day);
                      return (
                        <Button
                          key={day}
                          size="sm"
                          aria-pressed={on}
                          variant={on ? "primary" : "outline"}
                          className="min-w-0 px-0"
                          onPress={() => toggleDay(day)}
                        >
                          {name}
                        </Button>
                      );
                    })}
                  </div>
                </fieldset>
              ) : null}

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">{s.skipLabel}</legend>
                <div className="grid grid-cols-2 gap-2">
                  <Button fullWidth size="sm" variant={skipIfUnchanged ? "primary" : "outline"} onPress={() => setSkipIfUnchanged(true)}>
                    {s.skipOn}
                  </Button>
                  <Button fullWidth size="sm" variant={skipIfUnchanged ? "outline" : "primary"} onPress={() => setSkipIfUnchanged(false)}>
                    {s.skipOff}
                  </Button>
                </div>
                <p className="text-xs text-muted">{s.skipHelp}</p>
              </fieldset>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary" isDisabled={saving}>{t.common.cancel}</Button>
              <Button type="submit" isDisabled={!ready || saving}>{saving ? s.saving : s.save}</Button>
            </Modal.Footer>
          </form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** Every schedule the user owns, with what each last did and its controls. */
export function BackupSchedulesSection({
  buckets,
  destinations,
  options,
  reloadKey,
  onRunQueued,
}: {
  buckets: Array<{ id: string; name: string }>;
  destinations: BackupAccount[];
  options: BackupScheduleOptions | null;
  /** Changes whenever something that schedules hang off changed. */
  reloadKey: unknown;
  onRunQueued?: () => void;
}) {
  const { t } = useLocale();
  const s = t.backupSchedule;
  const toast = useToast();
  const [schedules, setSchedules] = useState<BackupSchedule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BackupSchedule | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupSchedule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSchedules(await listBackupSchedules());
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const act = async (schedule: BackupSchedule, action: () => Promise<unknown>, success: string, failure: string) => {
    if (busyId) return;
    setBusyId(schedule.id);
    try {
      await action();
      toast.success(success);
      await load();
    } catch (cause) {
      toast.fromError(failure, cause);
    } finally {
      setBusyId(null);
    }
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    await act(target, () => deleteBackupSchedule(target.id), t.toast.backupScheduleDeleted, t.toast.backupScheduleDeleteFailed);
    setDeleteTarget(null);
  };

  const minInterval = options?.minIntervalMinutes ?? 15;
  const canCreate = destinations.length > 0 && buckets.length > 0;

  return (
    <section aria-label={s.sectionTitle} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{s.sectionTitle}</h2>
          <p className="text-sm text-muted">{s.sectionDescription}</p>
        </div>
        <Button size="sm" isDisabled={!canCreate} onPress={() => { setEditing(null); setDialogOpen(true); }}>
          <Plus /> {s.addSchedule}
        </Button>
      </div>

      {options && !options.enabled ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{s.schedulerOff}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {error ? <ErrorAlert message={error} /> : null}

      {schedules === null ? (
        <LoadingState label={s.loading} />
      ) : schedules.length === 0 ? (
        <EmptyState icon={CalendarClock} title={s.emptyTitle} description={canCreate ? s.emptyDescription : s.needsDestination} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {schedules.map((schedule) => {
            const name = `${schedule.bucketName} → ${schedule.accountLabel}`;
            const busy = busyId === schedule.id;
            return (
              <Card key={schedule.id}>
                <Card.Header className="flex-row items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Card.Title className="truncate text-base font-semibold" title={name}>{name}</Card.Title>
                    <Card.Description>{scheduleSummary(schedule, t)}</Card.Description>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <Tooltip delay={300}>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={s.runNowLabel(name)}
                        isDisabled={busy}
                        onPress={() =>
                          void act(
                            schedule,
                            async () => {
                              await runBackupScheduleNow(schedule.id);
                              onRunQueued?.();
                            },
                            t.toast.backupScheduleQueued,
                            t.toast.backupScheduleRunFailed,
                          )
                        }
                      >
                        <Play />
                      </Button>
                      <Tooltip.Content>{s.runNow}</Tooltip.Content>
                    </Tooltip>
                    <Tooltip delay={300}>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={schedule.enabled ? s.pause : s.resume}
                        isDisabled={busy}
                        onPress={() =>
                          void act(
                            schedule,
                            () => updateBackupSchedule(schedule.id, { enabled: !schedule.enabled }),
                            schedule.enabled ? t.toast.backupSchedulePaused : t.toast.backupScheduleResumed,
                            t.toast.backupScheduleSaveFailed,
                          )
                        }
                      >
                        {schedule.enabled ? <Pause /> : <Power />}
                      </Button>
                      <Tooltip.Content>{schedule.enabled ? s.pause : s.resume}</Tooltip.Content>
                    </Tooltip>
                    <Tooltip delay={300}>
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        aria-label={s.editLabel(name)}
                        onPress={() => { setEditing(schedule); setDialogOpen(true); }}
                      >
                        <Pencil />
                      </Button>
                      <Tooltip.Content>{s.edit}</Tooltip.Content>
                    </Tooltip>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      aria-label={s.deleteLabel(name)}
                      onPress={() => setDeleteTarget(schedule)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </Card.Header>
                <Card.Content className="gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip size="sm" variant="soft" color={schedule.enabled ? "success" : "default"}>
                      {schedule.enabled ? s.statusOn : s.statusOff}
                    </Chip>
                    {schedule.lastOutcome ? (
                      <Chip size="sm" variant="soft" color={OUTCOME_COLOR[schedule.lastOutcome]}>
                        {s.outcome[schedule.lastOutcome]}
                      </Chip>
                    ) : null}
                    {schedule.consecutiveFailures > 0 ? (
                      <Chip size="sm" variant="soft" color="danger">{s.failuresLabel(schedule.consecutiveFailures)}</Chip>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted">
                    {schedule.enabled && schedule.nextRunAt ? s.nextRun(formatWhen(schedule.nextRunAt)!) : s.notScheduled}
                    {schedule.lastCheckedAt ? ` · ${s.lastCheck(formatWhen(schedule.lastCheckedAt)!)}` : ""}
                  </p>
                  {schedule.pausedReason ? (
                    <Alert status="warning">
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Title>{s.pausedTitle}</Alert.Title>
                        <Alert.Description className="break-words">{schedule.pausedReason}</Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : null}
                </Card.Content>
              </Card>
            );
          })}
        </div>
      )}

      <BackupScheduleDialog
        isOpen={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={() => {
          setDialogOpen(false);
          toast.success(t.toast.backupScheduleSaved);
          void load();
        }}
        schedule={editing}
        buckets={buckets}
        destinations={destinations}
        minIntervalMinutes={minInterval}
      />

      <AlertDialog.Backdrop isOpen={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !busyId) setDeleteTarget(null); }}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>{s.deleteConfirmTitle}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>
                <span className="break-all font-medium text-foreground">
                  {deleteTarget ? `${deleteTarget.bucketName} → ${deleteTarget.accountLabel}` : ""}
                </span>{" "}
                {s.deleteConfirmDescription}
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={Boolean(busyId)}>{t.common.cancel}</Button>
              <Button variant="danger" isDisabled={Boolean(busyId)} onPress={() => void doDelete()}>
                {busyId ? s.deleting : s.delete}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </section>
  );
}
