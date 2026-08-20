import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  BookOpen,
  CheckCircle2,
  KeyRound,
  PackageOpen,
  RefreshCw,
  ShieldCheck,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import { CopyableCode } from "@/components/copyable-code";
import { MarkdownCanvas } from "@/components/markdown-canvas";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { documentationSetupExample, s3CommandExamples } from "@/lib/s3-cli";
import { getGatewayStatus, type CompatibilityItem, type GatewayStatus } from "../api/client.ts";
import aiAgentSkillTemplate from "../docs/drive-s3-ai-agent-skill.md?raw";

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

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3" aria-labelledby={`documentation-step-${number}`}>
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{number}</span>
        <h2 id={`documentation-step-${number}`} className="text-lg font-semibold">{title}</h2>
      </div>
      <div className="space-y-4 pl-11">{children}</div>
    </section>
  );
}

export function DocsPage({ onOpenBuckets, onOpenCredentials }: { onOpenBuckets: () => void; onOpenCredentials: () => void }) {
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGateway(await getGatewayStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <LoadingState label="Memuat dokumentasi koneksi" />;

  if (!gateway) {
    return (
      <div className="space-y-4">
        <ErrorAlert title="Dokumentasi tidak dapat dimuat" message={error ?? "Konfigurasi gateway tidak tersedia."} />
        <Button variant="outline" onClick={() => void load()}><RefreshCw /> Coba lagi</Button>
      </div>
    );
  }

  const commands = s3CommandExamples(gateway);
  const clients = gateway.compatibility.filter((item) => /compatibility smoke/i.test(item.feature));
  const aiAgentSkill = aiAgentSkillTemplate
    .replaceAll("{{S3_ENDPOINT}}", gateway.s3Endpoint)
    .replaceAll("{{S3_REGION}}", gateway.s3Region);

  return (
    <div className="space-y-6">
      <Alert>
        <BookOpen />
        <AlertTitle>Panduan koneksi DriveS3</AlertTitle>
        <AlertDescription>Gunakan endpoint dan region di halaman ini untuk setiap klien S3. DriveS3 menggunakan AWS Signature V4 dan path-style addressing.</AlertDescription>
      </Alert>

      <Card>
        <CardHeader><CardTitle>Konfigurasi gateway</CardTitle><CardDescription>Nilai ini berasal dari konfigurasi runtime backend, bukan alamat frontend.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 rounded-lg border bg-muted/40 p-4"><p className="text-sm text-muted-foreground">S3 endpoint</p><p className="mt-1 break-all font-mono text-sm font-medium">{gateway.s3Endpoint}</p></div>
          <div className="rounded-lg border bg-muted/40 p-4"><p className="text-sm text-muted-foreground">Signing region</p><p className="mt-1 font-mono text-sm font-medium">{gateway.s3Region}</p></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Mulai menggunakan DriveS3</CardTitle><CardDescription>Ikuti langkah berikut secara berurutan.</CardDescription></CardHeader>
        <CardContent className="space-y-8">
          <Step number={1} title="Buat bucket">
            <p className="text-sm text-muted-foreground">Bucket menjadi namespace teratas untuk objek Anda. Buat nama yang unik pada akun Anda dan gunakan huruf kecil, angka, titik, atau tanda hubung sesuai validasi dashboard.</p>
            <Button variant="outline" onClick={onOpenBuckets}><PackageOpen /> Buka Buckets</Button>
          </Step>

          <Step number={2} title="Buat access key">
            <p className="text-sm text-muted-foreground">Buat satu access key untuk setiap aplikasi atau perangkat agar dapat dicabut secara terpisah. Secret hanya ditampilkan satu kali setelah key dibuat.</p>
            <Button variant="outline" onClick={onOpenCredentials}><KeyRound /> Buka S3 Credentials</Button>
          </Step>

          <Step number={3} title="Konfigurasi AWS CLI">
            <p className="text-sm text-muted-foreground">Pastikan AWS CLI sudah terpasang, lalu ganti placeholder berikut dengan access key dan secret yang baru dibuat.</p>
            <CopyableCode value={documentationSetupExample(gateway)} label="konfigurasi AWS CLI" />
          </Step>

          <Step number={4} title="Uji koneksi">
            <p className="text-sm text-muted-foreground">Respons kosong tetap berarti koneksi berhasil jika Anda belum memiliki bucket.</p>
            <CopyableCode value={commands.test} label="perintah uji koneksi" />
          </Step>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Terminal className="size-5" /> Perintah dasar</CardTitle><CardDescription>Semua operasi menggunakan endpoint yang sama dan bucket path-style.</CardDescription></CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-2">
          <div className="min-w-0 space-y-2"><h2 className="font-medium">Upload objek</h2><CopyableCode value={commands.upload} label="perintah upload" /></div>
          <div className="min-w-0 space-y-2"><h2 className="font-medium">List objek</h2><CopyableCode value={commands.list} label="perintah list objek" /></div>
          <div className="min-w-0 space-y-2"><h2 className="font-medium">Download objek</h2><CopyableCode value={commands.download} label="perintah download" /></div>
          <div className="min-w-0 space-y-2"><h2 className="font-medium">Hapus objek</h2><CopyableCode value={commands.remove} label="perintah hapus" /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Bot className="size-5" /> Skill integrasi untuk AI agent</CardTitle>
          <CardDescription>
            Berikan file Markdown ini ke AI agent atau tim developer saat mengintegrasikan aplikasi lain dengan storage S3 ini.
            Endpoint dan region sudah diisi otomatis sesuai konfigurasi gateway saat ini.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MarkdownCanvas
            value={aiAgentSkill}
            fileName="drive-s3-ai-agent-skill.md"
            label="skill integrasi AI agent"
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" /> Keamanan credential</CardTitle></CardHeader>
          <CardContent>
            <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
              <li>Simpan secret di secret manager atau profile AWS yang terlindungi, bukan di source control.</li>
              <li>Jangan mengirim credential, signature, presigned URL, atau session cookie melalui log dan tiket dukungan.</li>
              <li>Rotate key untuk membuat pasangan baru sekaligus mencabut key lama; secret baru hanya tampil sekali.</li>
              <li>Cabut key yang tidak lagi digunakan atau diduga bocor, lalu hapus permanen hanya setelah statusnya dicabut.</li>
              <li>Temporary presigned link bergantung pada access key dan maksimal berlaku 7 hari. Persistent public link tidak bergantung pada key, ditampilkan sekali, dan harus dicabut dari halaman Objects.</li>
              <li>Gunakan HTTPS di production; HTTP hanya sesuai untuk localhost development.</li>
              <li>Credential mengakses bucket milik pengguna serta bucket Shared Drive yang dibagikan secara eksplisit sebagai Viewer atau Editor.</li>
              <li>Akses Shared Drive melalui DriveS3 tidak otomatis diberikan kepada semua anggota Google Drive; pemilik bucket memilih anggota DriveS3.</li>
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="size-5" /> Kompatibilitas</CardTitle><CardDescription>Ikuti matrix Overview sebagai sumber status dukungan lengkap.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {clients.length > 0 ? <div className="space-y-3">{clients.map((item) => <div key={item.feature} className="flex items-start justify-between gap-3"><span className="text-sm">{item.feature}</span><Badge variant={statusVariant[item.status]}>{statusLabel[item.status]}</Badge></div>)}</div> : <p className="text-sm text-muted-foreground">AWS CLI dan AWS SDK JavaScript v3 telah diverifikasi. Status rclone dan MinIO mc mengikuti matrix kompatibilitas gateway.</p>}
            <Alert variant="warning"><TriangleAlert /><AlertTitle>Batasan penting</AlertTitle><AlertDescription>Gunakan path-style, bukan bucket subdomain. Virtual-hosted style, ACL/bucket policy, versioning, Object Lock, SigV4A, dan SSE-KMS tidak didukung.</AlertDescription></Alert>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
