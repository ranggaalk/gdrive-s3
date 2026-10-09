import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  CloudCog,
  Copy,
  HardDriveDownload,
  History,
  Plus,
  ShieldAlert,
  SkipForward,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Alert, AlertDialog, Button, Card, Chip } from "@heroui/react";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import { BackupHistory, useBackupStatusLabels } from "@/components/backup-history";
import { useLocale } from "@/components/locale-provider";
import { useToast } from "@/components/toast-provider";
import { cn } from "@/lib/utils";
import {
  deleteBackupAccount,
  getBackupSummary,
  listBackupAccounts,
  listBuckets,
  startBackupAccountLink,
  type BackupAccount,
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

  const load = useCallback(async () => {
    setError(null);
    try {
      // The bucket list only feeds the history filter, and a viewer-role
      // bucket can never appear in it, so a failure there must not take the
      // whole page down with it.
      const [nextAccounts, nextSummary, nextBuckets] = await Promise.all([
        listBackupAccounts(),
        getBackupSummary(),
        listBuckets().catch(() => [] as Bucket[]),
      ]);
      setAccounts(nextAccounts);
      setSummary(nextSummary);
      setBuckets(nextBuckets.filter((bucket) => bucket.ownedByMe));
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
      const removed = deleteTarget.email;
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
        <Button onPress={() => startBackupAccountLink()}><Plus /> {t.backup.connectButton}</Button>
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
              return (
                <Card key={account.id}>
                  <Card.Header className="flex-row items-start justify-between gap-3">
                    <div className="min-w-0">
                      <Card.Title className="truncate text-base font-semibold">{account.email}</Card.Title>
                      <Card.Description>{t.backup.connectedAt(new Date(account.createdAt).toLocaleString())}</Card.Description>
                    </div>
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      className="shrink-0 text-danger"
                      aria-label={t.backup.disconnectLabel(account.email)}
                      onPress={() => setDeleteTarget(account)}
                    >
                      <Trash2 />
                    </Button>
                  </Card.Header>
                  <Card.Content className="gap-3">
                    <div className="flex flex-wrap items-center gap-2">
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

          {accountFilter !== ALL_ACCOUNTS ? (
            <Alert>
              <Alert.Indicator><History /></Alert.Indicator>
              <Alert.Content>
                <Alert.Title>
                  {t.backup.filteredByAccount(
                    accounts.find((a) => a.id === accountFilter)?.email ?? accountFilter,
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
                <span className="break-all font-medium text-foreground">{deleteTarget?.email}</span> {t.backup.disconnectConfirmDescription}
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={deleting}>{t.common.cancel}</Button>
              <Button variant="danger" isDisabled={deleting} onPress={() => void doDelete()}>
                {deleting ? t.backup.disconnecting : t.backup.disconnect}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  );
}
