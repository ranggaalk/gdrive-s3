import { useCallback, useEffect, useState, type FormEvent } from "react";
import { HardDrive, PackageOpen, Plus, Share2, Trash2, Users } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableRowHeader } from "@/components/ui/table";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import {
  addBucketMember,
  createBucket,
  deleteBucket,
  listBucketMembers,
  listBuckets,
  listSharedDrives,
  removeBucketMember,
  updateBucketMember,
  type Bucket,
  type BucketMember,
  type SharedDriveSummary,
  type StorageKind,
} from "../api/client.ts";

const ROLE_OPTIONS: Array<{ value: "viewer" | "editor"; label: string }> = [
  { value: "viewer", label: "Viewer" },
  { value: "editor", label: "Editor" },
];

export function BucketsPage({ onOpen }: { onOpen: (bucket: Bucket) => void }) {
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [storageKind, setStorageKind] = useState<StorageKind>("my_drive");
  const [sharedDrives, setSharedDrives] = useState<SharedDriveSummary[]>([]);
  const [sharedDriveId, setSharedDriveId] = useState("");
  const [drivesLoading, setDrivesLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Bucket | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [accessBucket, setAccessBucket] = useState<Bucket | null>(null);
  const [members, setMembers] = useState<BucketMember[]>([]);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<"viewer" | "editor">("viewer");
  const [memberBusy, setMemberBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setBuckets(await listBuckets()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadSharedDrives = async () => {
    if (sharedDrives.length > 0 || drivesLoading) return;
    setDrivesLoading(true);
    setFormError(null);
    try {
      const page = await listSharedDrives();
      setSharedDrives(page.items);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrivesLoading(false);
    }
  };

  const doCreate = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (value.length < 3 || creating || (storageKind === "shared_drive" && !sharedDriveId)) return;
    setCreating(true);
    setFormError(null);
    try {
      await createBucket(value, {
        kind: storageKind,
        ...(storageKind === "shared_drive" ? { driveId: sharedDriveId } : {}),
      });
      setShowCreate(false);
      setName("");
      setStorageKind("my_drive");
      setSharedDriveId("");
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const doDelete = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await deleteBucket(pendingDelete.id);
      setPendingDelete(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const openAccess = async (bucket: Bucket) => {
    setAccessBucket(bucket);
    setMemberEmail("");
    setError(null);
    try { setMembers(await listBucketMembers(bucket.id)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const addMember = async (event: FormEvent) => {
    event.preventDefault();
    if (!accessBucket || !memberEmail.trim() || memberBusy) return;
    setMemberBusy(true);
    setError(null);
    try {
      await addBucketMember(accessBucket.id, memberEmail.trim(), memberRole);
      setMembers(await listBucketMembers(accessBucket.id));
      setMemberEmail("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMemberBusy(false);
    }
  };

  if (loading) return <LoadingState label="Memuat bucket" />;

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      <div className="flex justify-end"><Button onClick={() => setShowCreate(true)}><Plus /> Buat bucket</Button></div>

      {buckets.length === 0 ? (
        <EmptyState icon={PackageOpen} title="Belum ada bucket" description="Buat bucket pertama Anda di My Drive atau Shared Drive." />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader><TableRow><TableHead>Nama</TableHead><TableHead>Lokasi</TableHead><TableHead>Akses</TableHead><TableHead>Objek</TableHead><TableHead>Multipart</TableHead><TableHead>Status</TableHead><TableHead>Dibuat</TableHead><TableHead className="text-right">Aksi</TableHead></TableRow></TableHeader>
            <TableBody>{buckets.map((bucket) => (
              <TableRow key={bucket.id}>
                <TableRowHeader><Button variant="link" className="h-auto p-0" onClick={() => onOpen(bucket)}>{bucket.name}</Button></TableRowHeader>
                <TableCell><div className="flex min-w-40 items-center gap-2">{bucket.storageKind === "shared_drive" ? <Share2 className="size-4 text-muted-foreground" /> : <HardDrive className="size-4 text-muted-foreground" />}<span>{bucket.storageDisplayName}</span></div></TableCell>
                <TableCell><Badge variant={bucket.effectiveRole === "owner" ? "default" : "secondary"}>{bucket.effectiveRole === "owner" ? "Pemilik" : bucket.effectiveRole === "editor" ? "Editor" : "Viewer"}</Badge></TableCell>
                <TableCell>{bucket.objectCount ?? 0}</TableCell><TableCell>{bucket.multipartOpen ?? 0}</TableCell><TableCell><Badge variant={bucket.storageStatus === "active" ? "success" : "destructive"}>{bucket.storageStatus === "active" ? "Aktif" : "Bermasalah"}</Badge></TableCell><TableCell className="whitespace-nowrap">{new Date(bucket.createdAt).toLocaleString()}</TableCell>
                <TableCell className="text-right"><div className="flex justify-end gap-1">{bucket.ownedByMe && bucket.storageKind === "shared_drive" ? <Button size="icon" variant="ghost" aria-label={`Kelola akses ${bucket.name}`} title="Kelola akses" onClick={() => void openAccess(bucket)}><Users /></Button> : null}{bucket.ownedByMe ? <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" aria-label={`Hapus bucket ${bucket.name}`} title="Hapus bucket" onClick={() => setPendingDelete(bucket)}><Trash2 /></Button> : null}</div></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={(open) => { if (!creating) { setShowCreate(open); setFormError(null); } }}>
        <DialogContent>
          <form onSubmit={(event) => void doCreate(event)} className="space-y-5">
            <DialogHeader><DialogTitle>Buat bucket</DialogTitle><DialogDescription>Pilih lokasi penyimpanan. Lokasi tidak dapat dipindahkan setelah bucket dibuat.</DialogDescription></DialogHeader>
            {formError ? <ErrorAlert message={formError} /> : null}
            <div className="space-y-2"><Label htmlFor="bucket-name">Nama bucket</Label><Input id="bucket-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus aria-invalid={Boolean(formError)} aria-describedby="bucket-help" /><p id="bucket-help" className="text-xs text-muted-foreground">3-63 karakter, huruf kecil, angka, titik, dan minus.</p></div>
            <fieldset className="space-y-2"><legend className="text-sm font-medium">Lokasi</legend><div className="grid grid-cols-2 gap-2"><Button type="button" variant={storageKind === "my_drive" ? "default" : "outline"} onClick={() => setStorageKind("my_drive")}><HardDrive /> My Drive</Button><Button type="button" variant={storageKind === "shared_drive" ? "default" : "outline"} onClick={() => { setStorageKind("shared_drive"); void loadSharedDrives(); }}><Share2 /> Shared Drive</Button></div></fieldset>
            {storageKind === "shared_drive" ? <div className="space-y-2"><Label>Shared Drive</Label><Select value={sharedDriveId} onValueChange={setSharedDriveId} disabled={drivesLoading} placeholder={drivesLoading ? "Memuat Shared Drive…" : "Pilih Shared Drive"} options={sharedDrives.filter((drive) => drive.canAddChildren).map((drive) => ({ value: drive.id, label: drive.name }))} /><p className="text-xs text-muted-foreground">Hanya Shared Drive yang dapat ditulisi ditampilkan. Anggota S3 dikelola setelah bucket dibuat.</p></div> : null}
            <DialogFooter><Button type="button" variant="outline" disabled={creating} onClick={() => setShowCreate(false)}>Batal</Button><Button type="submit" disabled={name.trim().length < 3 || creating || (storageKind === "shared_drive" && !sharedDriveId)}>{creating ? "Membuat…" : "Buat"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(accessBucket)} onOpenChange={(open) => { if (!open && !memberBusy) setAccessBucket(null); }}>
        <DialogContent className="max-w-xl"><DialogHeader><DialogTitle>Kelola akses {accessBucket?.name}</DialogTitle><DialogDescription>Pengguna harus sudah login ke DriveS3 dan menjadi anggota Google Shared Drive yang sama.</DialogDescription></DialogHeader><form className="grid gap-3 sm:grid-cols-[1fr_auto_auto]" onSubmit={(event) => void addMember(event)}><Input type="email" placeholder="nama@domain.com" value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} aria-label="Email anggota" /><Select value={memberRole} onValueChange={setMemberRole} options={ROLE_OPTIONS} buttonClassName="min-w-28" /><Button type="submit" disabled={!memberEmail.trim() || memberBusy}>{memberBusy ? "Menambah…" : "Tambah"}</Button></form><div className="space-y-2">{members.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada anggota tambahan.</p> : members.map((member) => <div key={member.user_id} className="flex items-center justify-between gap-3 rounded-md border p-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{member.email}</p><p className="text-xs text-muted-foreground">{member.access_status}</p></div><div className="flex items-center gap-2"><Select value={member.role} disabled={memberBusy} options={ROLE_OPTIONS} buttonClassName="h-9 min-w-28 px-2" onValueChange={async (role) => { if (!accessBucket) return; setMemberBusy(true); try { await updateBucketMember(accessBucket.id, member.user_id, role); setMembers(await listBucketMembers(accessBucket.id)); } finally { setMemberBusy(false); } }} /><Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" aria-label={`Hapus akses ${member.email}`} disabled={memberBusy} onClick={async () => { if (!accessBucket) return; setMemberBusy(true); try { await removeBucketMember(accessBucket.id, member.user_id); setMembers(await listBucketMembers(accessBucket.id)); } finally { setMemberBusy(false); } }}><Trash2 /></Button></div></div>)}</div></DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open && !deleting) setPendingDelete(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Hapus bucket {pendingDelete?.name}?</AlertDialogTitle><AlertDialogDescription>Bucket harus kosong. Folder pada {pendingDelete?.storageDisplayName} juga akan dihapus sesuai konfigurasi server.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deleting}>Batal</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleting} onClick={(event) => { event.preventDefault(); void doDelete(); }}>{deleting ? "Menghapus…" : "Hapus"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  );
}
