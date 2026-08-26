import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Activity, ArrowDownToLine, ArrowLeft, CloudDownload, Eye, Files, Folder, HardDriveDownload, Link2, Plus, Search, Trash2 } from "lucide-react";
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
import { useLocale } from "@/components/locale-provider";
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
  listBackupAccounts,
  listBucketBackups,
  startBucketBackup,
  getBucketBackup,
  cancelBucketBackup,
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
  type BackupAccount,
  type BackupTransfer,
} from "../api/client.ts";

function isPreviewable(contentType: string): boolean {
  const mime = contentType.split(";", 1)[0]!.toLowerCase();
  return mime === "application/pdf" || mime === "application/json" || mime === "text/plain" || mime === "text/csv" || ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon"].includes(mime) || mime.startsWith("audio/") || mime.startsWith("video/");
}

export function ObjectsPage({
  bucket,
  onBack,
  onOpenBackupAccounts,
}: {
  bucket: Bucket;
  onBack: () => void;
  onOpenBackupAccounts?: () => void;
}) {
  const { t } = useLocale();
  const BACKUP_STATUS_LABEL: Record<BackupTransfer["status"], string> = {
    queued: t.backup.statusQueued,
    running: t.backup.statusRunning,
    cancel_requested: t.backup.statusCancelRequested,
    completed: t.backup.statusCompleted,
    cancelled: t.backup.statusCancelled,
    failed: t.backup.statusFailed,
  };
  const BACKUP_STATUS_VARIANT: Record<BackupTransfer["status"], "default" | "secondary" | "success" | "destructive" | "warning"> = {
    queued: "secondary",
    running: "warning",
    cancel_requested: "warning",
    completed: "success",
    cancelled: "secondary",
    failed: "destructive",
  };
  const EXPIRY_OPTIONS = [
    { value: "900", label: t.objects.expiry15m },
    { value: "3600", label: t.objects.expiry1h },
    { value: "86400", label: t.objects.expiry1d },
    { value: "604800", label: t.objects.expiry7d },
  ];
  const roleLabel = (role: "owner" | "editor" | "viewer") =>
    role === "owner" ? t.common.role.owner : role === "editor" ? t.common.role.editor : t.common.role.viewer;

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
  const [showBackup, setShowBackup] = useState(false);
  const [backupAccounts, setBackupAccounts] = useState<BackupAccount[]>([]);
  const [backupAccountId, setBackupAccountId] = useState("");
  const [backupTransfers, setBackupTransfers] = useState<BackupTransfer[]>([]);
  const [backupBusy, setBackupBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const writable = bucket.effectiveRole !== "viewer";
  const owner = bucket.effectiveRole === "owner";
  const noSharedDrives = sharedDrives.length === 0;
  const importKindOptions: Array<{ value: "my_drive" | "shared_drive"; label: string; disabled?: boolean }> = [
    { value: "my_drive", label: "My Drive" },
    { value: "shared_drive", label: "Shared Drive", disabled: noSharedDrives },
  ];

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
    if (kind === "shared_drive" && !driveId) {
      setDriveFolders([]);
      setSelectedFolder(null);
      return;
    }
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

  const activeBackupTransfer = backupTransfers.find(
    (t) => t.status === "queued" || t.status === "running" || t.status === "cancel_requested",
  ) ?? null;

  useEffect(() => {
    if (!activeBackupTransfer) return;
    const transferId = activeBackupTransfer.id;
    const timer = window.setInterval(() => {
      void getBucketBackup(bucket.id, transferId)
        .then((updated) => setBackupTransfers((list) => list.map((t) => (t.id === updated.id ? updated : t))))
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [bucket.id, activeBackupTransfer?.id, activeBackupTransfer?.status]);

  const openBackup = async () => {
    setShowBackup(true); setBackupBusy(true); setError(null);
    try {
      const [accounts, transfers] = await Promise.all([listBackupAccounts(), listBucketBackups(bucket.id)]);
      setBackupAccounts(accounts);
      setBackupTransfers(transfers);
      setBackupAccountId((current) => (current ? current : accounts.find((a) => a.status === "active")?.id ?? ""));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBackupBusy(false); }
  };

  const doStartBackup = async () => {
    if (!backupAccountId || backupBusy) return;
    setBackupBusy(true); setError(null);
    try {
      const transfer = await startBucketBackup(bucket.id, backupAccountId);
      setBackupTransfers((list) => [transfer, ...list]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBackupBusy(false); }
  };

  const doCancelBackup = async (transferId: string) => {
    try {
      await cancelBucketBackup(bucket.id, transferId);
      setBackupTransfers((list) => list.map((t) => (t.id === transferId ? { ...t, status: "cancel_requested" } : t)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
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
      if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new Error(t.objects.invalidExpiry);
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
      <div><Button variant="ghost" className="-ml-3" onClick={onBack}><ArrowLeft /> {t.login.backToBuckets}</Button><div className="mt-2 flex flex-wrap items-center gap-2"><h2 className="break-all text-xl font-semibold">{bucket.name}</h2><Badge variant="secondary">{bucket.storageDisplayName}</Badge><Badge variant={bucket.effectiveRole === "viewer" ? "outline" : "default"}>{roleLabel(bucket.effectiveRole)}</Badge></div></div>
      {bucket.storageStatus !== "active" ? <Alert variant="destructive"><AlertTitle>{t.objects.driveAccessIssueTitle}</AlertTitle><AlertDescription>{t.objects.driveAccessIssueDescription(bucket.storageDisplayName)}</AlertDescription></Alert> : null}
      {bucket.effectiveRole === "viewer" ? <Alert><AlertTitle>{t.objects.viewerAccessTitle}</AlertTitle><AlertDescription>{t.objects.viewerAccessDescription}</AlertDescription></Alert> : null}
      {error ? <ErrorAlert message={error} /> : null}

      <div className="grid w-fit grid-cols-2 gap-2"><Button type="button" variant={view === "objects" ? "default" : "outline"} onClick={() => setView("objects")}><Files /> {t.objects.viewObjects}</Button><Button type="button" variant={view === "traffic" ? "default" : "outline"} onClick={() => setView("traffic")}><Activity /> {t.objects.viewTraffic}</Button></div>

      {view === "traffic" ? <Suspense fallback={<LoadingState label={t.objects.loadingTraffic} />}><BucketTraffic bucketId={bucket.id} /></Suspense> : <>
      {importJob ? <Alert variant={importJob.status === "failed" ? "destructive" : "default"}><CloudDownload /><AlertTitle>{t.objects.importAlertTitle(importJob.status)}</AlertTitle><AlertDescription><p>{t.objects.importAlertDescription({ sourceFolderName: importJob.sourceFolderName, discovered: importJob.discovered, imported: importJob.imported, conflicts: importJob.conflicts, unsupported: importJob.unsupported, failed: importJob.failed })}</p>{importJob.lastError ? <p>{importJob.lastError}</p> : null}<div className="mt-3 flex gap-2">{!["completed", "cancelled", "failed"].includes(importJob.status) ? <Button size="sm" variant="outline" onClick={() => void cancelDriveImport(bucket.id, importJob.id)}>{t.objects.cancelImport}</Button> : null}{["completed", "cancelled", "failed"].includes(importJob.status) ? <Button size="sm" variant="outline" onClick={() => void listDriveImportIssues(bucket.id, importJob.id).then((page) => setImportIssues(page.items))}>{t.objects.viewReport}</Button> : null}</div></AlertDescription></Alert> : null}
      {importIssues.length ? <Table><TableHeader><TableRow><TableHead>{t.objects.issueKey}</TableHead><TableHead>{t.objects.issueStatus}</TableHead><TableHead>{t.objects.issueReason}</TableHead></TableRow></TableHeader><TableBody>{importIssues.map((issue) => <TableRow key={issue.id}><TableRowHeader className="max-w-80 break-all font-mono text-xs">{issue.key}</TableRowHeader><TableCell>{issue.status}</TableCell><TableCell>{issue.reason ?? "-"}</TableCell></TableRow>)}</TableBody></Table> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between"><form onSubmit={search} role="search" className="flex flex-1 gap-2"><Input placeholder={t.objects.filterPlaceholder} value={prefix} onChange={(event) => setPrefix(event.target.value)} aria-label={t.objects.filterAriaLabel} /><Button type="submit" variant="outline" disabled={loading}><Search /> <span className="hidden sm:inline">{t.objects.search}</span></Button></form><div className="flex gap-2">{owner ? <Button variant="outline" onClick={() => void openImport()}><CloudDownload /> {t.objects.importFromDrive}</Button> : null}{owner ? <Button variant="outline" onClick={() => void openBackup()}><HardDriveDownload /> {t.backup.button}</Button> : null}{writable ? <Button onClick={() => setShowUpload(true)}><Plus /> {t.objects.upload}</Button> : null}</div></div>

      {loading ? <LoadingState label={t.objects.loading} /> : items.length === 0 ? <EmptyState icon={Files} title={t.objects.emptyTitle} description={writable ? t.objects.emptyDescriptionWritable : t.objects.emptyDescriptionReadonly} /> : <><Table><TableHeader><TableRow><TableHead>{t.objects.tableKey}</TableHead><TableHead>{t.objects.tableSize}</TableHead><TableHead>{t.objects.tableType}</TableHead><TableHead>{t.objects.tableModified}</TableHead><TableHead className="text-right">{t.objects.tableAction}</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableRowHeader className="max-w-80 break-all font-mono text-xs">{item.key}</TableRowHeader><TableCell className="whitespace-nowrap">{humanBytes(item.size)}</TableCell><TableCell className="max-w-48 break-all">{item.contentType}</TableCell><TableCell className="whitespace-nowrap">{new Date(item.lastModified).toLocaleString()}</TableCell><TableCell><div className="flex justify-end gap-1"><Button size="icon" variant="ghost" title={t.objects.download} aria-label={t.objects.downloadLabel(item.key)} asChild><a href={objectDownloadUrl(bucket.id, item.id)}><ArrowDownToLine /></a></Button>{isPreviewable(item.contentType) ? <Button size="icon" variant="ghost" title={t.objects.preview} aria-label={t.objects.previewLabel(item.key)} onClick={() => window.open(objectPreviewUrl(bucket.id, item.id), "_blank", "noopener,noreferrer")}><Eye /></Button> : null}{owner ? <Button size="icon" variant="ghost" title={t.objects.publicLink} aria-label={t.objects.publicLinkLabel(item.key)} onClick={() => void openLinks(item)}><Link2 /></Button> : null}{writable ? <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" title={t.objects.deleteTitle} aria-label={t.objects.deleteLabel(item.key)} onClick={() => setDeleteTarget(item)}><Trash2 /></Button> : null}</div></TableCell></TableRow>)}</TableBody></Table>{nextAfter ? <div className="flex justify-center"><Button variant="outline" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? t.common.loadingMore : t.common.loadMore}</Button></div> : null}</>}
      </>}

      <Dialog open={showImport} onOpenChange={(open) => { if (!importBusy) setShowImport(open); }}><DialogContent className="max-w-2xl"><DialogHeader><DialogTitle>{t.objects.importDialogTitle}</DialogTitle><DialogDescription>{t.objects.importDialogDescription}</DialogDescription></DialogHeader><div className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><div className="space-y-2"><Label>{t.objects.locationLabel}</Label><Select value={importKind} options={importKindOptions} onValueChange={(kind) => { setImportKind(kind); const driveId = kind === "shared_drive" ? sharedDrives[0]?.id ?? "" : ""; setImportDriveId(driveId); setFolderStack([]); setSelectedFolder(null); if (kind === "shared_drive" && !driveId) { setDriveFolders([]); setSelectedFolder(null); } else { void browseFolders(kind, driveId, []); } }} />{noSharedDrives ? <p className="text-xs text-muted-foreground">{t.objects.noSharedDriveAccessible}</p> : null}</div>{importKind === "shared_drive" ? <div className="space-y-2"><Label>{t.objects.sharedDriveLabel}</Label><Select value={importDriveId} options={sharedDrives.map((drive) => ({ value: drive.id, label: drive.name }))} placeholder={t.objects.pickSharedDrive} onValueChange={(driveId) => { setImportDriveId(driveId); setFolderStack([]); setSelectedFolder(null); void browseFolders("shared_drive", driveId, []); }} /></div> : null}</div><div className="flex flex-wrap items-center gap-2 text-sm"><Button size="sm" variant="ghost" disabled={folderStack.length === 0 || importBusy} onClick={() => { const stack = folderStack.slice(0, -1); setFolderStack(stack); setSelectedFolder(null); void browseFolders(importKind, importDriveId, stack); }}>{t.objects.up}</Button><span className="text-muted-foreground">/{folderStack.map((folder) => folder.name).join("/")}</span></div><div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">{importBusy ? <LoadingState label={t.objects.loadingTraffic} /> : driveFolders.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{t.objects.noSubfolders}</p> : driveFolders.map((folder) => <div key={folder.id} className={`flex items-center justify-between rounded-md p-2 ${selectedFolder?.id === folder.id ? "bg-muted" : ""}`}><button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelectedFolder(folder)}><Folder className="size-4 shrink-0" /><span className="truncate">{folder.name}</span></button><Button size="sm" variant="ghost" onClick={() => { const stack = [...folderStack, folder]; setFolderStack(stack); setSelectedFolder(null); void browseFolders(importKind, importDriveId, stack); }}>{t.objects.open}</Button></div>)}</div>{selectedFolder ? <Alert><AlertTitle>{t.objects.folderSelectedTitle}</AlertTitle><AlertDescription>{selectedFolder.name}</AlertDescription></Alert> : null}</div><DialogFooter><Button variant="outline" disabled={importBusy} onClick={() => setShowImport(false)}>{t.common.cancel}</Button><Button disabled={!selectedFolder || importBusy || (importKind === "shared_drive" && !importDriveId)} onClick={() => void startImport()}>{importBusy ? t.objects.preparing : t.objects.startImport}</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={showBackup} onOpenChange={(open) => { if (!backupBusy) setShowBackup(open); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t.backup.dialogTitle}</DialogTitle>
            <DialogDescription>{t.backup.dialogDescription}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {backupAccounts.length === 0 ? (
              <Alert>
                <AlertTitle>{t.backup.noAccountsTitle}</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>{t.backup.noAccountsDescription}</p>
                  {onOpenBackupAccounts ? (
                    <Button size="sm" variant="outline" onClick={() => { setShowBackup(false); onOpenBackupAccounts(); }}>
                      {t.backup.openBackupPage}
                    </Button>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-2">
                <Label>{t.backup.targetAccountLabel}</Label>
                <Select
                  value={backupAccountId}
                  onValueChange={setBackupAccountId}
                  placeholder={t.backup.pickAccount}
                  options={backupAccounts.map((account) => ({
                    value: account.id,
                    label: account.status === "active" ? account.email : `${account.email}${t.backup.needsReauthSuffix}`,
                    disabled: account.status !== "active",
                  }))}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={!backupAccountId || backupBusy || Boolean(activeBackupTransfer)}
                    onClick={() => void doStartBackup()}
                  >
                    {backupBusy ? t.backup.starting : t.backup.start}
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label>{t.backup.historyLabel}</Label>
              {backupBusy && backupTransfers.length === 0 ? (
                <LoadingState label={t.backup.loadingHistory} />
              ) : backupTransfers.length === 0 ? (
                <p className="rounded-md border p-4 text-sm text-muted-foreground">{t.backup.noHistory}</p>
              ) : (
                <div className="max-h-72 space-y-2 overflow-y-auto">
                  {backupTransfers.map((transfer) => {
                    const account = backupAccounts.find((a) => a.id === transfer.backupAccountId);
                    const isActive =
                      transfer.status === "queued" || transfer.status === "running" || transfer.status === "cancel_requested";
                    return (
                      <div key={transfer.id} className="space-y-1 rounded-md border p-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="truncate font-medium">{account?.email ?? transfer.backupAccountId}</span>
                          <div className="flex items-center gap-2">
                            <Badge variant={BACKUP_STATUS_VARIANT[transfer.status]}>{BACKUP_STATUS_LABEL[transfer.status]}</Badge>
                            {isActive ? (
                              <Button size="sm" variant="ghost" onClick={() => void doCancelBackup(transfer.id)}>{t.backup.cancelRun}</Button>
                            ) : null}
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t.backup.progressSummary({ copied: transfer.copied, skipped: transfer.skipped, failed: transfer.failed, total: transfer.total })}
                        </p>
                        {transfer.lastError ? <p className="text-xs text-destructive">{transfer.lastError}</p> : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBackup(false)}>{t.common.close}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showUpload} onOpenChange={(open) => { if (!uploading) setShowUpload(open); }}><DialogContent><form className="space-y-5" onSubmit={(event) => void doUpload(event)}><DialogHeader><DialogTitle>{t.objects.uploadDialogTitle}</DialogTitle><DialogDescription>{t.objects.uploadDialogDescription}</DialogDescription></DialogHeader><div className="space-y-2"><Label htmlFor="object-file">{t.objects.fileLabel}</Label><Input ref={fileInput} id="object-file" type="file" onChange={(event) => { const selected = event.target.files?.[0] ?? null; setFile(selected); if (selected) setKey(selected.name); }} /></div><div className="space-y-2"><Label htmlFor="object-key">{t.objects.objectKeyLabel}</Label><Input id="object-key" value={key} onChange={(event) => setKey(event.target.value)} maxLength={1024} /></div>{file ? <p className="text-sm text-muted-foreground">{humanBytes(file.size)} · {file.type || "application/octet-stream"}</p> : null}<DialogFooter><Button type="button" variant="outline" disabled={uploading} onClick={() => setShowUpload(false)}>{t.common.cancel}</Button><Button disabled={!file || !key.trim() || uploading}>{uploading ? t.objects.uploading : t.objects.upload}</Button></DialogFooter></form></DialogContent></Dialog>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t.objects.deleteConfirmTitle}</AlertDialogTitle><AlertDialogDescription className="break-all">Namespace <span className="font-mono">{deleteTarget?.key}</span> {t.objects.deleteConfirmDescription}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deleting}>{t.common.cancel}</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleting} onClick={(event) => { event.preventDefault(); void doDelete(); }}>{deleting ? t.common.deleting : t.common.delete}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>

      <Dialog open={Boolean(linkTarget)} onOpenChange={(open) => { if (!open && !linkBusy) { setLinkTarget(null); setGenerated(null); setLinkLoaded(false); } }}><DialogContent className="min-w-0 max-h-[90vh] max-w-2xl overflow-x-hidden overflow-y-auto"><DialogHeader><DialogTitle>{t.objects.publicLinkDialogTitle}</DialogTitle><DialogDescription className="break-all">{t.objects.publicLinkDialogDescriptionPrefix} <span className="font-mono">{linkTarget?.key}</span>{t.objects.publicLinkDialogDescriptionSuffix}</DialogDescription></DialogHeader>{!linkLoaded ? <LoadingState label={t.objects.loadingLinkSettings} /> : <>{generated ? <div className="space-y-2"><Label>{t.objects.newUrlLabel}</Label><CopyableCode value={generated.url} label={t.objects.publicUrlCopyLabel} /><p className="text-xs text-muted-foreground">{generated.expiresAt ? t.objects.validUntil(new Date(generated.expiresAt).toLocaleString()) : t.objects.validUntilRevoked}</p></div> : null}<div className="grid gap-6 md:grid-cols-2"><section className="space-y-3"><h3 className="font-medium">{t.objects.presignedTitle}</h3><p className="text-sm text-muted-foreground">{t.objects.presignedDescription}</p>{credentials.length ? <><Select ariaLabel={t.objects.presignedCredentialAriaLabel} value={credentialId} onValueChange={setCredentialId} options={credentials.map((credential) => ({ value: credential.id, label: `${credential.label} · ${credential.access_key_id}` }))} /><Select ariaLabel={t.objects.presignedExpiryAriaLabel} value={String(expiresSeconds)} onValueChange={(value) => setExpiresSeconds(Number(value))} options={EXPIRY_OPTIONS} /><Button variant="outline" disabled={linkBusy} onClick={() => void temporaryLink()}>{t.objects.generateTemporary}</Button></> : <Alert><AlertTitle>{t.objects.noActiveKeyTitle}</AlertTitle><AlertDescription>{t.objects.noActiveKeyDescription}</AlertDescription></Alert>}</section><section className="space-y-3"><h3 className="font-medium">{t.objects.persistentTitle}</h3><p className="text-sm text-muted-foreground">{t.objects.persistentDescription}</p><Input value={publicLabel} maxLength={100} onChange={(event) => setPublicLabel(event.target.value)} placeholder={t.objects.linkLabelPlaceholder} /><Input type="datetime-local" min={new Date().toISOString().slice(0, 16)} value={publicExpiresAt} onChange={(event) => setPublicExpiresAt(event.target.value)} /><Button variant="outline" disabled={linkBusy || !publicLabel.trim()} onClick={() => void persistentLink()}>{t.objects.createPermanentLink}</Button></section></div>{publicLinks.length ? <div className="space-y-2"><h3 className="font-medium">{t.objects.permanentLinksTitle}</h3>{publicLinks.map((link) => <div key={link.id} className="flex items-center justify-between gap-3 rounded-md border p-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{link.label}</p><p className="text-xs text-muted-foreground">{link.status === "active" ? link.expiresAt ? t.objects.activeUntil(new Date(link.expiresAt).toLocaleString()) : t.objects.activeNoExpiry : t.objects.revoked}</p></div>{link.status === "active" ? <Button size="sm" variant="destructive" disabled={linkBusy} onClick={() => setRevokeTarget(link)}>{t.objects.revoke}</Button> : null}</div>)}</div> : null}</>}<DialogFooter><Button onClick={() => { setLinkTarget(null); setGenerated(null); setLinkLoaded(false); }} disabled={linkBusy}>{t.credentials.done}</Button></DialogFooter></DialogContent></Dialog>

      <AlertDialog open={Boolean(revokeTarget)} onOpenChange={(open) => { if (!open && !revokingLink) setRevokeTarget(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t.objects.revokeLinkConfirmTitle}</AlertDialogTitle><AlertDialogDescription>Link <span className="font-medium">{revokeTarget?.label}</span> {t.objects.revokeLinkConfirmDescriptionSuffix}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={revokingLink}>{t.common.cancel}</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={revokingLink} onClick={(event) => { event.preventDefault(); if (revokeTarget) void revokeLink(revokeTarget.id); }}>{revokingLink ? t.objects.revoking : t.objects.revoke}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  );
}
