import { useCallback, useEffect, useState } from "react";
import { Gauge, HardDrive, RefreshCw, Users } from "lucide-react";
import { Alert, Button, Card, Chip, Table } from "@heroui/react";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { humanBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getDriveQuota, type DriveQuota, type DriveQuotaRow } from "../api/client.ts";

/** Colour the bar by headroom, so a quota about to run out reads at a glance. */
function toneFor(ratio: number | null): string {
  if (ratio === null) return "bg-muted/30";
  if (ratio >= 0.9) return "bg-danger";
  if (ratio >= 0.7) return "bg-warning";
  return "bg-success";
}

function UsageBar({ ratio }: { ratio: number | null }) {
  const percent = ratio === null ? 0 : Math.min(100, Math.round(ratio * 100));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-default" role="presentation">
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
        <Button variant="outline" isDisabled={refreshing} onPress={() => void load(true)}>
          <RefreshCw className={refreshing ? "animate-spin" : ""} />
          {refreshing ? t.quota.refreshing : t.quota.refresh}
        </Button>
      </div>

      {/* Google's own figures come first: they are the only ones that answer
          "how much is left?" without inference. */}
      <Card>
        <Card.Header>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <Card.Title className="flex items-center gap-2 text-base font-semibold"><Gauge className="size-5 text-accent" aria-hidden="true" />{t.quota.liveTitle}</Card.Title>
              <Card.Description>{t.quota.liveDescription}</Card.Description>
            </div>
            {live.rows ? <Chip>{t.quota.liveProject(live.projectId)}</Chip> : null}
          </div>
        </Card.Header>
        <Card.Content className="space-y-4">
          {live.rows ? (
            <>
              <Table>
                <Table.ScrollContainer>
                  <Table.Content aria-label={t.quota.liveTitle}>
                    <Table.Header>
                      <Table.Column isRowHeader>{t.quota.liveTableMetric}</Table.Column>
                      <Table.Column>{t.quota.liveTableScope}</Table.Column>
                      <Table.Column className="text-end">{t.quota.liveTableLimit}</Table.Column>
                      <Table.Column className="text-end">{t.quota.liveTableConsumed}</Table.Column>
                      <Table.Column className="text-end">{t.quota.liveTableRemaining}</Table.Column>
                      {/* The bar repeats "used" as a picture; name the column for
                          screen readers without printing the word twice. */}
                      <Table.Column className="w-32"><span className="sr-only">{t.quota.liveTableConsumed}</span></Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {live.rows.map((row) => (
                        <Table.Row key={`${row.metric}:${row.unit}`} id={`${row.metric}:${row.unit}`}>
                          <Table.Cell className="font-medium">
                            <span className="block">{row.displayName}</span>
                            <span className="block text-xs font-normal text-muted">{row.unit}</span>
                          </Table.Cell>
                          <Table.Cell>{scopeLabel[row.scope]}</Table.Cell>
                          <Table.Cell className="text-end tabular-nums">
                            {row.limit === null ? t.quota.unlimited : numberFormat.format(row.limit)}
                          </Table.Cell>
                          <Table.Cell className="text-end tabular-nums">
                            {row.consumed === null ? (
                              <span className="text-muted" title={t.quota.unknownHint}>{t.quota.unknown}</span>
                            ) : numberFormat.format(row.consumed)}
                          </Table.Cell>
                          <Table.Cell className="text-end font-semibold tabular-nums">
                            {row.remaining === null ? (
                              <span className="font-normal text-muted">{t.quota.unknown}</span>
                            ) : numberFormat.format(row.remaining)}
                          </Table.Cell>
                          <Table.Cell><UsageBar ratio={row.usedRatio} /></Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
              {live.usageError ? (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content className="gap-1">
                    <Alert.Title>{t.quota.usageUnavailableTitle}</Alert.Title>
                    <Alert.Description>{t.quota.usageUnavailableBody}</Alert.Description>
                    <Alert.Description className="break-all font-mono text-xs opacity-80">{live.usageError}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : (
                <p className="text-xs text-muted">
                  {live.sampledAt ? `${t.quota.liveSampledAt(timeFormat(live.sampledAt))} — ` : ""}
                  {t.quota.liveLagNote}
                </p>
              )}
            </>
          ) : (
            <Alert status={live.configured ? "danger" : "default"}>
              <Alert.Indicator />
              <Alert.Content className="gap-2">
                <Alert.Title>{live.configured ? t.quota.liveFailedTitle : t.quota.notConfiguredTitle}</Alert.Title>
                <Alert.Description>{live.configured ? live.error : t.quota.notConfiguredBody}</Alert.Description>
                {live.configured ? null : (
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
                    {t.quota.notConfiguredSteps.map((step) => <li key={step}>{step}</li>)}
                  </ol>
                )}
              </Alert.Content>
            </Alert>
          )}
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>
          <Card.Title className="text-base font-semibold">{t.quota.observedTitle}</Card.Title>
          <Card.Description>{t.quota.observedDescription}</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-4">
          {/* Three across rather than five: the cards carry a stat plus a
              five-row breakdown, which needs the width to stay readable. */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {observed.windows.map((window) => (
              <div key={window.windowSeconds} className="rounded-xl border border-border/60 p-5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  {t.quota.windowLabel(window.windowSeconds)}
                </p>
                <div className="mt-1 flex items-baseline gap-2">
                  <p className="text-3xl font-bold tabular-nums">{numberFormat.format(window.requests)}</p>
                  <p className="text-xs text-muted">{t.quota.perMinuteUnit(window.perMinute)}</p>
                </div>
                <dl className="mt-4 space-y-1.5 text-sm">
                  {(["api", "upload", "download"] as const).map((kind) => (
                    <div key={kind} className="flex justify-between gap-2">
                      <dt className="text-muted">{kindLabel[kind]}</dt>
                      <dd className="tabular-nums">{numberFormat.format(window.byKind[kind])}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between gap-2 border-t border-separator pt-1">
                    <dt className="text-muted">{t.quota.windowThrottled}</dt>
                    <dd className={cn("tabular-nums", window.throttled > 0 && "font-semibold text-danger")}>
                      {numberFormat.format(window.throttled)}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted">{t.quota.windowErrors}</dt>
                    <dd className="tabular-nums">{numberFormat.format(window.errors)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted">
            {t.quota.observedSince(timeFormat(observed.since))} — {t.quota.observedScopeNote}
          </p>
        </Card.Content>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <Card.Header>
            <Card.Title className="flex items-center gap-2 text-base font-semibold"><HardDrive className="size-5 text-accent" aria-hidden="true" />{t.quota.storageTitle}</Card.Title>
            <Card.Description>{t.quota.storageDescription}</Card.Description>
          </Card.Header>
          <Card.Content className="space-y-3">
            {storage === null ? (
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{t.quota.storageFailed(quota.storageError ?? "")}</Alert.Description>
                </Alert.Content>
              </Alert>
            ) : storage.limitBytes === null ? (
              <p className="text-sm text-muted">{t.quota.storageUnlimited}</p>
            ) : (
              <>
                <UsageBar ratio={storage.usedRatio} />
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div><dt className="text-muted">{t.quota.storageUsed}</dt><dd className="font-semibold tabular-nums">{humanBytes(storage.usageBytes)}</dd></div>
                  <div><dt className="text-muted">{t.quota.storageRemaining}</dt><dd className="font-semibold tabular-nums">{humanBytes(storage.remainingBytes ?? 0)}</dd></div>
                  <div><dt className="text-muted">{t.quota.storageLimit}</dt><dd className="tabular-nums">{humanBytes(storage.limitBytes)}</dd></div>
                  <div><dt className="text-muted">{t.quota.storageTrash}</dt><dd className="tabular-nums">{humanBytes(storage.usageInDriveTrashBytes)}</dd></div>
                </dl>
              </>
            )}
          </Card.Content>
        </Card>

        <Card>
          <Card.Header>
            <Card.Title className="text-base font-semibold">{t.quota.throttleTitle}</Card.Title>
            <Card.Description>{t.quota.throttleDescription}</Card.Description>
          </Card.Header>
          <Card.Content>
            {observed.recentThrottles.length === 0 ? (
              <p className="text-sm text-muted">{t.quota.throttleEmpty}</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {observed.recentThrottles.slice(0, 8).map((event) => (
                  <li key={`${event.at}:${event.reason}`} className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-border/60 px-3 py-2">
                    <span className="font-medium">{event.reason ?? `HTTP ${event.status}`}</span>
                    <span className="text-xs text-muted">
                      {timeFormat(event.at)} — {event.retryAfterMs === null
                        ? t.quota.throttleNoRetryAfter
                        : t.quota.throttleRetryAfter(Math.round(event.retryAfterMs / 1000))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card.Content>
        </Card>
      </div>

      {quota.canSeeUsers ? (
        <Card>
          <Card.Header>
            <Card.Title className="flex items-center gap-2 text-base font-semibold"><Users className="size-5 text-accent" aria-hidden="true" />{t.quota.usersTitle}</Card.Title>
            <Card.Description>{t.quota.usersDescription}</Card.Description>
          </Card.Header>
          <Card.Content>
            {observed.users.length === 0 ? (
              <p className="text-sm text-muted">{t.quota.usersEmpty}</p>
            ) : (
              <Table>
                <Table.ScrollContainer>
                  <Table.Content aria-label={t.quota.usersTitle}>
                    <Table.Header>
                      <Table.Column isRowHeader>{t.quota.usersTableUser}</Table.Column>
                      <Table.Column className="text-end">{t.quota.usersTableRequests}</Table.Column>
                      <Table.Column className="text-end">{t.quota.usersTableThrottled}</Table.Column>
                      <Table.Column>{t.quota.usersTableLast}</Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {observed.users.map((user) => (
                        <Table.Row key={user.userId} id={user.userId}>
                          <Table.Cell className="font-medium">{user.email ?? user.userId}</Table.Cell>
                          <Table.Cell className="text-end tabular-nums">{numberFormat.format(user.requestsLastHour)}</Table.Cell>
                          <Table.Cell className={cn("text-end tabular-nums", user.throttledLastHour > 0 && "font-semibold text-danger")}>
                            {numberFormat.format(user.throttledLastHour)}
                          </Table.Cell>
                          <Table.Cell className="text-muted">{timeFormat(user.lastCallAt)}</Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            )}
          </Card.Content>
        </Card>
      ) : null}

      <Card>
        <Card.Header>
          <Card.Title className="text-base font-semibold">{t.quota.concurrencyTitle}</Card.Title>
          <Card.Description>{t.quota.concurrencyDescription}</Card.Description>
        </Card.Header>
        <Card.Content>
          <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: t.quota.concurrencyUploads, value: concurrency.uploadsPerUser },
              { label: t.quota.concurrencyDownloads, value: concurrency.downloadsPerUser },
              { label: t.quota.concurrencyApi, value: concurrency.apiRequestsPerUser },
              { label: t.quota.concurrencyRetries, value: concurrency.retryMaxAttempts },
            ].map((item) => (
              <div key={item.label} className="rounded-xl border border-border/60 p-4">
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{item.label}</dt>
                <dd className="mt-1 text-2xl font-bold tabular-nums">{item.value}</dd>
              </div>
            ))}
          </dl>
        </Card.Content>
      </Card>
    </div>
  );
}
