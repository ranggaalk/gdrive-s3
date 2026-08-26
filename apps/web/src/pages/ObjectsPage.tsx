import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Activity, ArrowDownToLine, ArrowLeft, CloudDownload, Eye, Files, Folder, Link2, Plus, Search, Trash2 } from "lucide-react";
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
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableRowHeader } from "@/components/ui/table";
import { CopyableCode } from "@/components/copyable-code";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import { humanBytes } from "@/lib/format";

// Lazy: apexcharts/react-apexcharts are heavy and only needed when the
// Traffic tab is actually opened, not on every dashboard page load.
const BucketTraffic = lazy(() =>
  import("@/components/bucket-traffic").then((m) => ({ default: m.BucketTraffic })),
);
import {
  cancelDriveImport,
  createDriveImport,
  createPresignedLink,
  getDriveImport,
  createPublicLink,
  deleteObject,
  listCredentials,
  listDriveFolders,
  listDriveImportIssues,
  listDriveImports,
  listObjects,
  listSharedDrives,
  listPublicLinks,
  objectDownloadUrl,
  objectPreviewUrl,
  revokePublicLink,
  uploadObject,
  type Bucket,
  type CredentialSummary,
  type DriveFolderSummary,
  type DriveImportIssue,
  type DriveImportJob,
  type SharedDriveSummary,
  type CreatedPublicLink,
  type ObjectItem,
  type PresignedLink,
  type PublicLinkSummary,
} from "../api/client.ts";

function isPreviewable(contentType: string): boolean {
  const mime = contentType.split(";", 1)[0]!.toLowerCase();
  return mime === "application/pdf" || mime === "application/json" || mime === "text/plain" || mime === "text/csv" || ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon"].includes(mime) || mime.startsWith("audio/") || mime.startsWith("video/");
}

const IMPORT_KIND_OPTIONS: Array<{ value: "my_drive" | "shared_drive"; label: string }> = [
  { value: "my_drive", label: "My Drive" },
  { value: "shared_drive", label: "Shared Drive" },
];

const EXPIRY_OPTIONS = [
  { value: "900", label: "15 menit" },
  { value: "3600", label: "1 jam" },
  { value: "86400", label: "1 hari" },
  { value: "604800", label: "7 hari" },
];

export function ObjectsPage({ bucket, onBack }: { bucket: Bucket; onBack: () => void }) {
  const [view, setView] = useState<"objects" | "traffic">("objects");
  const [items, setItems] = useState<ObjectItem[]>([]);
  const [prefix, setPrefix] = useState("");
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [key, setKey] = useState("");
  const [uploading, setUploading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ObjectItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [linkTarget, setLinkTarget] = useState<ObjectItem | null>(null);
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [publicLinks, setPublicLinks] = useState<PublicLinkSummary[]>([]);
  const [credentialId, setCredentialId] = useState("");
  const [expiresSeconds, setExpiresSeconds] = useState(3600);
  const [publicLabel, setPublicLabel] = useState("shared file");
  const [publicExpiresAt, setPublicExpiresAt] = useState("");
  const [generated, setGenerated] = useState<PresignedLink | CreatedPublicLink | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkLoaded, setLinkLoaded] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PublicLinkSummary | null>(null);
  const [revokingLink, setRevokingLink] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importKind, setImportKind] = useState<"my_drive" | "shared_drive">("my_drive");
  const [sharedDrives, setSharedDrives] = useState<SharedDriveSummary[]>([]);
  const [importDriveId, setImportDriveId] = useState("");
  const [folderStack, setFolderStack] = useState<Array<{ id: string; name: string }>>([]);
  const [driveFolders, setDriveFolders] = useState<DriveFolderSummary[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<DriveFolderSummary | null>(null);
  const [importJob, setImportJob] = useState<DriveImportJob | null>(null);
  const [importIssues, setImportIssues] = useState<DriveImportIssue[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const writable = bucket.effectiveRole !== "viewer";
  const owner = bucket.effectiveRole === "owner";

  const load = useCallback(async (value: string) => {
    setLoading(true); setError(null);
    try { const page = await listObjects(bucket.id, value); setItems(page.items); setNextAfter(page.nextAfter); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }, [bucket.id]);

  useEffect(() => { setPrefix(""); void load(""); }, [load]);
  useEffect(() => {
    if (!owner) return;
    void listDriveImports(bucket.id).then((jobs) => setImportJob(jobs[0] ?? null)).catch(() => {});
  }, [bucket.id, owner]);
  useEffect(() => {
    if (!importJob || ["completed", "cancelled", "failed"].includes(importJob.status)) return;
    const jobId = importJob.id;
    const timer = window.setInterval(() => {
      void getDriveImport(bucket.id, jobId).then((job) => {
        setImportJob(job);
        if (["completed", "cancelled", "failed"].includes(job.status)) {
          void listDriveImportIssues(bucket.id, job.id).then((page) => setImportIssues(page.items));
          void load(prefix.trim());
        }
      }).catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [bucket.id, importJob?.id, importJob?.status, load, prefix]);
  const search = (event: FormEvent) => { event.preventDefault(); void load(prefix.trim()); };

  const browseFolders = async (
    kind = importKind,
    driveId = importDriveId,
    stack = folderStack,
  ) => {
    setImportBusy(true); setError(null);
    try {
      const parentId = stack.at(-1)?.id;
      const page = await listDriveFolders({
        kind,
        driveId: kind === "shared_drive" ? driveId : undefined,
        parentId,
      });
      setDriveFolders(page.items);
      if (page.current && stack.length === 0) setSelectedFolder(page.current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setImportBusy(false); }
  };

  const openImport = async () => {
    setShowImport(true); setImportBusy(true); setSelectedFolder(null); setFolderStack([]);
    try {
      const [drives, imports] = await Promise.all([listSharedDrives(), listDriveImports(bucket.id)]);
      setSharedDrives(drives.items);
      setImportJob(imports[0] ?? null);
      const page = await listDriveFolders({ kind: "my_drive" });
      setDriveFolders(page.items);
      setSelectedFolder(page.current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setImportBusy(false); }
  };

  const startImport = async () => {
    if (!selectedFolder || importBusy) return;
    setImportBusy(true); setError(null);
    try {
      const job = await createDriveImport(bucket.id, {
        sourceKind: importKind,
        sourceDriveId: importKind === "shared_drive" ? importDriveId : undefined,
        sourceFolderId: selectedFolder.id,
      });
      setImportJob(job); setImportIssues([]); setShowImport(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setImportBusy(false); }
  };

  const more = async () => {
    if (!nextAfter || loadingMore) return;
    setLoadingMore(true);
    try { const page = await listObjects(bucket.id, prefix.trim(), nextAfter); setItems((current) => [...current, ...page.items]); setNextAfter(page.nextAfter); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoadingMore(false); }
  };

  const doUpload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !key.trim() || uploading) return;
    setUploading(true); setError(null);
    try { await uploadObject(bucket.id, key, file); setShowUpload(false); setFile(null); setKey(""); if (fileInput.current) fileInput.current.value = ""; await load(prefix.trim()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setUploading(false); }
  };

  const doDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try { await deleteObject(bucket.id, deleteTarget.id); setDeleteTarget(null); await load(prefix.trim()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setDeleting(false); }
  };

  const openLinks = async (object: ObjectItem) => {
    setLinkTarget(object); setGenerated(null); setLinkLoaded(false); setLinkBusy(true); setError(null);
    try {
      const [creds, links] = await Promise.all([listCredentials(), listPublicLinks(bucket.id, object.id)]);
      const active = creds.filter((credential) => credential.status === "active");
      setCredentials(active); setCredentialId(active[0]?.id ?? ""); setPublicLinks(links);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLinkLoaded(true); setLinkBusy(false); }
  };

  const temporaryLink = async () => {
    if (!linkTarget || !credentialId) return;
    setLinkBusy(true);
    try { setGenerated(await createPresignedLink(bucket.id, linkTarget.id, credentialId, expiresSeconds)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLinkBusy(false); }
  };

  const persistentLink = async () => {
    if (!linkTarget || !publicLabel.trim()) return;
    setLinkBusy(true);
    try {
      const expiresAt = publicExpiresAt ? new Date(publicExpiresAt) : null;
      if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error("Masa berlaku tidak valid.");
      const created = await createPublicLink(
        bucket.id,
        linkTarget.id,
        publicLabel.trim(),
        expiresAt?.toISOString() ?? null,
      );
      setGenerated(created);
      setPublicLinks(await listPublicLinks(bucket.id, linkTarget.id));
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLinkBusy(false); }
  };

  const revokeLink = async (linkId: string) => {
    if (!linkTarget) return;
    setLinkBusy(true);
    setRevokingLink(true);
    let succeeded = false;
    try {
      await revokePublicLink(bucket.id, linkTarget.id, linkId);
      setPublicLinks(await listPublicLinks(bucket.id, linkTarget.id));
      succeeded = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLinkBusy(false);
      setRevokingLink(false);
    }
    if (succeeded) setRevokeTarget(null);
  };

  return (
    <div className="space-y-6">
      <div><Button variant="ghost" className="-ml-3" onClick={onBack}><ArrowLeft /> Kembali ke buckets</Button><div className="mt-2 flex flex-wrap items-center gap-2"><h2 className="break-all text-xl font-semibold">{bucket.name}</h2><Badge variant="secondary">{bucket.storageDisplayName}</Badge><Badge variant={bucket.effectiveRole === "viewer" ? "outline" : "default"}>{bucket.effectiveRole === "owner" ? "Pemilik" : bucket.effectiveRole === "editor" ? "Editor" : "Viewer"}</Badge></div></div>
      {bucket.storageStatus !== "active" ? <Alert variant="destructive"><AlertTitle>Akses Drive bermasalah</AlertTitle><AlertDescription>Bucket masih terdaftar, tetapi akses Google ke {bucket.storageDisplayName} perlu dipulihkan.</AlertDescription></Alert> : null}
      {bucket.effectiveRole === "viewer" ? <Alert><AlertTitle>Akses Viewer</AlertTitle><AlertDescription>Anda dapat list, preview, dan download, tetapi tidak dapat mengubah objek atau membuat public link.</AlertDescription></Alert> : null}
      {error ? <ErrorAlert message={error} /> : null}

      <div className="grid w-fit grid-cols-2 gap-2"><Button type="button" variant={view === "objects" ? "default" : "outline"} onClick={() => setView("objects")}><Files /> Objek</Button><Button type="button" variant={view === "traffic" ? "default" : "outline"} onClick={() => setView("traffic")}><Activity /> Traffic</Button></div>

      {view === "traffic" ? <Suspense fallback={<LoadingState label="Memuat traffic" />}><BucketTraffic bucketId={bucket.id} /></Suspense> : <>
      {importJob ? <Alert variant={importJob.status === "failed" ? "destructive" : "default"}><CloudDownload /><AlertTitle>Import Drive: {importJob.status}</AlertTitle><AlertDescription><p>{importJob.sourceFolderName}: {importJob.discovered} ditemukan, {importJob.imported} diimpor, {importJob.conflicts} konflik, {importJob.unsupported} tidak didukung, {importJob.failed} gagal.</p>{importJob.lastError ? <p>{importJob.lastError}</p> : null}<div className="mt-3 flex gap-2">{!["completed", "cancelled", "failed"].includes(importJob.status) ? <Button size="sm" variant="outline" onClick={() => void cancelDriveImport(bucket.id, importJob.id)}>Batalkan import</Button> : null}{["completed", "cancelled", "failed"].includes(importJob.status) ? <Button size="sm" variant="outline" onClick={() => void listDriveImportIssues(bucket.id, importJob.id).then((page) => setImportIssues(page.items))}>Lihat laporan</Button> : null}</div></AlertDescription></Alert> : null}
      {importIssues.length ? <div className="rounded-lg border bg-card"><Table><TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Status</TableHead><TableHead>Alasan</TableHead></TableRow></TableHeader><TableBody>{importIssues.map((issue) => <TableRow key={issue.id}><TableRowHeader className="max-w-80 break-all font-mono text-xs">{issue.key}</TableRowHeader><TableCell>{issue.status}</TableCell><TableCell>{issue.reason ?? "-"}</TableCell></TableRow>)}</TableBody></Table></div> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between"><form onSubmit={search} role="search" className="flex flex-1 gap-2"><Input placeholder="Filter prefix…" value={prefix} onChange={(event) => setPrefix(event.target.value)} aria-label="Filter objek berdasarkan prefix" /><Button type="submit" variant="outline" disabled={loading}><Search /> <span className="hidden sm:inline">Cari</span></Button></form><div className="flex gap-2">{owner ? <Button variant="outline" onClick={() => void openImport()}><CloudDownload /> Import dari Drive</Button> : null}{writable ? <Button onClick={() => setShowUpload(true)}><Plus /> Upload</Button> : null}</div></div>

      {loading ? <LoadingState label="Memuat objek" /> : items.length === 0 ? <EmptyState icon={Files} title="Belum ada objek" description={writable ? "Upload file melalui dashboard atau S3 API." : "Bucket ini belum memiliki objek."} /> : <><div className="rounded-lg border bg-card"><Table><TableHeader><TableRow><TableHead>Key</TableHead><TableHead>Ukuran</TableHead><TableHead>Tipe</TableHead><TableHead>Diubah</TableHead><TableHead className="text-right">Aksi</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableRowHeader className="max-w-80 break-all font-mono text-xs">{item.key}</TableRowHeader><TableCell className="whitespace-nowrap">{humanBytes(item.size)}</TableCell><TableCell className="max-w-48 break-all">{item.contentType}</TableCell><TableCell className="whitespace-nowrap">{new Date(item.lastModified).toLocaleString()}</TableCell><TableCell><div className="flex justify-end gap-1"><Button size="icon" variant="ghost" title="Download" aria-label={`Download ${item.key}`} asChild><a href={objectDownloadUrl(bucket.id, item.id)}><ArrowDownToLine /></a></Button>{isPreviewable(item.contentType) ? <Button size="icon" variant="ghost" title="Preview" aria-label={`Preview ${item.key}`} onClick={() => window.open(objectPreviewUrl(bucket.id, item.id), "_blank", "noopener,noreferrer")}><Eye /></Button> : null}{owner ? <Button size="icon" variant="ghost" title="Public link" aria-label={`Public link ${item.key}`} onClick={() => void openLinks(item)}><Link2 /></Button> : null}{writable ? <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" title="Delete" aria-label={`Delete ${item.key}`} onClick={() => setDeleteTarget(item)}><Trash2 /></Button> : null}</div></TableCell></TableRow>)}</TableBody></Table></div>{nextAfter ? <div className="flex justify-center"><Button variant="outline" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? "Memuat…" : "Muat lebih banyak"}</Button></div> : null}</>}
      </>}

      <Dialog open={showImport} onOpenChange={(open) => { if (!importBusy) setShowImport(open); }}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>Import folder Google Drive</DialogTitle><DialogDescription>Snapshot satu kali. Path relatif dipertahankan, key yang sudah ada dilewati, dan file sumber tidak diubah. Google Docs dan shortcut belum didukung.</DialogDescription></DialogHeader><div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><Label>Lokasi</Label><Select value={importKind} options={IMPORT_KIND_OPTIONS} onValueChange={(kind) => { setImportKind(kind); const driveId = kind === "shared_drive" ? sharedDrives[0]?.id ?? "" : ""; setImportDriveId(driveId); setFolderStack([]); setSelectedFolder(null); void browseFolders(kind, driveId, []); }} /></div>{importKind === "shared_drive" ? <div className="space-y-2"><Label>Shared Drive</Label><Select value={importDriveId} options={sharedDrives.map((drive) => ({ value: drive.id, label: drive.name }))} placeholder="Pilih Shared Drive" onValueChange={(driveId) => { setImportDriveId(driveId); setFolderStack([]); setSelectedFolder(null); void browseFolders("shared_drive", driveId, []); }} /></div> : null}</div><div className="flex flex-wrap items-center gap-2 text-sm"><Button size="sm" variant="ghost" disabled={folderStack.length === 0 || importBusy} onClick={() => { const stack = folderStack.slice(0, -1); setFolderStack(stack); setSelectedFolder(null); void browseFolders(importKind, importDriveId, stack); }}>Naik</Button><span className="text-muted-foreground">/{folderStack.map((folder) => folder.name).join("/")}</span></div><div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">{importBusy ? <LoadingState label="Memuat folder" /> : driveFolders.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Tidak ada subfolder.</p> : driveFolders.map((folder) => <div key={folder.id} className={`flex items-center justify-between rounded-md p-2 ${selectedFolder?.id === folder.id ? "bg-muted" : ""}`}><button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelectedFolder(folder)}><Folder className="size-4 shrink-0" /><span className="truncate">{folder.name}</span></button><Button size="sm" variant="ghost" onClick={() => { const stack = [...folderStack, folder]; setFolderStack(stack); setSelectedFolder(null); void browseFolders(importKind, importDriveId, stack); }}>Buka</Button></div>)}</div>{selectedFolder ? <Alert><AlertTitle>Folder dipilih</AlertTitle><AlertDescription>{selectedFolder.name}</AlertDescription></Alert> : null}</div><DialogFooter><Button variant="outline" disabled={importBusy} onClick={() => setShowImport(false)}>Batal</Button><Button disabled={!selectedFolder || importBusy || (importKind === "shared_drive" && !importDriveId)} onClick={() => void startImport()}>{importBusy ? "Menyiapkan…" : "Mulai import"}</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={showUpload} onOpenChange={(open) => { if (!uploading) setShowUpload(open); }}><DialogContent><form className="space-y-5" onSubmit={(event) => void doUpload(event)}><DialogHeader><DialogTitle>Upload file</DialogTitle><DialogDescription>Upload menggunakan streaming dan akan mengganti isi jika object key sudah ada.</DialogDescription></DialogHeader><div className="space-y-2"><Label htmlFor="object-file">File</Label><Input ref={fileInput} id="object-file" type="file" onChange={(event) => { const selected = event.target.files?.[0] ?? null; setFile(selected); if (selected) setKey(selected.name); }} /></div><div className="space-y-2"><Label htmlFor="object-key">Object key</Label><Input id="object-key" value={key} onChange={(event) => setKey(event.target.value)} maxLength={1024} /></div>{file ? <p className="text-sm text-muted-foreground">{humanBytes(file.size)} · {file.type || "application/octet-stream"}</p> : null}<DialogFooter><Button type="button" variant="outline" disabled={uploading} onClick={() => setShowUpload(false)}>Batal</Button><Button disabled={!file || !key.trim() || uploading}>{uploading ? "Mengupload…" : "Upload"}</Button></DialogFooter></form></DialogContent></Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Hapus objek?</AlertDialogTitle><AlertDialogDescription className="break-all">Namespace <span className="font-mono">{deleteTarget?.key}</span> akan langsung dihapus. Cleanup file Google Drive diproses secara durable dan tindakan ini tidak dapat dibatalkan.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deleting}>Batal</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleting} onClick={(event) => { event.preventDefault(); void doDelete(); }}>{deleting ? "Menghapus…" : "Hapus"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>

      <Dialog open={Boolean(linkTarget)} onOpenChange={(open) => { if (!open && !linkBusy) { setLinkTarget(null); setGenerated(null); setLinkLoaded(false); } }}><DialogContent className="min-w-0 max-h-[90vh] max-w-2xl overflow-x-hidden overflow-y-auto"><DialogHeader><DialogTitle>Public link</DialogTitle><DialogDescription className="break-all">Buat link untuk <span className="font-mono">{linkTarget?.key}</span>. Mengganti isi pada key ini juga mengubah isi yang dibagikan oleh link permanen.</DialogDescription></DialogHeader>{!linkLoaded ? <LoadingState label="Memuat pengaturan link" /> : <>{generated ? <div className="space-y-2"><Label>URL baru — simpan sekarang</Label><CopyableCode value={generated.url} label="public URL" /><p className="text-xs text-muted-foreground">{generated.expiresAt ? `Berlaku sampai ${new Date(generated.expiresAt).toLocaleString()}` : "Berlaku sampai dicabut."}</p></div> : null}<div className="grid gap-6 md:grid-cols-2"><section className="space-y-3"><h3 className="font-medium">Temporary presigned link</h3><p className="text-sm text-muted-foreground">Maksimal 7 hari dan otomatis mati ketika credential di-rotate atau dicabut.</p>{credentials.length ? <><Select ariaLabel="Credential untuk presigned link" value={credentialId} onValueChange={setCredentialId} options={credentials.map((credential) => ({ value: credential.id, label: `${credential.label} · ${credential.access_key_id}` }))} /><Select ariaLabel="Masa berlaku presigned link" value={String(expiresSeconds)} onValueChange={(value) => setExpiresSeconds(Number(value))} options={EXPIRY_OPTIONS} /><Button variant="outline" disabled={linkBusy} onClick={() => void temporaryLink()}>Generate sementara</Button></> : <Alert><AlertTitle>Tidak ada key aktif</AlertTitle><AlertDescription>Buat access key aktif terlebih dahulu untuk presigned URL.</AlertDescription></Alert>}</section><section className="space-y-3"><h3 className="font-medium">Persistent revocable link</h3><p className="text-sm text-muted-foreground">Tidak bergantung pada access key dan aktif sampai expiry atau dicabut.</p><Input value={publicLabel} maxLength={100} onChange={(event) => setPublicLabel(event.target.value)} placeholder="Label link" /><Input type="datetime-local" min={new Date().toISOString().slice(0, 16)} value={publicExpiresAt} onChange={(event) => setPublicExpiresAt(event.target.value)} /><Button variant="outline" disabled={linkBusy || !publicLabel.trim()} onClick={() => void persistentLink()}>Buat link permanen</Button></section></div>{publicLinks.length ? <div className="space-y-2"><h3 className="font-medium">Link permanen</h3>{publicLinks.map((link) => <div key={link.id} className="flex items-center justify-between gap-3 rounded-md border p-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{link.label}</p><p className="text-xs text-muted-foreground">{link.status === "active" ? link.expiresAt ? `Aktif sampai ${new Date(link.expiresAt).toLocaleString()}` : "Aktif tanpa expiry" : "Dicabut"}</p></div>{link.status === "active" ? <Button size="sm" variant="destructive" disabled={linkBusy} onClick={() => setRevokeTarget(link)}>Cabut</Button> : null}</div>)}</div> : null}</>}<DialogFooter><Button onClick={() => { setLinkTarget(null); setGenerated(null); setLinkLoaded(false); }} disabled={linkBusy}>Selesai</Button></DialogFooter></DialogContent></Dialog>

      <AlertDialog open={Boolean(revokeTarget)} onOpenChange={(open) => { if (!open && !revokingLink) setRevokeTarget(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Cabut public link?</AlertDialogTitle><AlertDialogDescription>Link <span className="font-medium">{revokeTarget?.label}</span> langsung berhenti dapat mengakses file.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={revokingLink}>Batal</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={revokingLink} onClick={(event) => { event.preventDefault(); if (revokeTarget) void revokeLink(revokeTarget.id); }}>{revokingLink ? "Mencabut…" : "Cabut"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  );
}
