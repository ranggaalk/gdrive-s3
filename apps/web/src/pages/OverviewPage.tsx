import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { Cloud, CloudOff, Database, PackageOpen, RefreshCw, ShieldAlert } from "lucide-react";
import { Alert, Button, buttonVariants, Card, Chip, Table } from "@heroui/react";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { useToast } from "@/components/toast-provider";
import { cn } from "@/lib/utils";
import {
  getDriveStatus,
  getGatewayStatus,
  listBuckets,
  reconcileDrive,
  reconnectDrive,
  type CompatibilityItem,
  type DriveStatus,
  type GatewayStatus,
} from "../api/client.ts";

// Lazy: apexcharts/react-apexcharts are heavy and only needed once this
// page actually renders the traffic chart, not on every dashboard load.
const OverviewTraffic = lazy(() =>
  import("@/components/bucket-traffic").then((m) => ({ default: m.OverviewTraffic })),
);

export function OverviewPage({ onViewTrafficDetail }: { onViewTrafficDetail?: () => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const statusColor: Record<CompatibilityItem["status"], "success" | "danger" | "warning"> = {
    supported: "success",
    unsupported: "danger",
    untested: "warning",
  };
  const statusLabel: Record<CompatibilityItem["status"], string> = {
    supported: t.compat.supported,
    unsupported: t.compat.unsupported,
    untested: t.compat.untested,
  };

  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [bucketCount, setBucketCount] = useState(0);
  const [objectCount, setObjectCount] = useState(0);
  const [sharedBucketCount, setSharedBucketCount] = useState(0);
  const [bucketAccessErrors, setBucketAccessErrors] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileMessage, setReconcileMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [status, buckets, gatewayStatus] = await Promise.all([getDriveStatus(), listBuckets(), getGatewayStatus()]);
      setDrive(status);
      setGateway(gatewayStatus);
      setBucketCount(buckets.length);
      setObjectCount(buckets.reduce((sum, bucket) => sum + (bucket.objectCount ?? 0), 0));
      setSharedBucketCount(buckets.filter((bucket) => bucket.storageKind === "shared_drive").length);
      setBucketAccessErrors(buckets.filter((bucket) => bucket.storageStatus !== "active").length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onReconnect = async () => {
    if (drive?.requiresReauthorization) {
      window.location.assign(drive.reauthorizationUrl ?? "/auth/google/start");
      return;
    }
    if (reconnecting) return;
    setReconnecting(true);
    setError(null);
    try {
      await reconnectDrive();
      toast.success(t.toast.driveReconnected);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      toast.fromError(t.toast.driveReconnectFailed, e);
    } finally {
      setReconnecting(false);
    }
  };

  const onReconcile = async () => {
    if (reconciling) return;
    setReconciling(true);
    setError(null);
    setReconcileMessage(null);
    try {
      const result = await reconcileDrive();
      const summary = t.overview.reconcileMessage({
        examined: result.examined,
        active: result.active,
        missing: result.missing,
        externallyModified: result.externallyModified,
        errors: result.errors,
      });
      setReconcileMessage(summary);
      toast.success(t.toast.reconcileDone, summary);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      toast.fromError(t.toast.reconcileFailed, e);
    } finally {
      setReconciling(false);
    }
  };

  if (loading) return <LoadingState label={t.overview.loading} />;

  type StatTone = "accent" | "success" | "danger";
  const TONE_CLASSES: Record<StatTone, { badge: string; icon: string }> = {
    accent: { badge: "bg-accent-soft", icon: "text-accent-soft-foreground" },
    success: { badge: "bg-success-soft", icon: "text-success" },
    danger: { badge: "bg-danger-soft", icon: "text-danger" },
  };

  const stats: Array<{ label: string; value: number; icon: LucideIcon; tone: StatTone }> = [
    { label: t.overview.statSharedDrive, value: sharedBucketCount, icon: Cloud, tone: "accent" },
    { label: t.overview.statObjects, value: objectCount, icon: PackageOpen, tone: "success" },
    { label: t.overview.statAccessIssues, value: bucketAccessErrors, icon: ShieldAlert, tone: bucketAccessErrors > 0 ? "danger" : "success" },
  ];

  const compatibility = gateway?.compatibility ?? [];
  const compatCounts = {
    supported: compatibility.filter((item) => item.status === "supported").length,
    total: compatibility.length,
  };

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      {reconcileMessage ? (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.overview.reconcileDoneTitle}</Alert.Title>
            <Alert.Description>{reconcileMessage}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {drive?.requiresReauthorization ? (
        <Alert status="warning">
          <Alert.Indicator><RefreshCw /></Alert.Indicator>
          <Alert.Content>
            <Alert.Title>{t.overview.reauthTitle}</Alert.Title>
            <Alert.Description>{t.overview.reauthDescription}</Alert.Description>
            <a
              href={drive.reauthorizationUrl ?? "/auth/google/start"}
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "mt-3")}
            >
              {t.overview.reauthLink}
            </a>
          </Alert.Content>
        </Alert>
      ) : null}

      <section aria-label={t.overview.summaryLabel} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Card className="relative overflow-hidden bg-linear-to-br from-accent to-accent/80 text-accent-foreground shadow-lg shadow-accent/25">
          <Database className="pointer-events-none absolute -right-5 -top-5 size-28 text-accent-foreground/10" aria-hidden="true" />
          <Card.Header className="relative flex-row items-center justify-between gap-3">
            <Card.Description className="text-accent-foreground/80">{t.overview.statBucket}</Card.Description>
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-foreground/15">
              <Database className="size-5" aria-hidden="true" />
            </span>
          </Card.Header>
          <Card.Content className="relative"><p className="text-4xl font-bold tabular-nums">{bucketCount}</p></Card.Content>
        </Card>

        {stats.map(({ label, value, icon: Icon, tone }) => (
          <Card key={label}>
            <Card.Header className="flex-row items-center justify-between gap-3">
              <Card.Description>{label}</Card.Description>
              <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", TONE_CLASSES[tone].badge)}>
                <Icon className={cn("size-5", TONE_CLASSES[tone].icon)} aria-hidden="true" />
              </span>
            </Card.Header>
            <Card.Content><p className="text-3xl font-bold tabular-nums">{value}</p></Card.Content>
          </Card>
        ))}

        <Card>
          <Card.Header className="flex-row items-center justify-between gap-3">
            <Card.Description>{t.overview.googleDrive}</Card.Description>
            <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", drive?.connected ? "bg-success-soft" : "bg-danger-soft")}>
              {drive?.connected ? <Cloud className="size-5 text-success" aria-hidden="true" /> : <CloudOff className="size-5 text-danger" aria-hidden="true" />}
            </span>
          </Card.Header>
          <Card.Content className="gap-3">
            <p className={cn("text-2xl font-bold", drive?.connected ? "text-success" : "text-danger")}>{drive?.connected ? t.overview.connected : t.overview.disconnected}</p>
            {drive && !drive.connected ? <Button size="sm" variant="outline" isDisabled={reconnecting} onPress={() => void onReconnect()}><RefreshCw className={reconnecting ? "animate-spin" : ""} />{reconnecting ? t.overview.reconnecting : t.overview.reconnect}</Button> : null}
          </Card.Content>
        </Card>
      </section>

      <div className="flex justify-end">
        <Button variant="outline" onPress={() => void onReconcile()} isDisabled={!drive?.connected || reconciling}>
          <RefreshCw className={reconciling ? "animate-spin" : ""} />{reconciling ? t.overview.reconciling : t.overview.reconcileButton}
        </Button>
      </div>

      <section aria-label={t.overview.trafficLabel}>
        <Suspense fallback={<LoadingState label={t.overview.loadingTraffic} />}>
          <OverviewTraffic onViewDetail={onViewTrafficDetail} />
        </Suspense>
      </section>

      <Card>
        <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <Card.Title className="text-base font-semibold">{t.overview.compatibilityTitle}</Card.Title>
            <Card.Description>{t.overview.compatibilityDescription}</Card.Description>
          </div>
          {compatCounts.total > 0 ? (
            <Chip className="shrink-0">
              {t.overview.compatibilitySupportedCount(compatCounts.supported, compatCounts.total)}
            </Chip>
          ) : null}
        </Card.Header>
        <Card.Content>
          <Table>
            <Table.ScrollContainer>
              <Table.Content aria-label={t.overview.compatibilityTitle}>
                <Table.Header>
                  <Table.Column isRowHeader>{t.overview.tableFeature}</Table.Column>
                  <Table.Column>{t.overview.tableStatus}</Table.Column>
                  <Table.Column>{t.overview.tableVerifiedBy}</Table.Column>
                  <Table.Column>{t.overview.tableNotes}</Table.Column>
                </Table.Header>
                <Table.Body>
                  {compatibility.map((item) => {
                    const notes = t.compatNotes[item.feature] ?? item.notes ?? "";
                    return (
                      <Table.Row key={item.feature} id={item.feature}>
                        {/* The longest feature name is ~60 characters; without a
                            floor it wraps to one or two words per line and the
                            rows stop lining up with each other. */}
                        <Table.Cell className="min-w-56 align-top font-medium">{item.feature}</Table.Cell>
                        <Table.Cell className="align-top">
                          <Chip color={statusColor[item.status]} variant="soft">{statusLabel[item.status]}</Chip>
                        </Table.Cell>
                        <Table.Cell className="align-top">
                          {item.verifiedBy && item.verifiedBy.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {item.verifiedBy.map((source) => (
                                <Chip key={source} variant="tertiary" size="sm" className="border font-mono text-[0.7rem] font-normal">
                                  {source}
                                </Chip>
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted">-</span>
                          )}
                        </Table.Cell>
                        {/* Several notes run to a full paragraph. Capping the
                            column keeps them from swallowing the row and pushing
                            the other three columns into a sliver. */}
                        <Table.Cell className="max-w-md min-w-64 align-top text-xs leading-relaxed text-muted">
                          {notes || "-"}
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </Card.Content>
      </Card>
    </div>
  );
}
