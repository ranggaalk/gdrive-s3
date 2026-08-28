import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Gauge, HardDrive, Info, RefreshCw, Users } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableRowHeader } from "@/components/ui/table";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { humanBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getDriveQuota, type DriveQuota, type DriveQuotaRow } from "../api/client.ts";

/** Colour the bar by headroom, so a quota about to run out reads at a glance. */
function toneFor(ratio: number | null): string {
  if (ratio === null) return "bg-muted-foreground/30";
  if (ratio >= 0.9) return "bg-destructive";
  if (ratio >= 0.7) return "bg-warning";
  return "bg-success";
}

function UsageBar({ ratio }: { ratio: number | null }) {
  const percent = ratio === null ? 0 : Math.min(100, Math.round(ratio * 100));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="presentation">
      <div className={cn("h-full rounded-full transition-all", toneFor(ratio))} style={{ width: `${percent}%` }} />
    </div>
  );
}

export function DriveQuotaPage() {
  const { t, locale } = useLocale();
  const [quota, setQuota] = useState<DriveQuota | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const numberFormat = new Intl.NumberFormat(locale === "id" ? "id-ID" : "en-US");
  const timeFormat = (iso: string) => new Date(iso).toLocaleString(locale === "id" ? "id-ID" : "en-US");

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    setError(null);
    try {
      setQuota(await getDriveQuota());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <LoadingState label={t.quota.loading} />;
  if (!quota) return <ErrorAlert message={error ?? t.quota.loadFailed} />;

  const scopeLabel: Record<DriveQuotaRow["scope"], string> = {
    project: t.quota.scopeProject,
    user: t.quota.scopeUser,
    other: t.quota.scopeOther,
  };
  const kindLabel = { api: t.quota.kindApi, upload: t.quota.kindUpload, download: t.quota.kindDownload };
  const { observed, storage, live, concurrency } = quota;

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}

      <div className="flex justify-end">
        <Button variant="outline" disabled={refreshing} onClick={() => void load(true)}>
          <RefreshCw className={refreshing ? "animate-spin" : ""} />
          {refreshing ? t.quota.refreshing : t.quota.refresh}
        </Button>
      </div>

      {/* Google's own figures come first: they are the only ones that answer
          "how much is left?" without inference. */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2"><Gauge className="size-5 text-primary" aria-hidden="true" />{t.quota.liveTitle}</CardTitle>
              <CardDescription>{t.quota.liveDescription}</CardDescription>
            </div>
            {live.rows ? <Badge variant="secondary">{t.quota.liveProject(live.projectId)}</Badge> : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {live.rows ? (
            <>
              <Table containerClassName="p-0">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.quota.liveTableMetric}</TableHead>
                    <TableHead>{t.quota.liveTableScope}</TableHead>
                    <TableHead className="text-right">{t.quota.liveTableLimit}</TableHead>
                    <TableHead className="text-right">{t.quota.liveTableConsumed}</TableHead>
                    <TableHead className="text-right">{t.quota.liveTableRemaining}</TableHead>
                    <TableHead className="w-32" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {live.rows.map((row) => (
                    <TableRow key={`${row.metric}:${row.unit}`}>
                      <TableRowHeader>
                        <span className="block">{row.displayName}</span>
                        <span className="block text-xs font-normal text-muted-foreground">{row.unit}</span>
                      </TableRowHeader>
                      <TableCell>{scopeLabel[row.scope]}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.limit === null ? t.quota.unlimited : numberFormat.format(row.limit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.consumed === null ? (
                          <span className="text-muted-foreground" title={t.quota.unknownHint}>{t.quota.unknown}</span>
                        ) : numberFormat.format(row.consumed)}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {row.remaining === null ? (
                          <span className="font-normal text-muted-foreground">{t.quota.unknown}</span>
                        ) : numberFormat.format(row.remaining)}
                      </TableCell>
                      <TableCell><UsageBar ratio={row.usedRatio} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-xs text-muted-foreground">
                {live.sampledAt ? `${t.quota.liveSampledAt(timeFormat(live.sampledAt))} — ` : ""}
                {t.quota.liveLagNote}
              </p>
            </>
          ) : (
            <Alert variant={live.configured ? "destructive" : "default"}>
              {live.configured ? <AlertTriangle /> : <Info />}
              <AlertTitle>{live.configured ? t.quota.liveFailedTitle : t.quota.notConfiguredTitle}</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{live.configured ? live.error : t.quota.notConfiguredBody}</p>
                {live.configured ? null : (
                  <ol className="list-decimal space-y-1 pl-5">
                    {t.quota.notConfiguredSteps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                )}
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.quota.observedTitle}</CardTitle>
          <CardDescription>{t.quota.observedDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {observed.windows.map((window) => (
              <div key={window.windowSeconds} className="rounded-xl border border-border/60 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t.quota.windowLabel(window.windowSeconds)}
                </p>
                <p className="mt-1 text-3xl font-bold tabular-nums">{numberFormat.format(window.requests)}</p>
                <p className="text-xs text-muted-foreground">{t.quota.perMinuteUnit(window.perMinute)}</p>
                <dl className="mt-3 space-y-1 text-xs">
                  {(["api", "upload", "download"] as const).map((kind) => (
                    <div key={kind} className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">{kindLabel[kind]}</dt>
                      <dd className="tabular-nums">{numberFormat.format(window.byKind[kind])}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between gap-2 border-t border-border/60 pt-1">
                    <dt className="text-muted-foreground">{t.quota.windowThrottled}</dt>
                    <dd className={cn("tabular-nums", window.throttled > 0 && "font-semibold text-destructive")}>
                      {numberFormat.format(window.throttled)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">{t.quota.windowErrors}</dt>
                    <dd className="tabular-nums">{numberFormat.format(window.errors)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {t.quota.observedSince(timeFormat(observed.since))} — {t.quota.observedScopeNote}
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><HardDrive className="size-5 text-primary" aria-hidden="true" />{t.quota.storageTitle}</CardTitle>
            <CardDescription>{t.quota.storageDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {storage === null ? (
              <Alert variant="warning">
                <AlertTriangle />
                <AlertDescription>{t.quota.storageFailed(quota.storageError ?? "")}</AlertDescription>
              </Alert>
            ) : storage.limitBytes === null ? (
              <p className="text-sm text-muted-foreground">{t.quota.storageUnlimited}</p>
            ) : (
              <>
                <UsageBar ratio={storage.usedRatio} />
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-muted-foreground">{t.quota.storageUsed}</dt><dd className="font-semibold tabular-nums">{humanBytes(storage.usageBytes)}</dd></div>
                  <div><dt className="text-muted-foreground">{t.quota.storageRemaining}</dt><dd className="font-semibold tabular-nums">{humanBytes(storage.remainingBytes ?? 0)}</dd></div>
                  <div><dt className="text-muted-foreground">{t.quota.storageLimit}</dt><dd className="tabular-nums">{humanBytes(storage.limitBytes)}</dd></div>
                  <div><dt className="text-muted-foreground">{t.quota.storageTrash}</dt><dd className="tabular-nums">{humanBytes(storage.usageInDriveTrashBytes)}</dd></div>
                </dl>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.quota.throttleTitle}</CardTitle>
            <CardDescription>{t.quota.throttleDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            {observed.recentThrottles.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.quota.throttleEmpty}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {observed.recentThrottles.slice(0, 8).map((event) => (
                  <li key={`${event.at}:${event.reason}`} className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border/60 px-3 py-2">
                    <span className="font-medium">{event.reason ?? `HTTP ${event.status}`}</span>
                    <span className="text-xs text-muted-foreground">
                      {timeFormat(event.at)} — {event.retryAfterMs === null
                        ? t.quota.throttleNoRetryAfter
                        : t.quota.throttleRetryAfter(Math.round(event.retryAfterMs / 1000))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {quota.canSeeUsers ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Users className="size-5 text-primary" aria-hidden="true" />{t.quota.usersTitle}</CardTitle>
            <CardDescription>{t.quota.usersDescription}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {observed.users.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted-foreground">{t.quota.usersEmpty}</p>
            ) : (
              <Table containerClassName="rounded-none bg-transparent p-0">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.quota.usersTableUser}</TableHead>
                    <TableHead className="text-right">{t.quota.usersTableRequests}</TableHead>
                    <TableHead className="text-right">{t.quota.usersTableThrottled}</TableHead>
                    <TableHead>{t.quota.usersTableLast}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {observed.users.map((user) => (
                    <TableRow key={user.userId}>
                      <TableRowHeader>{user.email ?? user.userId}</TableRowHeader>
                      <TableCell className="text-right tabular-nums">{numberFormat.format(user.requestsLastHour)}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", user.throttledLastHour > 0 && "font-semibold text-destructive")}>
                        {numberFormat.format(user.throttledLastHour)}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{timeFormat(user.lastCallAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t.quota.concurrencyTitle}</CardTitle>
          <CardDescription>{t.quota.concurrencyDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: t.quota.concurrencyUploads, value: concurrency.uploadsPerUser },
              { label: t.quota.concurrencyDownloads, value: concurrency.downloadsPerUser },
              { label: t.quota.concurrencyApi, value: concurrency.apiRequestsPerUser },
              { label: t.quota.concurrencyRetries, value: concurrency.retryMaxAttempts },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-border/60 p-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{item.label}</dt>
                <dd className="mt-1 text-2xl font-bold tabular-nums">{item.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
