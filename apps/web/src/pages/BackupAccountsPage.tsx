import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  CloudCog,
  Copy,
  Database,
  HardDrive,
  HardDriveDownload,
  History,
  Pencil,
  PlugZap,
  Plus,
  Server,
  ShieldAlert,
  SkipForward,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Alert, AlertDialog, Button, Card, Chip, Description, Dropdown, Label, Tooltip } from "@heroui/react";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import { BackupHistory, useBackupStatusLabels } from "@/components/backup-history";
import { BackupSchedulesSection } from "@/components/backup-schedules";
import {
  DESTINATION_ICON,
  destinationLocation,
  EditDestinationDialog,
  RcloneDestinationDialog,
  S3DestinationDialog,
} from "@/components/backup-destination-dialogs";
import { useLocale } from "@/components/locale-provider";
import { useToast } from "@/components/toast-provider";
import { cn } from "@/lib/utils";
import {
  deleteBackupAccount,
  getBackupDestinationOptions,
  getBackupScheduleOptions,
  getBackupSummary,
  listBackupAccounts,
  listBuckets,
  startBackupAccountLink,
  testBackupDestination,
  type BackupAccount,
  type BackupDestinationKind,
  type BackupDestinationOptions,
  type BackupScheduleOptions,
  type BackupSummary,
  type Bucket,
} from "../api/client.ts";

const ALL_ACCOUNTS = "__all__";

function readAndClearLinkFeedback(): { linked: boolean; error: string | null } {
  const params = new URLSearchParams(window.location.search);
  const linked = params.get("linked") === "1";
  const error = params.get("link_error");
  if (linked || error) {
    window.history.replaceState(null, "", window.location.pathname);
  }
  return { linked, error };
}

export function BackupAccountsPage() {
  const { t } = useLocale();
  const toast = useToast();
  const runStatus = useBackupStatusLabels();
  const STATUS_LABEL: Record<BackupAccount["status"], string> = {
    active: t.backup.statusActive,
    reauthorization_required: t.backup.statusReauthRequired,
    error: t.backup.statusError,
  };
  const STATUS_COLOR: Record<BackupAccount["status"], "success" | "warning" | "danger"> = {
    active: "success",
    reauthorization_required: "warning",
    error: "danger",
  };

  const [accounts, setAccounts] = useState<BackupAccount[]>([]);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [summary, setSummary] = useState<BackupSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkedMessage, setLinkedMessage] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupAccount | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [accountFilter, setAccountFilter] = useState<string>(ALL_ACCOUNTS);
  const [options, setOptions] = useState<BackupDestinationOptions | null>(null);
  const [scheduleOptions, setScheduleOptions] = useState<BackupScheduleOptions | null>(null);
  const [adding, setAdding] = useState<"s3" | "rclone" | null>(null);
  const [editTarget, setEditTarget] = useState<BackupAccount | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const KIND_LABEL: Record<BackupDestinationKind, string> = {
    drive: t.backup.kindDrive,
    s3: t.backup.kindS3,
    rclone: t.backup.kindRclone,
  };

  const load = useCallback(async () => {
    setError(null);
    try {
      // The bucket list only feeds the history filter, and a viewer-role
      // bucket can never appear in it, so a failure there must not take the
      // whole page down with it. The same goes for the destination options,
      // which only decide what the "Add destination" menu offers.
      const [nextAccounts, nextSummary, nextBuckets, nextOptions, nextScheduleOptions] = await Promise.all([
        listBackupAccounts(),
        getBackupSummary(),
        listBuckets().catch(() => [] as Bucket[]),
        getBackupDestinationOptions().catch(() => null),
        getBackupScheduleOptions().catch(() => null),
      ]);
      setAccounts(nextAccounts);
      setSummary(nextSummary);
      setBuckets(nextBuckets.filter((bucket) => bucket.ownedByMe));
      setOptions(nextOptions);
      setScheduleOptions(nextScheduleOptions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const feedback = readAndClearLinkFeedback();
    setLinkedMessage(feedback.linked);
    setLinkError(feedback.error);
    if (feedback.linked) toast.success(t.toast.backupAccountLinked, t.backup.linkedDescription);
    if (feedback.error) toast.error(t.backup.linkErrorTitle, feedback.error);
    void load();
  }, [load]);

  const doDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      const removed = deleteTarget.label;
      await deleteBackupAccount(deleteTarget.id);
      // The history is filtered by an id that no longer exists; fall back to
      // showing everything rather than an empty table.
      if (accountFilter === deleteTarget.id) setAccountFilter(ALL_ACCOUNTS);
      setDeleteTarget(null);
      toast.success(t.toast.backupAccountRemoved(removed));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.backupAccountRemoveFailed, cause);
    } finally {
      setDeleting(false);
    }
  };

  const doTest = async (account: BackupAccount) => {
    if (testingId) return;
    setTestingId(account.id);
    try {
      const result = await testBackupDestination(account.id);
      if (result.healthy) toast.success(t.toast.backupDestinationHealthy(account.label));
      else toast.error(t.toast.backupDestinationUnhealthy(account.label), result.error ?? undefined);
      await load();
    } catch (cause) {
      toast.fromError(t.toast.backupDestinationUnhealthy(account.label), cause);
    } finally {
      setTestingId(null);
    }
  };

  const onDestinationAdded = async (account: BackupAccount) => {
    setAdding(null);
    toast.success(t.toast.backupDestinationAdded(account.label));
    await load();
  };

  const onDestinationEdited = async () => {
    setEditTarget(null);
    toast.success(t.toast.backupDestinationUpdated);
    await load();
  };

  const rcloneEnabled = Boolean(options && options.rclone.remotes.length > 0);

  if (loading) return <LoadingState label={t.backup.loading} />;

  const totals = summary?.totals;
  const statCards: Array<{ label: string; value: number; icon: typeof Copy; tone: string }> = [
    { label: t.backup.statRuns, value: totals?.runs ?? 0, icon: History, tone: "text-accent-soft-foreground bg-accent-soft" },
    { label: t.backup.statCopied, value: totals?.copied ?? 0, icon: Copy, tone: "text-success bg-success-soft" },
    { label: t.backup.statSkipped, value: totals?.skipped ?? 0, icon: SkipForward, tone: "text-muted bg-default" },
    { label: t.backup.statFailed, value: totals?.failed ?? 0, icon: TriangleAlert, tone: "text-danger bg-danger-soft" },
  ];

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      {linkedMessage ? (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.backup.linkedTitle}</Alert.Title>
            <Alert.Description>{t.backup.linkedDescription}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {linkError ? (
        <Alert status="danger">
          <Alert.Indicator><ShieldAlert /></Alert.Indicator>
          <Alert.Content>
            <Alert.Title>{t.backup.linkErrorTitle}</Alert.Title>
            <Alert.Description>{decodeURIComponent(linkError)}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <Alert status="accent">
        <Alert.Indicator><CloudCog /></Alert.Indicator>
        <Alert.Content>
          <Alert.Title>{t.backup.infoTitle}</Alert.Title>
          <Alert.Description>{t.backup.infoDescription}</Alert.Description>
        </Alert.Content>
      </Alert>

      <div className="flex justify-end">
        <Dropdown>
          <Button aria-label={t.backup.addDestination}>
            <Plus /> {t.backup.addDestination} <ChevronDown className="size-4" aria-hidden="true" />
          </Button>
          <Dropdown.Popover placement="bottom end" className="min-w-72">
            <Dropdown.Menu
              aria-label={t.backup.addDestinationMenu}
              disabledKeys={rcloneEnabled ? [] : ["rclone"]}
              onAction={(key) => {
                if (key === "drive") startBackupAccountLink();
                else if (key === "s3" || key === "rclone") setAdding(key);
              }}
            >
              <Dropdown.Item id="drive" textValue={t.backup.addDrive}>
                <HardDrive className="size-4 shrink-0" />
                <div className="flex flex-col">
                  <Label>{t.backup.addDrive}</Label>
                  <Description>{t.backup.addDriveHelp}</Description>
                </div>
              </Dropdown.Item>
              <Dropdown.Item id="s3" textValue={t.backup.addS3}>
                <Database className="size-4 shrink-0" />
                <div className="flex flex-col">
                  <Label>{t.backup.addS3}</Label>
                  <Description>{t.backup.addS3Help}</Description>
                </div>
              </Dropdown.Item>
              <Dropdown.Item id="rclone" textValue={t.backup.addRclone}>
                <Server className="size-4 shrink-0" />
                <div className="flex flex-col">
                  <Label>{t.backup.addRclone}</Label>
                  <Description>{rcloneEnabled ? t.backup.addRcloneHelp : t.backup.rcloneNotEnabled}</Description>
                </div>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          icon={HardDriveDownload}
          title={t.backup.emptyTitle}
          description={t.backup.emptyDescription}
        />
      ) : (
        <>
          <section aria-label={t.backup.historyTitle} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {statCards.map(({ label, value, icon: Icon, tone }) => (
              <Card key={label}>
                <Card.Header className="flex-row items-center justify-between gap-3">
                  <Card.Description>{label}</Card.Description>
                  <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", tone)}>
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                </Card.Header>
                <Card.Content><p className="text-3xl font-bold tabular-nums">{value}</p></Card.Content>
              </Card>
            ))}
          </section>

          <div className="grid gap-4 sm:grid-cols-2">
            {accounts.map((account) => {
              const stats = summary?.accounts.find((a) => a.backupAccountId === account.id);
              const KindIcon = DESTINATION_ICON[account.kind];
              const location = destinationLocation(account);
              const isDrive = account.kind === "drive";
              return (
                <Card key={account.id}>
                  <Card.Header className="flex-row items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Card.Title className="truncate text-base font-semibold" title={account.label}>{account.label}</Card.Title>
                      <Card.Description>
                        {isDrive
                          ? t.backup.connectedAt(new Date(account.createdAt).toLocaleString())
                          : t.backup.addedAt(new Date(account.createdAt).toLocaleString())}
                      </Card.Description>
                      {location ? <p className="mt-1 truncate font-mono text-xs text-muted" title={location}>{location}</p> : null}
                    </div>
                    <div className="flex shrink-0 items-center">
                      <Tooltip delay={300}>
                        <Button
                          isIconOnly
                          size="sm"
                          variant="ghost"
                          aria-label={t.backup.testLabel(account.label)}
                          isDisabled={testingId !== null}
                          onPress={() => void doTest(account)}
                        >
                          <PlugZap className={cn(testingId === account.id && "animate-pulse")} />
                        </Button>
                        <Tooltip.Content>{t.backup.testTooltip}</Tooltip.Content>
                      </Tooltip>
                      {!isDrive ? (
                        <Tooltip delay={300}>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="ghost"
                            aria-label={t.backup.editLabel(account.label)}
                            onPress={() => setEditTarget(account)}
                          >
                            <Pencil />
                          </Button>
                          <Tooltip.Content>{t.backup.editTooltip}</Tooltip.Content>
                        </Tooltip>
                      ) : null}
                      <Button
                        isIconOnly
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        aria-label={isDrive ? t.backup.disconnectLabel(account.label) : t.backup.deleteLabel(account.label)}
                        onPress={() => setDeleteTarget(account)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </Card.Header>
                  <Card.Content className="gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip variant="tertiary" size="sm" className="border">
                        <KindIcon className="size-3" aria-hidden="true" />
                        <Chip.Label>{KIND_LABEL[account.kind]}</Chip.Label>
                      </Chip>
                      <Chip color={STATUS_COLOR[account.status]} variant="soft" size="sm">{STATUS_LABEL[account.status]}</Chip>
                      {stats && stats.runs > 0 ? (
                        <Chip variant="tertiary" size="sm" className="border">{t.backup.accountRunsLabel(stats.runs)}</Chip>
                      ) : null}
                      {stats?.lastStatus ? (
                        <Chip color={runStatus.color[stats.lastStatus]} variant="soft" size="sm">
                          {runStatus.label[stats.lastStatus]}
                        </Chip>
                      ) : null}
                    </div>

                    <dl className="space-y-1 text-xs text-muted">
                      <div className="flex items-center gap-1.5">
                        <History className="size-3.5 shrink-0" aria-hidden="true" />
                        <span>
                          {stats?.lastRunAt
                            ? t.backup.accountLastRun(new Date(stats.lastRunAt).toLocaleString())
                            : t.backup.accountNeverRun}
                        </span>
                      </div>
                      {stats && stats.objectsOnRecord > 0 ? (
                        <div className="flex items-center gap-1.5">
                          <CheckCircle2 className="size-3.5 shrink-0 text-success" aria-hidden="true" />
                          <span>{t.backup.accountObjectsOnRecord(stats.objectsOnRecord)}</span>
                        </div>
                      ) : null}
                      {stats && stats.failedTotal > 0 ? (
                        <div className="flex items-center gap-1.5">
                          <TriangleAlert className="size-3.5 shrink-0 text-danger" aria-hidden="true" />
                          <span>{t.backup.statFailed}: {stats.failedTotal}</span>
                        </div>
                      ) : null}
                    </dl>

                    {account.status === "reauthorization_required" ? (
                      <p className="text-xs text-muted">{t.backup.reauthHint}</p>
                    ) : null}
                    {account.status === "error" && !isDrive ? (
                      <p className="text-xs text-muted">{t.backup.errorHint}</p>
                    ) : null}
                    {account.lastError ? <p className="text-xs text-danger">{account.lastError}</p> : null}

                    {stats && stats.runs > 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onPress={() => setAccountFilter(account.id)}
                        isDisabled={accountFilter === account.id}
                      >
                        <History /> {t.backup.viewAccountHistory}
                      </Button>
                    ) : null}
                  </Card.Content>
                </Card>
              );
            })}
          </div>

          <BackupSchedulesSection
            buckets={buckets}
            destinations={accounts}
            options={scheduleOptions}
            reloadKey={accounts}
          />

          {accountFilter !== ALL_ACCOUNTS ? (
            <Alert>
              <Alert.Indicator><History /></Alert.Indicator>
              <Alert.Content>
                <Alert.Title>
                  {t.backup.filteredByAccount(
                    accounts.find((a) => a.id === accountFilter)?.label ?? accountFilter,
                  )}
                </Alert.Title>
                <Button size="sm" variant="outline" className="mt-2" onPress={() => setAccountFilter(ALL_ACCOUNTS)}>
                  {t.backup.clearAccountFilter}
                </Button>
              </Alert.Content>
            </Alert>
          ) : null}

          <BackupHistory
            accounts={accounts}
            buckets={buckets}
            accountFilter={accountFilter}
            onAccountFilterChange={setAccountFilter}
          />
        </>
      )}

      <AlertDialog.Backdrop isOpen={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>{t.backup.disconnectConfirmTitle}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>
                <span className="break-all font-medium text-foreground">{deleteTarget?.label}</span> {t.backup.disconnectConfirmDescription}
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={deleting}>{t.common.cancel}</Button>
              <Button variant="danger" isDisabled={deleting} onPress={() => void doDelete()}>
                {deleteTarget?.kind === "drive"
                  ? deleting ? t.backup.disconnecting : t.backup.disconnect
                  : deleting ? t.backup.removing : t.backup.remove}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <S3DestinationDialog
        isOpen={adding === "s3"}
        onOpenChange={(open) => setAdding(open ? "s3" : null)}
        onSaved={(account) => void onDestinationAdded(account)}
      />
      {options ? (
        <RcloneDestinationDialog
          isOpen={adding === "rclone"}
          onOpenChange={(open) => setAdding(open ? "rclone" : null)}
          onSaved={(account) => void onDestinationAdded(account)}
          options={options.rclone}
        />
      ) : null}
      <EditDestinationDialog
        account={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={() => void onDestinationEdited()}
      />
    </div>
  );
}
