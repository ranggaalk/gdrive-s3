// Settings card for scheduled snapshots of the gateway's own database. Admins
// only (the Settings page is): the archive holds every user's secrets, and it
// goes to a destination of the admin's own.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { DatabaseBackup, Play } from "lucide-react";
import { Alert, Button, Card, Chip, Description, Input, Label, TextField } from "@heroui/react";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import {
  draftFromTiming,
  formatWhen,
  ScheduleTimingFields,
  timingFromDraft,
  timingReady,
  type TimingDraft,
} from "@/components/backup-schedules";
import { useLocale } from "@/components/locale-provider";
import { useToast } from "@/components/toast-provider";
import { Select } from "@/components/ui/select";
import { humanBytes } from "@/lib/format";
import {
  errorText,
  getDbSnapshotStatus,
  listBackupAccounts,
  runDbSnapshotNow,
  saveDbSnapshotSettings,
  type BackupAccount,
  type DbSnapshotStatus,
} from "../api/client.ts";

const STATUS_COLOR = { running: "accent", completed: "success", failed: "danger" } as const;

export function DbSnapshotCard() {
  const { t } = useLocale();
  const d = t.dbSnapshot;
  const toast = useToast();
  const [status, setStatus] = useState<DbSnapshotStatus | null>(null);
  const [destinations, setDestinations] = useState<BackupAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [destinationId, setDestinationId] = useState("");
  const [timing, setTiming] = useState<TimingDraft>(() =>
    draftFromTiming(null, { frequency: "daily", intervalMinutes: 1440, timeOfDay: "03:00" }),
  );
  const [retain, setRetain] = useState("14");

  const applyStatus = useCallback((next: DbSnapshotStatus) => {
    setStatus(next);
    setEnabled(next.enabled);
    setDestinationId(next.backupAccountId ?? "");
    setTiming(draftFromTiming(next, { frequency: "daily", intervalMinutes: 1440, timeOfDay: "03:00" }));
    setRetain(String(next.retainCount));
  }, []);

  const load = useCallback(async () => {
    try {
      const [next, accounts] = await Promise.all([getDbSnapshotStatus(), listBackupAccounts()]);
      applyStatus(next);
      setDestinations(accounts);
      setError(null);
    } catch (cause) {
      setError(errorText(cause));
    }
  }, [applyStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow a running snapshot until it finishes, without touching the form.
  const running = status?.lastStatus === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      getDbSnapshotStatus()
        .then((next) => {
          setStatus(next);
          if (next.lastStatus === "completed") toast.success(t.toast.dbSnapshotFinished);
          else if (next.lastStatus === "failed") toast.error(t.toast.dbSnapshotFailed, next.lastError ?? undefined);
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [running]);

  const retainNumber = Number(retain);
  const retainValid = Number.isInteger(retainNumber) && retainNumber >= 1 && retainNumber <= 365;
  const ready = timingReady(timing) && retainValid && (!enabled || Boolean(destinationId));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setFormError(null);
    try {
      applyStatus(
        await saveDbSnapshotSettings({
          enabled,
          backupAccountId: destinationId || null,
          retainCount: retainNumber,
          ...timingFromDraft(timing),
        }),
      );
      toast.success(t.toast.settingsSaved);
    } catch (cause) {
      setFormError(errorText(cause));
      toast.fromError(t.toast.settingsFailed, cause);
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (starting || running) return;
    setStarting(true);
    try {
      setStatus(await runDbSnapshotNow());
      toast.info(t.toast.dbSnapshotStarted);
    } catch (cause) {
      toast.fromError(t.toast.dbSnapshotFailed, cause);
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title className="flex items-center gap-2 text-base font-semibold">
          <DatabaseBackup className="size-5 text-accent" /> {d.cardTitle}
        </Card.Title>
        <Card.Description>{d.cardDescription}</Card.Description>
      </Card.Header>
      <Card.Content className="space-y-5">
        {error ? <ErrorAlert message={error} /> : null}
        {!status ? (
          <LoadingState label={d.loading} />
        ) : (
          <>
            {!status.passphraseConfigured ? (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>{d.noPassphraseTitle}</Alert.Title>
                  <Alert.Description>{d.noPassphraseDescription}</Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}
            {!status.schedulerEnabled ? (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{t.backupSchedule.schedulerOff}</Alert.Description>
                </Alert.Content>
              </Alert>
            ) : null}

            <form onSubmit={(event) => void save(event)} className="space-y-5">
              {formError ? <ErrorAlert message={formError} /> : null}
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">{d.enabledLabel}</legend>
                <div className="grid grid-cols-2 gap-2 sm:max-w-sm">
                  <Button fullWidth size="sm" variant={enabled ? "primary" : "outline"} onPress={() => setEnabled(true)}>
                    {d.on}
                  </Button>
                  <Button fullWidth size="sm" variant={enabled ? "outline" : "primary"} onPress={() => setEnabled(false)}>
                    {d.off}
                  </Button>
                </div>
              </fieldset>

              {destinations.length === 0 ? (
                <p className="rounded-xl border p-3 text-sm text-muted">{d.noDestinations}</p>
              ) : (
                <div className="space-y-1">
                  <Select
                    label={d.destinationLabel}
                    value={destinationId}
                    onValueChange={setDestinationId}
                    placeholder={d.pickDestination}
                    options={destinations.map((account) => ({ value: account.id, label: account.label }))}
                  />
                  <p className="text-xs text-muted">{d.destinationHelp}</p>
                </div>
              )}

              <ScheduleTimingFields value={timing} onChange={setTiming} minIntervalMinutes={status.minIntervalMinutes} />

              <TextField fullWidth className="sm:max-w-xs" value={retain} onChange={setRetain} isInvalid={!retainValid}>
                <Label>{d.retainLabel}</Label>
                <Input type="number" min={1} max={365} inputMode="numeric" />
                <Description>{d.retainHelp}</Description>
              </TextField>

              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" isDisabled={running || starting || !status.backupAccountId} onPress={() => void runNow()}>
                  <Play /> {running ? d.running : d.runNow}
                </Button>
                <Button type="submit" isDisabled={!ready || saving}>{saving ? t.backupSchedule.saving : d.save}</Button>
              </div>
            </form>

            <div className="space-y-2 rounded-xl border p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{d.lastRunLabel}</span>
                {status.lastStatus ? (
                  <Chip size="sm" variant="soft" color={STATUS_COLOR[status.lastStatus]}>{d.status[status.lastStatus]}</Chip>
                ) : (
                  <span className="text-muted">{d.never}</span>
                )}
                {status.lastFinishedAt && status.lastStatus !== "running" ? (
                  <span className="text-xs text-muted">{formatWhen(status.lastFinishedAt)}</span>
                ) : null}
              </div>
              {status.lastStatus === "failed" && status.lastError ? (
                <p className="break-words text-xs text-danger">{status.lastError}</p>
              ) : null}
              <p className="text-xs text-muted">
                {status.enabled && status.nextRunAt ? t.backupSchedule.nextRun(formatWhen(status.nextRunAt)!) : t.backupSchedule.notScheduled}
              </p>
            </div>

            {status.snapshots.length > 0 ? (
              <div className="space-y-2">
                <Label>{d.recentLabel}</Label>
                <ul className="divide-y rounded-xl border text-sm">
                  {status.snapshots.map((snapshot) => (
                    <li key={snapshot.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs" title={snapshot.archiveRef}>{snapshot.archiveName}</p>
                        <p className="text-xs text-muted">
                          {formatWhen(snapshot.createdAt)} · {humanBytes(snapshot.bytes)} · {snapshot.destinationLabel}
                        </p>
                      </div>
                      <Chip size="sm" variant="soft" color={snapshot.keyRecovery === "passphrase" ? "success" : "warning"}>
                        {snapshot.keyRecovery === "passphrase" ? d.keyRecoveryPassphrase : d.keyRecoveryNone}
                      </Chip>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p className="text-xs text-muted">{d.restoreHint}</p>
          </>
        )}
      </Card.Content>
    </Card>
  );
}
