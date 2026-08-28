// Gateway-wide backup history: every run across every bucket, and the
// per-object ledger behind one of them.
//
// The per-bucket dialog in ObjectsPage stays as it is — it answers "what
// happened to the bucket I am looking at" while you are looking at it. This
// answers the other two questions: what has this gateway backed up in total,
// and what did one particular run actually do to each object.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, FileWarning, History, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "@/components/ui/table";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import {
  getBackupRun,
  listBackupHistory,
  listBackupRunObjects,
  type BackupAccount,
  type BackupHistoryDetail,
  type BackupHistoryItem,
  type BackupObjectItem,
  type BackupTransferStatus,
  type Bucket,
} from "../api/client.ts";

const ALL = "__all__";

type StatusFilter = BackupTransferStatus | typeof ALL;
type ObjectFilter = "all" | "copied" | "failed";

/** Whole seconds between two ISO timestamps, or null if the run never
 *  started or has not finished. */
function durationSeconds(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const elapsed = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.round(elapsed / 1000) : null;
}

export function useBackupStatusLabels() {
  const { t } = useLocale();
  const label: Record<BackupTransferStatus, string> = {
    queued: t.backup.statusQueued,
    running: t.backup.statusRunning,
    cancel_requested: t.backup.statusCancelRequested,
    completed: t.backup.statusCompleted,
    cancelled: t.backup.statusCancelled,
    failed: t.backup.statusFailed,
  };
  const variant: Record<BackupTransferStatus, "default" | "secondary" | "success" | "destructive" | "warning"> = {
    queued: "secondary",
    running: "default",
    cancel_requested: "warning",
    completed: "success",
    cancelled: "secondary",
    failed: "destructive",
  };
  return { label, variant };
}

export function BackupHistory({
  accounts,
  buckets,
  accountFilter,
  onAccountFilterChange,
}: {
  accounts: BackupAccount[];
  buckets: Bucket[];
  /** Owned by the page so an account card can jump straight into its history. */
  accountFilter: string;
  onAccountFilterChange: (accountId: string) => void;
}) {
  const { t } = useLocale();
  const status = useBackupStatusLabels();

  const [items, setItems] = useState<BackupHistoryItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bucketFilter, setBucketFilter] = useState<string>(ALL);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(ALL);
  const [openRunId, setOpenRunId] = useState<string | null>(null);

  const filters = {
    accountId: accountFilter === ALL ? undefined : accountFilter,
    bucketId: bucketFilter === ALL ? undefined : bucketFilter,
    status: statusFilter === ALL ? undefined : statusFilter,
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await listBackupHistory(filters);
      setItems(page.items);
      setNextBefore(page.nextBefore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
    // The filter values are the dependency; the object literal above is rebuilt
    // every render, so depend on the primitives instead.
  }, [accountFilter, bucketFilter, statusFilter]);

  useEffect(() => { void load(); }, [load]);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await listBackupHistory({ ...filters, before: nextBefore });
      setItems((current) => [...current, ...page.items]);
      setNextBefore(page.nextBefore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = accountFilter !== ALL || bucketFilter !== ALL || statusFilter !== ALL;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t.backup.historyTitle}</h2>
          <p className="text-sm text-muted-foreground">{t.backup.historyDescription}</p>
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={loading ? "animate-spin" : ""} /> {t.backup.historyRefresh}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label>{t.backup.filterAccountLabel}</Label>
          <Select
            value={accountFilter}
            onValueChange={onAccountFilterChange}
            options={[
              { value: ALL, label: t.backup.filterAll },
              ...accounts.map((account) => ({ value: account.id, label: account.email })),
            ]}
          />
        </div>
        <div className="space-y-2">
          <Label>{t.backup.filterBucketLabel}</Label>
          <Select
            value={bucketFilter}
            onValueChange={setBucketFilter}
            options={[
              { value: ALL, label: t.backup.filterAll },
              ...buckets.map((bucket) => ({ value: bucket.id, label: bucket.name })),
            ]}
          />
        </div>
        <div className="space-y-2">
          <Label>{t.backup.filterStatusLabel}</Label>
          <Select
            value={statusFilter}
            onValueChange={(value) => setStatusFilter(value as StatusFilter)}
            options={[
              { value: ALL, label: t.backup.filterAll },
              ...(Object.keys(status.label) as BackupTransferStatus[]).map((key) => ({
                value: key,
                label: status.label[key],
              })),
            ]}
          />
        </div>
      </div>

      {error ? <ErrorAlert message={error} /> : null}

      {loading ? (
        <LoadingState label={t.backup.historyLoading} />
      ) : items.length === 0 ? (
        filtered ? (
          <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
            {t.backup.historyFilteredEmpty}
          </p>
        ) : (
          <EmptyState
            icon={History}
            title={t.backup.historyEmptyTitle}
            description={t.backup.historyEmptyDescription}
          />
        )
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.backup.tableTime}</TableHead>
                  <TableHead>{t.backup.tableBucket}</TableHead>
                  <TableHead>{t.backup.tableDestination}</TableHead>
                  <TableHead>{t.backup.tableStatus}</TableHead>
                  <TableHead>{t.backup.tableResult}</TableHead>
                  <TableHead className="text-right">{t.backup.tableActions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((run) => (
                  <TableRow key={run.id}>
                    <TableRowHeader className="whitespace-nowrap font-normal">
                      {new Date(run.createdAt).toLocaleString()}
                    </TableRowHeader>
                    <TableCell className="max-w-40 truncate">{run.bucketName}</TableCell>
                    <TableCell className="max-w-56 truncate">{run.accountEmail}</TableCell>
                    <TableCell>
                      <Badge variant={status.variant[run.status]}>{status.label[run.status]}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {t.backup.progressSummary({
                        copied: run.copied,
                        skipped: run.skipped,
                        failed: run.failed,
                        total: run.total,
                      })}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setOpenRunId(run.id)}>
                        {t.backup.viewDetail}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {nextBefore ? (
            <div className="flex justify-center">
              <Button variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? t.common.loadingMore : t.common.loadMore}
              </Button>
            </div>
          ) : null}
        </>
      )}

      <BackupRunDialog runId={openRunId} onClose={() => setOpenRunId(null)} />
    </section>
  );
}

function BackupRunDialog({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const { t } = useLocale();
  const status = useBackupStatusLabels();

  const [run, setRun] = useState<BackupHistoryDetail | null>(null);
  const [objects, setObjects] = useState<BackupObjectItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [objectFilter, setObjectFilter] = useState<ObjectFilter>("all");
  const [loading, setLoading] = useState(false);
  const [loadingObjects, setLoadingObjects] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh dialog always starts unfiltered, so reopening another run does not
  // silently inherit the previous run's "failed only" view.
  useEffect(() => { setObjectFilter("all"); }, [runId]);

  useEffect(() => {
    if (!runId) { setRun(null); setObjects([]); setNextBefore(null); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getBackupRun(runId)
      .then((detail) => { if (!cancelled) setRun(detail); })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setLoadingObjects(true);
    void listBackupRunObjects(runId, {
      status: objectFilter === "all" ? undefined : objectFilter,
    })
      .then((page) => {
        if (cancelled) return;
        setObjects(page.items);
        setNextBefore(page.nextBefore);
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (!cancelled) setLoadingObjects(false); });
    return () => { cancelled = true; };
  }, [runId, objectFilter]);

  const loadMoreObjects = async () => {
    if (!runId || !nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listBackupRunObjects(runId, {
        status: objectFilter === "all" ? undefined : objectFilter,
        before: nextBefore,
      });
      setObjects((current) => [...current, ...page.items]);
      setNextBefore(page.nextBefore);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingMore(false);
    }
  };

  const elapsed = run ? durationSeconds(run.startedAt, run.completedAt) : null;
  const ledgerTotal = run ? run.ledger.copied + run.ledger.failed : 0;
  const recorded = run ? run.copied + run.failed : 0;

  return (
    <Dialog open={Boolean(runId)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t.backup.detailTitle}</DialogTitle>
          <DialogDescription className="break-all">
            {run ? `${run.bucketName} → ${run.accountEmail}` : t.backup.detailLoading}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {error ? <ErrorAlert message={error} /> : null}
          {loading || !run ? (
            <LoadingState label={t.backup.detailLoading} />
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={t.backup.tableStatus}>
                  <Badge variant={status.variant[run.status]}>{status.label[run.status]}</Badge>
                </Field>
                <Field label={t.backup.detailStarted}>
                  {run.startedAt ? new Date(run.startedAt).toLocaleString() : t.backup.detailNotStarted}
                </Field>
                <Field label={t.backup.detailFinished}>
                  {run.completedAt ? new Date(run.completedAt).toLocaleString() : t.backup.detailStillRunning}
                </Field>
                <Field label={t.backup.detailDuration}>
                  {elapsed === null ? t.backup.detailStillRunning : t.backup.durationLabel(elapsed)}
                </Field>
                <Field label={t.backup.tableResult} className="sm:col-span-2">
                  {t.backup.progressSummary({
                    copied: run.copied,
                    skipped: run.skipped,
                    failed: run.failed,
                    total: run.total,
                  })}
                </Field>
              </div>

              {run.lastError ? <ErrorAlert message={run.lastError} /> : null}

              {ledgerTotal < recorded ? (
                <Alert>
                  <FileWarning />
                  <AlertTitle>{t.backup.ledgerNoteTitle}</AlertTitle>
                  <AlertDescription>
                    {t.backup.ledgerNote({ owned: ledgerTotal, recorded })}
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label>{t.backup.objectsLabel}</Label>
                  <div className="flex gap-1">
                    {(["all", "copied", "failed"] as const).map((option) => (
                      <Button
                        key={option}
                        size="sm"
                        variant={objectFilter === option ? "default" : "ghost"}
                        onClick={() => setObjectFilter(option)}
                      >
                        {option === "all"
                          ? t.backup.objectsFilterAll
                          : option === "copied"
                            ? t.backup.objectsFilterCopied
                            : t.backup.objectsFilterFailed}
                      </Button>
                    ))}
                  </div>
                </div>

                {loadingObjects ? (
                  <LoadingState label={t.backup.objectsLoading} />
                ) : objects.length === 0 ? (
                  <p className="rounded-md border p-4 text-sm text-muted-foreground">
                    {t.backup.objectsEmpty}
                  </p>
                ) : (
                  <>
                    <div className="max-h-80 overflow-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t.backup.objectKey}</TableHead>
                            <TableHead>{t.backup.objectStatus}</TableHead>
                            <TableHead className="text-right">{t.backup.objectAttempts}</TableHead>
                            <TableHead>{t.backup.objectDetail}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {objects.map((object) => (
                            <TableRow key={object.objectId}>
                              <TableRowHeader className="max-w-64 truncate font-normal">
                                {object.objectKey}
                              </TableRowHeader>
                              <TableCell>
                                {object.status === "copied" ? (
                                  <Badge variant="success" className="gap-1">
                                    <CheckCircle2 className="size-3" aria-hidden="true" />
                                    {t.backup.objectStatusCopied}
                                  </Badge>
                                ) : (
                                  <Badge variant="destructive">{t.backup.objectStatusFailed}</Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{object.attempts}</TableCell>
                              <TableCell className="max-w-72 break-words text-xs text-muted-foreground">
                                {object.status === "failed"
                                  ? object.lastError
                                  : object.destinationFileId
                                    ? t.backup.objectDestinationFile(object.destinationFileId)
                                    : null}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    {nextBefore ? (
                      <div className="flex justify-center">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={loadingMore}
                          onClick={() => void loadMoreObjects()}
                        >
                          {loadingMore ? t.common.loadingMore : t.common.loadMore}
                        </Button>
                      </div>
                    ) : null}
                  </>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {t.backup.detailRunId}: <span className="font-mono break-all">{run.id}</span>
              </p>
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t.common.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1 rounded-md border p-3 ${className ?? ""}`}>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}
