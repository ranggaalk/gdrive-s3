import { useCallback, useEffect, useState, type FormEvent } from "react";
import { KeyRound, Plus, RefreshCw, ShieldOff, Trash2, TriangleAlert } from "lucide-react";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableRowHeader } from "@/components/ui/table";
import { CopyableCode } from "@/components/copyable-code";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import { credentialSetupExample } from "@/lib/s3-cli";
import {
  createCredential,
  deleteCredential,
  listCredentials,
  revokeCredential,
  rotateCredential,
  type CredentialSummary,
  type CreatedCredential,
} from "../api/client.ts";

type PendingAction = { kind: "rotate" | "revoke" | "delete"; credential: CredentialSummary };

export function CredentialsPage() {
  const [creds, setCreds] = useState<CredentialSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [acting, setActing] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [created, setCreated] = useState<CreatedCredential | null>(null);
  const [secretTitle, setSecretTitle] = useState("Access key dibuat");

  const load = useCallback(async () => {
    setError(null);
    try { setCreds(await listCredentials()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const doCreate = async (event: FormEvent) => {
    event.preventDefault();
    const value = label.trim();
    if (!value || creating) return;
    setCreating(true);
    setFormError(null);
    try {
      const credential = await createCredential(value);
      setSecretTitle("Access key dibuat");
      setCreated(credential);
      setShowCreate(false);
      setLabel("");
      await load();
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const confirmAction = async () => {
    if (!pending || acting) return;
    setActing(true);
    setError(null);
    try {
      if (pending.kind === "rotate") {
        const credential = await rotateCredential(pending.credential.id);
        setSecretTitle("Access key berhasil di-rotate");
        setCreated(credential);
      } else if (pending.kind === "revoke") {
        await revokeCredential(pending.credential.id);
      } else {
        await deleteCredential(pending.credential.id);
      }
      setPending(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setActing(false);
    }
  };

  if (loading) return <LoadingState label="Memuat kredensial" />;

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      <div className="flex justify-end"><Button onClick={() => setShowCreate(true)}><Plus /> Buat access key</Button></div>

      {creds.length === 0 ? <EmptyState icon={KeyRound} title="Belum ada access key" description="Buat access key untuk menghubungkan AWS CLI atau klien S3 lain." /> : (
        <div className="rounded-lg border bg-card"><Table><TableHeader><TableRow><TableHead>Label</TableHead><TableHead>Access Key ID</TableHead><TableHead>Status</TableHead><TableHead>Terakhir dipakai</TableHead><TableHead className="text-right">Aksi</TableHead></TableRow></TableHeader><TableBody>{creds.map((credential) => (
          <TableRow key={credential.id}>
            <TableRowHeader>{credential.label}</TableRowHeader>
            <TableCell className="font-mono text-xs">{credential.access_key_id}</TableCell>
            <TableCell><Badge variant={credential.status === "active" ? "success" : "secondary"}>{credential.status === "active" ? "Aktif" : "Dicabut"}</Badge></TableCell>
            <TableCell>{credential.last_used_at ? new Date(credential.last_used_at).toLocaleString() : "-"}</TableCell>
            <TableCell><div className="flex justify-end gap-1">{credential.status === "active" ? <>
              <Button size="icon" variant="ghost" aria-label={`Rotate ${credential.label}`} title="Rotate key" disabled={acting} onClick={() => setPending({ kind: "rotate", credential })}><RefreshCw /></Button>
              <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" aria-label={`Cabut ${credential.label}`} title="Cabut key" disabled={acting} onClick={() => setPending({ kind: "revoke", credential })}><ShieldOff /></Button>
            </> : <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" aria-label={`Hapus ${credential.label}`} title="Hapus permanen" disabled={acting} onClick={() => setPending({ kind: "delete", credential })}><Trash2 /></Button>}</div></TableCell>
          </TableRow>
        ))}</TableBody></Table></div>
      )}

      <Dialog open={showCreate} onOpenChange={(open) => { if (!creating) { setShowCreate(open); setFormError(null); } }}>
        <DialogContent><form onSubmit={(event) => void doCreate(event)} className="space-y-5"><DialogHeader><DialogTitle>Buat access key</DialogTitle><DialogDescription>Gunakan label yang menjelaskan klien atau perangkat pemakai key ini.</DialogDescription></DialogHeader>{formError ? <ErrorAlert message={formError} /> : null}<div className="space-y-2"><Label htmlFor="credential-label">Label</Label><Input id="credential-label" maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} autoFocus aria-invalid={Boolean(formError)} /></div><DialogFooter><Button type="button" variant="outline" disabled={creating} onClick={() => setShowCreate(false)}>Batal</Button><Button type="submit" disabled={!label.trim() || creating}>{creating ? "Membuat…" : "Buat"}</Button></DialogFooter></form></DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(pending)} onOpenChange={(open) => { if (!open && !acting) setPending(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{pending?.kind === "rotate" ? "Rotate access key?" : pending?.kind === "revoke" ? "Cabut access key?" : "Hapus credential permanen?"}</AlertDialogTitle><AlertDialogDescription>{pending?.kind === "rotate" ? "Key lama dan semua temporary presigned link yang dibuat dengannya akan langsung tidak valid. Secret baru hanya tampil satu kali." : pending?.kind === "revoke" ? "Key ini langsung berhenti dapat mengakses S3. Setelah dicabut, key dapat dihapus permanen." : "Row credential akan dihapus. Audit tetap disimpan, tetapi tindakan ini tidak dapat dibatalkan."}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={acting}>Batal</AlertDialogCancel><AlertDialogAction className={pending?.kind === "rotate" ? "" : "bg-destructive text-destructive-foreground hover:bg-destructive/90"} disabled={acting} onClick={(event) => { event.preventDefault(); void confirmAction(); }}>{acting ? "Memproses…" : pending?.kind === "rotate" ? "Rotate" : pending?.kind === "revoke" ? "Cabut" : "Hapus permanen"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(created)} onOpenChange={(open) => { if (!open) setCreated(null); }}>
        <DialogContent className="min-w-0 max-h-[90vh] max-w-2xl overflow-x-hidden overflow-y-auto">
          <DialogHeader><DialogTitle>{secretTitle}</DialogTitle><DialogDescription>Simpan kredensial ini sebelum menutup dialog.</DialogDescription></DialogHeader>
          {created ? <div className="min-w-0 space-y-5"><Alert variant="warning"><TriangleAlert /><AlertTitle>Simpan secret sekarang</AlertTitle><AlertDescription>Secret access key hanya ditampilkan satu kali dan tidak dapat dilihat kembali.</AlertDescription></Alert><div className="grid gap-3 text-sm sm:grid-cols-2"><div><p className="text-muted-foreground">S3 endpoint</p><p className="break-all font-mono text-xs">{created.s3Endpoint}</p></div><div><p className="text-muted-foreground">Region</p><p className="font-mono text-xs">{created.s3Region}</p></div></div><div className="space-y-2"><Label>Access Key ID</Label><CopyableCode value={created.accessKeyId} label="Access Key ID" /></div><div className="space-y-2"><Label>Secret Access Key</Label><CopyableCode value={created.secretAccessKey} label="Secret Access Key" /></div><div className="space-y-2"><Label>Contoh AWS CLI (path-style)</Label><CopyableCode value={credentialSetupExample(created, { accessKeyId: created.accessKeyId, secretAccessKey: created.secretAccessKey })} label="contoh AWS CLI" /></div></div> : null}
          <DialogFooter><Button onClick={() => setCreated(null)}>Selesai</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
