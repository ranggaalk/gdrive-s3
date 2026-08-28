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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  const STATUS_VARIANT: Record<BackupAccount["status"], "success" | "warning" | "destructive"> = {
    active: "success",
    reauthorization_required: "warning",
    error: "destructive",
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
    { label: t.backup.statRuns, value: totals?.runs ?? 0, icon: History, tone: "text-primary bg-primary/10" },
    { label: t.backup.statCopied, value: totals?.copied ?? 0, icon: Copy, tone: "text-success bg-success/10" },
    { label: t.backup.statSkipped, value: totals?.skipped ?? 0, icon: SkipForward, tone: "text-muted-foreground bg-muted" },
    { label: t.backup.statFailed, value: totals?.failed ?? 0, icon: TriangleAlert, tone: "text-destructive bg-destructive/10" },
  ];

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      {linkedMessage ? (
        <Alert variant="success"><AlertTitle>{t.backup.linkedTitle}</AlertTitle><AlertDescription>{t.backup.linkedDescription}</AlertDescription></Alert>
      ) : null}
      {linkError ? (
        <Alert variant="destructive"><ShieldAlert /><AlertTitle>{t.backup.linkErrorTitle}</AlertTitle><AlertDescription>{decodeURIComponent(linkError)}</AlertDescription></Alert>
      ) : null}

      <Alert>
        <CloudCog />
        <AlertTitle>{t.backup.infoTitle}</AlertTitle>
        <AlertDescription>{t.backup.infoDescription}</AlertDescription>
      </Alert>

      <div className="flex justify-end">
        <Button onClick={() => startBackupAccountLink()}><Plus /> {t.backup.connectButton}</Button>
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
              <Card key={label} className="border-border/60 shadow-sm">
                <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                  <CardDescription>{label}</CardDescription>
                  <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", tone)}>
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                </CardHeader>
                <CardContent><p className="text-3xl font-bold tabular-nums">{value}</p></CardContent>
              </Card>
            ))}
          </section>

          <div className="grid gap-4 sm:grid-cols-2">
            {accounts.map((account) => {
              const stats = summary?.accounts.find((a) => a.backupAccountId === account.id);
              return (
                <Card key={account.id}>
                  <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-base">{account.email}</CardTitle>
                      <CardDescription>{t.backup.connectedAt(new Date(account.createdAt).toLocaleString())}</CardDescription>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="shrink-0 text-destructive hover:text-destructive"
                      aria-label={t.backup.disconnectLabel(account.email)}
                      onClick={() => setDeleteTarget(account)}
                    >
                      <Trash2 />
                    </Button>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={STATUS_VARIANT[account.status]}>{STATUS_LABEL[account.status]}</Badge>
                      {stats && stats.runs > 0 ? (
                        <Badge variant="outline">{t.backup.accountRunsLabel(stats.runs)}</Badge>
                      ) : null}
                      {stats?.lastStatus ? (
                        <Badge variant={runStatus.variant[stats.lastStatus]}>
                          {runStatus.label[stats.lastStatus]}
                        </Badge>
                      ) : null}
                    </div>

                    <dl className="space-y-1 text-xs text-muted-foreground">
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
                          <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
                          <span>{t.backup.statFailed}: {stats.failedTotal}</span>
                        </div>
                      ) : null}
                    </dl>

                    {account.status === "reauthorization_required" ? (
                      <p className="text-xs text-muted-foreground">{t.backup.reauthHint}</p>
                    ) : null}
                    {account.lastError ? <p className="text-xs text-destructive">{account.lastError}</p> : null}

                    {stats && stats.runs > 0 ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setAccountFilter(account.id)}
                        disabled={accountFilter === account.id}
                      >
                        <History /> {t.backup.viewAccountHistory}
                      </Button>
                    ) : null}
                  </CardContent>
                </Card>
              );
            })}
          </div>

          {accountFilter !== ALL_ACCOUNTS ? (
            <Alert>
              <History />
              <AlertTitle>
                {t.backup.filteredByAccount(
                  accounts.find((a) => a.id === accountFilter)?.email ?? accountFilter,
                )}
              </AlertTitle>
              {/* AlertTitle's own mb-1 is sized for a paragraph; a button
                  needs more room than that. */}
              <AlertDescription className="mt-2">
                <Button size="sm" variant="outline" onClick={() => setAccountFilter(ALL_ACCOUNTS)}>
                  {t.backup.clearAccountFilter}
                </Button>
              </AlertDescription>
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

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.backup.disconnectConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              <span className="font-medium text-foreground">{deleteTarget?.email}</span> {t.backup.disconnectConfirmDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={(event) => { event.preventDefault(); void doDelete(); }}
            >
              {deleting ? t.backup.disconnecting : t.backup.disconnect}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
