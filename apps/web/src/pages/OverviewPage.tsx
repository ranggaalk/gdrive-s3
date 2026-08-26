import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { CheckCircle2, Cloud, Database, PackageOpen, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableRowHeader } from "@/components/ui/table";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
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
  const statusVariant: Record<CompatibilityItem["status"], "success" | "destructive" | "warning"> = {
    supported: "success",
    unsupported: "destructive",
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
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
      setReconcileMessage(
        t.overview.reconcileMessage({
          examined: result.examined,
          active: result.active,
          missing: result.missing,
          externallyModified: result.externallyModified,
          errors: result.errors,
        }),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReconciling(false);
    }
  };

  if (loading) return <LoadingState label={t.overview.loading} />;

  const stats = [
    { label: t.overview.statBucket, value: bucketCount, icon: Database, tone: "text-primary" },
    { label: t.overview.statSharedDrive, value: sharedBucketCount, icon: Cloud, tone: "text-primary" },
    { label: t.overview.statObjects, value: objectCount, icon: PackageOpen, tone: "text-primary" },
    { label: t.overview.statAccessIssues, value: bucketAccessErrors, icon: RefreshCw, tone: bucketAccessErrors > 0 ? "text-destructive" : "text-primary" },
  ];

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      {reconcileMessage ? (
        <Alert variant="success"><CheckCircle2 /><AlertTitle>{t.overview.reconcileDoneTitle}</AlertTitle><AlertDescription>{reconcileMessage}</AlertDescription></Alert>
      ) : null}
      {drive?.requiresReauthorization ? (
        <Alert variant="warning"><RefreshCw /><AlertTitle>{t.overview.reauthTitle}</AlertTitle><AlertDescription className="space-y-3"><p>{t.overview.reauthDescription}</p><Button asChild size="sm" variant="outline"><a href={drive.reauthorizationUrl ?? "/auth/google/start"}>{t.overview.reauthLink}</a></Button></AlertDescription></Alert>
      ) : null}

      <section aria-label={t.overview.summaryLabel} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {stats.map(({ label, value, icon: Icon, tone }, index) => {
          const highlighted = index === 0;
          return (
            <Card key={label} className={cn(highlighted && "border-transparent bg-primary text-primary-foreground")}>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
                <CardDescription className={highlighted ? "text-primary-foreground/80" : undefined}>{label}</CardDescription>
                <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", highlighted ? "bg-primary-foreground/15" : "bg-muted")}>
                  <Icon className={cn("size-4", highlighted ? "text-primary-foreground" : tone)} aria-hidden="true" />
                </span>
              </CardHeader>
              <CardContent><p className="text-3xl font-semibold tabular-nums">{value}</p></CardContent>
            </Card>
          );
        })}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription>{t.overview.googleDrive}</CardDescription>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
              <Cloud className={drive?.connected ? "size-4 text-success" : "size-4 text-destructive"} aria-hidden="true" />
            </span>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className={`text-2xl font-semibold ${drive?.connected ? "text-success" : "text-destructive"}`}>{drive?.connected ? t.overview.connected : t.overview.disconnected}</p>
            {drive && !drive.connected ? <Button size="sm" variant="outline" disabled={reconnecting} onClick={() => void onReconnect()}><RefreshCw className={reconnecting ? "animate-spin" : ""} />{reconnecting ? t.overview.reconnecting : t.overview.reconnect}</Button> : null}
          </CardContent>
        </Card>
      </section>

      <div className="flex justify-end">
        <Button variant="outline" onClick={() => void onReconcile()} disabled={!drive?.connected || reconciling}>
          <RefreshCw className={reconciling ? "animate-spin" : ""} />{reconciling ? t.overview.reconciling : t.overview.reconcileButton}
        </Button>
      </div>

      <section aria-label={t.overview.trafficLabel}>
        <Suspense fallback={<LoadingState label={t.overview.loadingTraffic} />}>
          <OverviewTraffic onViewDetail={onViewTrafficDetail} />
        </Suspense>
      </section>

      <Card>
        <CardHeader><CardTitle>{t.overview.compatibilityTitle}</CardTitle><CardDescription>{t.overview.compatibilityDescription}</CardDescription></CardHeader>
        <CardContent className="p-0">
          <Table containerClassName="rounded-none bg-transparent p-0">
            <TableHeader><TableRow><TableHead>{t.overview.tableFeature}</TableHead><TableHead>{t.overview.tableStatus}</TableHead><TableHead>{t.overview.tableVerifiedBy}</TableHead><TableHead>{t.overview.tableNotes}</TableHead></TableRow></TableHeader>
            <TableBody>
              {(gateway?.compatibility ?? []).map((item) => (
                <TableRow key={item.feature}>
                  <TableRowHeader>{item.feature}</TableRowHeader>
                  <TableCell><Badge variant={statusVariant[item.status]}>{statusLabel[item.status]}</Badge></TableCell>
                  <TableCell>{item.verifiedBy && item.verifiedBy.length > 0 ? item.verifiedBy.join(", ") : "-"}</TableCell>
                  <TableCell className="min-w-52 text-muted-foreground">{item.notes ?? ""}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
