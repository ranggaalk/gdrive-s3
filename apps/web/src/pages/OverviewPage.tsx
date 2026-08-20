import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Cloud, Database, PackageOpen, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableRowHeader } from "@/components/ui/table";
import { ErrorAlert, LoadingState } from "@/components/feedback";
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

const statusVariant: Record<CompatibilityItem["status"], "success" | "destructive" | "warning"> = {
  supported: "success",
  unsupported: "destructive",
  untested: "warning",
};
const statusLabel: Record<CompatibilityItem["status"], string> = {
  supported: "Didukung",
  unsupported: "Belum didukung",
  untested: "Belum diuji",
};

export function OverviewPage() {
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
        `Rekonsiliasi selesai: ${result.examined} diperiksa, ${result.active} aktif, ${result.missing} hilang, ${result.externallyModified} berubah di luar sistem, ${result.errors} gagal.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReconciling(false);
    }
  };

  if (loading) return <LoadingState label="Memuat overview" />;

  const stats = [
    { label: "Bucket", value: bucketCount, icon: Database, tone: "text-primary" },
    { label: "Shared Drive", value: sharedBucketCount, icon: Cloud, tone: "text-primary" },
    { label: "Objek terindeks", value: objectCount, icon: PackageOpen, tone: "text-primary" },
    { label: "Akses bermasalah", value: bucketAccessErrors, icon: RefreshCw, tone: bucketAccessErrors > 0 ? "text-destructive" : "text-primary" },
  ];

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      {reconcileMessage ? (
        <Alert variant="success"><CheckCircle2 /><AlertTitle>Rekonsiliasi object terindeks selesai</AlertTitle><AlertDescription>{reconcileMessage}</AlertDescription></Alert>
      ) : null}
      {drive?.requiresReauthorization ? (
        <Alert variant="warning"><RefreshCw /><AlertTitle>Izin Google Drive perlu diperbarui</AlertTitle><AlertDescription className="space-y-3"><p>Hubungkan ulang akun untuk mengaktifkan Shared Drive dan memverifikasi akses anggota.</p><Button asChild size="sm" variant="outline"><a href={drive.reauthorizationUrl ?? "/auth/google/start"}>Hubungkan ulang Google</a></Button></AlertDescription></Alert>
      ) : null}

      <section aria-label="Ringkasan gateway" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {stats.map(({ label, value, icon: Icon, tone }) => (
          <Card key={label}>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardDescription>{label}</CardDescription><Icon className={`size-5 ${tone}`} aria-hidden="true" />
            </CardHeader>
            <CardContent><p className="text-3xl font-semibold tabular-nums">{value}</p></CardContent>
          </Card>
        ))}
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardDescription>Google Drive</CardDescription><Cloud className={drive?.connected ? "size-5 text-success" : "size-5 text-destructive"} aria-hidden="true" />
          </CardHeader>
          <CardContent className="space-y-3">
            <p className={`text-2xl font-semibold ${drive?.connected ? "text-success" : "text-destructive"}`}>{drive?.connected ? "Terhubung" : "Terputus"}</p>
            {drive && !drive.connected ? <Button size="sm" variant="outline" disabled={reconnecting} onClick={() => void onReconnect()}><RefreshCw className={reconnecting ? "animate-spin" : ""} />{reconnecting ? "Menghubungkan" : "Reconnect"}</Button> : null}
          </CardContent>
        </Card>
      </section>

      <div className="flex justify-end">
        <Button variant="outline" onClick={() => void onReconcile()} disabled={!drive?.connected || reconciling}>
          <RefreshCw className={reconciling ? "animate-spin" : ""} />{reconciling ? "Merekonsiliasi" : "Rekonsiliasi object terindeks"}
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle>Kompatibilitas S3</CardTitle><CardDescription>Status dukungan yang diverifikasi terhadap gateway saat ini.</CardDescription></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader><TableRow><TableHead>Fitur S3</TableHead><TableHead>Status</TableHead><TableHead>Diverifikasi oleh</TableHead><TableHead>Catatan</TableHead></TableRow></TableHeader>
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
