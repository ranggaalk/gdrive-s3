import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Activity, ArrowDownToLine, ArrowLeft, CloudDownload, Eye, FileCode2, Files, Folder, HardDriveDownload, History, Link2, Plus, Search, Trash2 } from "lucide-react";
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
import { useToast } from "@/components/toast-provider";
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
  createPresignedPost,
  deleteObjectVersion,
  getDriveImport,
  listObjectVersions,
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
  type ObjectVersion,
  type PresignedPostForm,
  type PublicLinkSummary,
  type BackupAccount,
  type BackupTransfer,
} from "../api/client.ts";

/** Escape a value for an HTML attribute, so a signature or policy can never
 *  break out of the markup the operator is about to paste into their page. */
function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** A ready-to-paste form. The file input comes last, which the gateway requires. */
function htmlSnippet(form: PresignedPostForm): string {
  const inputs = Object.entries(form.fields)
    .map(([name, value]) => `  <input type="hidden" name="${escapeAttribute(name)}" value="${escapeAttribute(value)}" />`)
    .join("\n");
  return [
    `<form action="${escapeAttribute(form.url)}" method="post" enctype="multipart/form-data">`,
    inputs,
    `  <input type="file" name="file" />`,
    `  <button type="submit">Upload</button>`,
    `</form>`,
  ].join("\n");
}

function curlSnippet(form: PresignedPostForm): string {
  const fields = Object.entries(form.fields)
    .map(([name, value]) => `  -F ${shellQuote(`${name}=${value}`)} \\`)
    .join("\n");
  return [`curl -X POST ${shellQuote(form.url)} \\`, fields, `  -F 'file=@./example.txt'`].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

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
  const toast = useToast();
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
  const [showUploadForm, setShowUploadForm] = useState(false);
  const [uploadFormPrefix, setUploadFormPrefix] = useState("inbox/");
  const [uploadFormMaxMb, setUploadFormMaxMb] = useState(25);
  const [uploadFormExpires, setUploadFormExpires] = useState(3600);
  const [uploadForm, setUploadForm] = useState<PresignedPostForm | null>(null);
  const [uploadFormBusy, setUploadFormBusy] = useState(false);
  const [versionTarget, setVersionTarget] = useState<ObjectItem | null>(null);
  const [versions, setVersions] = useState<ObjectVersion[]>([]);
  const [versionBusy, setVersionBusy] = useState(false);
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
          if (job.status === "completed") toast.success(t.toast.importFinished(job.imported));
          else if (job.status === "cancelled") toast.info(t.toast.importCancelled);
          else toast.error(t.toast.importFailed, job.lastError ?? undefined);
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

  const doCancelImport = async (jobId: string) => {
    try {
      await cancelDriveImport(bucket.id, jobId);
      toast.info(t.toast.importCancelled);
    } catch (cause) {
      toast.fromError(t.toast.importFailed, cause);
    }
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
      toast.success(t.toast.importStarted, selectedFolder.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.importFailed, cause);
    }
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
        .then((updated) => {
          setBackupTransfers((list) => list.map((item) => (item.id === updated.id ? updated : item)));
          if (updated.status === "completed") toast.success(t.toast.backupFinished(updated.copied));
          else if (updated.status === "cancelled") toast.info(t.toast.backupCancelled);
          else if (updated.status === "failed") toast.error(t.toast.backupFailed, updated.lastError ?? undefined);
        })
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
      toast.success(t.toast.backupStarted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.backupFailed, cause);
    }
    finally { setBackupBusy(false); }
  };

  const doCancelBackup = async (transferId: string) => {
    try {
      await cancelBucketBackup(bucket.id, transferId);
      setBackupTransfers((list) => list.map((item) => (item.id === transferId ? { ...item, status: "cancel_requested" } : item)));
      toast.info(t.toast.backupCancelled);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.backupFailed, cause);
    }
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
    const uploadedKey = key;
    try {
      await uploadObject(bucket.id, key, file);
      setShowUpload(false); setFile(null); setKey("");
      if (fileInput.current) fileInput.current.value = "";
      toast.success(t.toast.objectUploaded(uploadedKey));
      await load(prefix.trim());
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.objectUploadFailed, cause);
    }
    finally { setUploading(false); }
  };

  const doDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    const deletedKey = deleteTarget.key;
    try {
      await deleteObject(bucket.id, deleteTarget.id);
      setDeleteTarget(null);
      toast.success(t.toast.objectDeleted(deletedKey));
      await load(prefix.trim());
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.objectDeleteFailed, cause);
    }
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
    try {
      setGenerated(await createPresignedLink(bucket.id, linkTarget.id, credentialId, expiresSeconds));
      toast.success(t.toast.presignedCreated);
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.presignedFailed, cause);
    }
    finally { setLinkBusy(false); }
  };

  const openVersions = async (object: ObjectItem) => {
    setVersionTarget(object);
    setVersions([]);
    setVersionBusy(true);
    setError(null);
    try {
      setVersions(await listObjectVersions(bucket.id, object.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setVersionBusy(false);
    }
  };

  const removeVersion = async (versionId: string) => {
    if (!versionTarget) return;
    setVersionBusy(true);
    try {
      await deleteObjectVersion(bucket.id, versionTarget.id, versionId);
      setVersions(await listObjectVersions(bucket.id, versionTarget.id));
      toast.success(t.toast.versionsPruned);
    } catch (cause) {
      toast.fromError(t.toast.versionsFailed, cause);
    } finally {
      setVersionBusy(false);
    }
  };

  const openUploadForm = async () => {
    setShowUploadForm(true); setUploadForm(null); setUploadFormBusy(true); setError(null);
    try {
      const creds = await listCredentials();
      const active = creds.filter((credential) => credential.status === "active");
      setCredentials(active); setCredentialId(active[0]?.id ?? "");
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setUploadFormBusy(false); }
  };

  const generateUploadForm = async () => {
    if (!credentialId) return;
    setUploadFormBusy(true);
    try {
      setUploadForm(await createPresignedPost(
        bucket.id,
        credentialId,
        uploadFormPrefix,
        uploadFormExpires,
        uploadFormMaxMb * 1024 * 1024,
      ));
      toast.success(t.toast.presignedPostCreated);
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.presignedPostFailed, cause);
    }
    finally { setUploadFormBusy(false); }
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
      toast.success(t.toast.publicLinkCreated);
    }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.publicLinkFailed, cause);
    }
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
      toast.success(t.toast.publicLinkRevoked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.publicLinkFailed, cause);
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
      {importJob ? <Alert variant={importJob.status === "failed" ? "destructive" : "default"}><CloudDownload /><AlertTitle>{t.objects.importAlertTitle(importJob.status)}</AlertTitle><AlertDescription><p>{t.objects.importAlertDescription({ sourceFolderName: importJob.sourceFolderName, discovered: importJob.discovered, imported: importJob.imported, conflicts: importJob.conflicts, unsupported: importJob.unsupported, failed: importJob.failed })}</p>{importJob.lastError ? <p>{importJob.lastError}</p> : null}<div className="mt-3 flex gap-2">{!["completed", "cancelled", "failed"].includes(importJob.status) ? <Button size="sm" variant="outline" onClick={() => void doCancelImport(importJob.id)}>{t.objects.cancelImport}</Button> : null}{["completed", "cancelled", "failed"].includes(importJob.status) ? <Button size="sm" variant="outline" onClick={() => void listDriveImportIssues(bucket.id, importJob.id).then((page) => setImportIssues(page.items))}>{t.objects.viewReport}</Button> : null}</div></AlertDescription></Alert> : null}
      {importIssues.length ? <Table><TableHeader><TableRow><TableHead>{t.objects.issueKey}</TableHead><TableHead>{t.objects.issueStatus}</TableHead><TableHead>{t.objects.issueReason}</TableHead></TableRow></TableHeader><TableBody>{importIssues.map((issue) => <TableRow key={issue.id}><TableRowHeader className="max-w-80 break-all font-mono text-xs">{issue.key}</TableRowHeader><TableCell>{issue.status}</TableCell><TableCell>{issue.reason ?? "-"}</TableCell></TableRow>)}</TableBody></Table> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-between"><form onSubmit={search} role="search" className="flex flex-1 gap-2"><Input placeholder={t.objects.filterPlaceholder} value={prefix} onChange={(event) => setPrefix(event.target.value)} aria-label={t.objects.filterAriaLabel} /><Button type="submit" variant="outline" disabled={loading}><Search /> <span className="hidden sm:inline">{t.objects.search}</span></Button></form><div className="flex gap-2">{owner ? <Button variant="outline" onClick={() => void openImport()}><CloudDownload /> {t.objects.importFromDrive}</Button> : null}{owner ? <Button variant="outline" onClick={() => void openBackup()}><HardDriveDownload /> {t.backup.button}</Button> : null}{writable ? <Button variant="outline" onClick={() => void openUploadForm()}><FileCode2 /> {t.objects.uploadFormAction}</Button> : null}{writable ? <Button onClick={() => setShowUpload(true)}><Plus /> {t.objects.upload}</Button> : null}</div></div>

      {loading ? <LoadingState label={t.objects.loading} /> : items.length === 0 ? <EmptyState icon={Files} title={t.objects.emptyTitle} description={writable ? t.objects.emptyDescriptionWritable : t.objects.emptyDescriptionReadonly} /> : <><Table><TableHeader><TableRow><TableHead>{t.objects.tableKey}</TableHead><TableHead>{t.objects.tableSize}</TableHead><TableHead>{t.objects.tableType}</TableHead><TableHead>{t.objects.tableModified}</TableHead><TableHead className="text-right">{t.objects.tableAction}</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id}><TableRowHeader className="max-w-80 break-all font-mono text-xs">{item.key}</TableRowHeader><TableCell className="whitespace-nowrap">{humanBytes(item.size)}</TableCell><TableCell className="max-w-48 break-all">{item.contentType}</TableCell><TableCell className="whitespace-nowrap">{new Date(item.lastModified).toLocaleString()}</TableCell><TableCell><div className="flex justify-end gap-1"><Button size="icon" variant="ghost" title={t.objects.download} aria-label={t.objects.downloadLabel(item.key)} asChild><a href={objectDownloadUrl(bucket.id, item.id)}><ArrowDownToLine /></a></Button>{isPreviewable(item.contentType) ? <Button size="icon" variant="ghost" title={t.objects.preview} aria-label={t.objects.previewLabel(item.key)} onClick={() => window.open(objectPreviewUrl(bucket.id, item.id), "_blank", "noopener,noreferrer")}><Eye /></Button> : null}{owner ? <Button size="icon" variant="ghost" title={t.objects.publicLink} aria-label={t.objects.publicLinkLabel(item.key)} onClick={() => void openLinks(item)}><Link2 /></Button> : null}{writable ? <Button size="icon" variant="ghost" title={t.objects.versionsTitle} aria-label={t.objects.versionsLabel(item.key)} onClick={() => void openVersions(item)}><History /></Button> : null}{writable ? <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" title={t.objects.deleteTitle} aria-label={t.objects.deleteLabel(item.key)} onClick={() => setDeleteTarget(item)}><Trash2 /></Button> : null}</div></TableCell></TableRow>)}</TableBody></Table>{nextAfter ? <div className="flex justify-center"><Button variant="outline" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? t.common.loadingMore : t.common.loadMore}</Button></div> : null}</>}
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

      <Dialog open={showUploadForm} onOpenChange={(open) => { if (!uploadFormBusy) { setShowUploadForm(open); if (!open) setUploadForm(null); } }}>
        <DialogContent className="min-w-0 max-h-[90vh] max-w-2xl overflow-x-hidden overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t.objects.uploadFormDialogTitle}</DialogTitle>
            <DialogDescription>{t.objects.uploadFormDialogDescription}</DialogDescription>
          </DialogHeader>
          {credentials.length === 0 && !uploadFormBusy ? (
            <Alert>
              <AlertTitle>{t.objects.noActiveKeyTitle}</AlertTitle>
              <AlertDescription>{t.objects.noActiveKeyDescription}</AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t.objects.uploadFormDescription}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="upload-form-prefix">{t.objects.uploadFormPrefixLabel}</Label>
                  <Input
                    id="upload-form-prefix"
                    value={uploadFormPrefix}
                    placeholder={t.objects.uploadFormPrefixPlaceholder}
                    maxLength={512}
                    onChange={(event) => setUploadFormPrefix(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t.objects.uploadFormPrefixHint}</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="upload-form-max">{t.objects.uploadFormMaxSizeLabel}</Label>
                  <Input
                    id="upload-form-max"
                    type="number"
                    min={1}
                    max={5120}
                    value={uploadFormMaxMb}
                    onChange={(event) => setUploadFormMaxMb(Math.max(1, Number(event.target.value) || 1))}
                  />
                  <p className="text-xs text-muted-foreground">{humanBytes(uploadFormMaxMb * 1024 * 1024)}</p>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Select
                  ariaLabel={t.objects.uploadFormCredentialAriaLabel}
                  value={credentialId}
                  onValueChange={setCredentialId}
                  options={credentials.map((credential) => ({ value: credential.id, label: `${credential.label} · ${credential.access_key_id}` }))}
                />
                <Select
                  ariaLabel={t.objects.uploadFormExpiryAriaLabel}
                  value={String(uploadFormExpires)}
                  onValueChange={(value) => setUploadFormExpires(Number(value))}
                  options={EXPIRY_OPTIONS}
                />
              </div>
              <Button variant="outline" disabled={uploadFormBusy || !credentialId} onClick={() => void generateUploadForm()}>
                {t.objects.uploadFormGenerate}
              </Button>

              {uploadForm ? (
                <div className="space-y-3 border-t pt-4">
                  <div className="space-y-1">
                    <Label>{t.objects.uploadFormResultTitle} {new Date(uploadForm.expiresAt).toLocaleString()}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t.objects.uploadFormKeyTemplate}: <span className="font-mono">{uploadForm.keyTemplate}</span> · {t.objects.uploadFormFileLast}
                    </p>
                  </div>
                  <CopyableCode value={uploadForm.url} label={t.objects.uploadFormEndpointLabel} />
                  <CopyableCode value={htmlSnippet(uploadForm)} label={t.objects.uploadFormHtmlLabel} />
                  <CopyableCode value={curlSnippet(uploadForm)} label={t.objects.uploadFormCurlLabel} />
                </div>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => { setShowUploadForm(false); setUploadForm(null); }} disabled={uploadFormBusy}>
              {t.credentials.done}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(versionTarget)} onOpenChange={(open) => { if (!open && !versionBusy) { setVersionTarget(null); setVersions([]); } }}>
        <DialogContent className="min-w-0 max-h-[90vh] max-w-2xl overflow-x-hidden overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t.objects.versionsTitle}</DialogTitle>
            <DialogDescription className="break-all">
              <span className="font-mono">{versionTarget?.key}</span> — {t.objects.versionsDialogDescription}
            </DialogDescription>
          </DialogHeader>
          {versionBusy && versions.length === 0 ? (
            <LoadingState label={t.objects.loadingVersions} />
          ) : versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.objects.versionsEmpty}</p>
          ) : (
            <div className="space-y-2">
              {versions.map((version) => (
                <div key={version.versionId} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-xs">{version.versionId}</span>
                      {version.isLatest ? <Badge variant="success">{t.objects.versionCurrent}</Badge> : null}
                      {version.isDeleteMarker ? <Badge variant="warning">{t.objects.versionDeleteMarker}</Badge> : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {new Date(version.lastModified).toLocaleString()}
                      {version.isDeleteMarker ? "" : ` · ${humanBytes(version.size)}`}
                    </p>
                  </div>
                  {version.isLatest ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      aria-label={t.objects.versionDeleteLabel(version.versionId)}
                      disabled={versionBusy}
                      onClick={() => void removeVersion(version.versionId)}
                    >
                      <Trash2 /> {t.objects.versionDelete}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => { setVersionTarget(null); setVersions([]); }} disabled={versionBusy}>
              {t.credentials.done}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(revokeTarget)} onOpenChange={(open) => { if (!open && !revokingLink) setRevokeTarget(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t.objects.revokeLinkConfirmTitle}</AlertDialogTitle><AlertDialogDescription>Link <span className="font-medium">{revokeTarget?.label}</span> {t.objects.revokeLinkConfirmDescriptionSuffix}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={revokingLink}>{t.common.cancel}</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={revokingLink} onClick={(event) => { event.preventDefault(); if (revokeTarget) void revokeLink(revokeTarget.id); }}>{revokingLink ? t.objects.revoking : t.objects.revoke}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  );
}
