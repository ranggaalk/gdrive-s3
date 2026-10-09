import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Activity, ArrowDownToLine, ArrowLeft, CloudDownload, Copy, Eye, FileCode2, Files, Folder, HardDriveDownload, History, Link2, Plus, Search, Trash2 } from "lucide-react";
import { Alert, AlertDialog, Button, buttonVariants, Chip, Focusable, Input, Label, Modal, Table, Tooltip } from "@heroui/react";
import { Select } from "@/components/ui/select";
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
  copyObjectTo,
  createPresignedPost,
  deleteObjectVersion,
  listBuckets,
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
  const BACKUP_STATUS_COLOR: Record<BackupTransfer["status"], "default" | "success" | "warning" | "danger"> = {
    queued: "default",
    running: "warning",
    cancel_requested: "warning",
    completed: "success",
    cancelled: "default",
    failed: "danger",
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
  const [copyTarget, setCopyTarget] = useState<ObjectItem | null>(null);
  const [copyBuckets, setCopyBuckets] = useState<Bucket[]>([]);
  const [copyBucketId, setCopyBucketId] = useState("");
  const [copyKey, setCopyKey] = useState("");
  const [copyBusy, setCopyBusy] = useState(false);
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

  const openCopy = async (object: ObjectItem) => {
    setCopyTarget(object);
    setCopyKey(object.key);
    setCopyBusy(true);
    setError(null);
    try {
      const all = await listBuckets();
      // Only somewhere the caller can actually write, and not back into the
      // bucket they are already looking at.
      const targets = all.filter((b) => b.id !== bucket.id && b.effectiveRole !== "viewer");
      setCopyBuckets(targets);
      setCopyBucketId(targets[0]?.id ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCopyBusy(false);
    }
  };

  const doCopy = async () => {
    if (!copyTarget || !copyBucketId || !copyKey.trim()) return;
    setCopyBusy(true);
    try {
      await copyObjectTo(bucket.id, copyTarget.id, copyBucketId, copyKey.trim());
      toast.success(t.toast.objectCopied);
      setCopyTarget(null);
    } catch (cause) {
      toast.fromError(t.toast.objectCopyFailed, cause);
    } finally {
      setCopyBusy(false);
    }
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
      <div>
        <Button variant="ghost" className="-ml-3" onPress={onBack}><ArrowLeft /> {t.login.backToBuckets}</Button>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <h2 className="break-all text-xl font-semibold">{bucket.name}</h2>
          <Chip>{bucket.storageDisplayName}</Chip>
          {bucket.effectiveRole === "viewer" ? (
            <Chip variant="tertiary">{roleLabel(bucket.effectiveRole)}</Chip>
          ) : (
            <Chip color="accent" variant="soft">{roleLabel(bucket.effectiveRole)}</Chip>
          )}
        </div>
      </div>
      {bucket.storageStatus !== "active" ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.objects.driveAccessIssueTitle}</Alert.Title>
            <Alert.Description>{t.objects.driveAccessIssueDescription(bucket.storageDisplayName)}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {bucket.effectiveRole === "viewer" ? (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.objects.viewerAccessTitle}</Alert.Title>
            <Alert.Description>{t.objects.viewerAccessDescription}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {error ? <ErrorAlert message={error} /> : null}

      <div className="grid w-fit grid-cols-2 gap-2">
        <Button fullWidth variant={view === "objects" ? "primary" : "outline"} onPress={() => setView("objects")}><Files /> {t.objects.viewObjects}</Button>
        <Button fullWidth variant={view === "traffic" ? "primary" : "outline"} onPress={() => setView("traffic")}><Activity /> {t.objects.viewTraffic}</Button>
      </div>

      {view === "traffic" ? (
        <Suspense fallback={<LoadingState label={t.objects.loadingTraffic} />}><BucketTraffic bucketId={bucket.id} /></Suspense>
      ) : (
        <>
          {importJob ? (
            <Alert status={importJob.status === "failed" ? "danger" : "default"}>
              <Alert.Indicator><CloudDownload className="size-4" /></Alert.Indicator>
              <Alert.Content>
                <Alert.Title>{t.objects.importAlertTitle(importJob.status)}</Alert.Title>
                <Alert.Description>
                  {t.objects.importAlertDescription({ sourceFolderName: importJob.sourceFolderName, discovered: importJob.discovered, imported: importJob.imported, conflicts: importJob.conflicts, unsupported: importJob.unsupported, failed: importJob.failed })}
                </Alert.Description>
                {importJob.lastError ? <Alert.Description>{importJob.lastError}</Alert.Description> : null}
                <div className="mt-3 flex gap-2">
                  {!["completed", "cancelled", "failed"].includes(importJob.status) ? (
                    <Button size="sm" variant="outline" onPress={() => void doCancelImport(importJob.id)}>{t.objects.cancelImport}</Button>
                  ) : null}
                  {["completed", "cancelled", "failed"].includes(importJob.status) ? (
                    <Button size="sm" variant="outline" onPress={() => void listDriveImportIssues(bucket.id, importJob.id).then((page) => setImportIssues(page.items))}>{t.objects.viewReport}</Button>
                  ) : null}
                </div>
              </Alert.Content>
            </Alert>
          ) : null}
          {importIssues.length ? (
            <Table>
              <Table.ScrollContainer>
                <Table.Content aria-label={t.objects.importIssuesTableLabel}>
                  <Table.Header>
                    <Table.Column isRowHeader>{t.objects.issueKey}</Table.Column>
                    <Table.Column>{t.objects.issueStatus}</Table.Column>
                    <Table.Column>{t.objects.issueReason}</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {importIssues.map((issue) => (
                      <Table.Row key={issue.id} id={issue.id}>
                        <Table.Cell className="max-w-80 break-all font-mono text-xs">{issue.key}</Table.Cell>
                        <Table.Cell>{issue.status}</Table.Cell>
                        <Table.Cell>{issue.reason ?? "-"}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
            <form onSubmit={search} role="search" className="flex flex-1 gap-2">
              <Input fullWidth placeholder={t.objects.filterPlaceholder} value={prefix} onChange={(event) => setPrefix(event.target.value)} aria-label={t.objects.filterAriaLabel} />
              <Button type="submit" variant="outline" isDisabled={loading}><Search /> <span className="hidden sm:inline">{t.objects.search}</span></Button>
            </form>
            <div className="flex flex-wrap gap-2">
              {owner ? <Button variant="outline" onPress={() => void openImport()}><CloudDownload /> {t.objects.importFromDrive}</Button> : null}
              {owner ? <Button variant="outline" onPress={() => void openBackup()}><HardDriveDownload /> {t.backup.button}</Button> : null}
              {writable ? <Button variant="outline" onPress={() => void openUploadForm()}><FileCode2 /> {t.objects.uploadFormAction}</Button> : null}
              {writable ? <Button onPress={() => setShowUpload(true)}><Plus /> {t.objects.upload}</Button> : null}
            </div>
          </div>

          {loading ? (
            <LoadingState label={t.objects.loading} />
          ) : items.length === 0 ? (
            <EmptyState icon={Files} title={t.objects.emptyTitle} description={writable ? t.objects.emptyDescriptionWritable : t.objects.emptyDescriptionReadonly} />
          ) : (
            <>
              <Table>
                <Table.ScrollContainer>
                  <Table.Content aria-label={t.objects.viewObjects}>
                    <Table.Header>
                      <Table.Column isRowHeader>{t.objects.tableKey}</Table.Column>
                      <Table.Column>{t.objects.tableSize}</Table.Column>
                      <Table.Column>{t.objects.tableType}</Table.Column>
                      <Table.Column>{t.objects.tableModified}</Table.Column>
                      <Table.Column className="text-end">{t.objects.tableAction}</Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {items.map((item) => (
                        <Table.Row key={item.id} id={item.id}>
                          <Table.Cell className="max-w-80 break-all font-mono text-xs">{item.key}</Table.Cell>
                          <Table.Cell className="whitespace-nowrap">{humanBytes(item.size)}</Table.Cell>
                          <Table.Cell className="max-w-48 break-all">{item.contentType}</Table.Cell>
                          <Table.Cell className="whitespace-nowrap">{new Date(item.lastModified).toLocaleString()}</Table.Cell>
                          <Table.Cell>
                            {/* Each action is icon-only, so a tooltip carries its name. A
                                role-gated one stays `{gate ? <Tooltip><Button`, the shape
                                ui-permission-gates.test.ts reads. */}
                            <div className="flex justify-end gap-1">
                              <Tooltip delay={300}>
                                <Focusable>
                                  <a
                                    href={objectDownloadUrl(bucket.id, item.id)}
                                    className={buttonVariants({ variant: "ghost", size: "sm", isIconOnly: true })}
                                    aria-label={t.objects.downloadLabel(item.key)}
                                  >
                                    <ArrowDownToLine />
                                  </a>
                                </Focusable>
                                <Tooltip.Content>{t.objects.download}</Tooltip.Content>
                              </Tooltip>
                              {isPreviewable(item.contentType) ? (
                                <Tooltip delay={300}>
                                  <Button isIconOnly size="sm" variant="ghost" aria-label={t.objects.previewLabel(item.key)} onPress={() => window.open(objectPreviewUrl(bucket.id, item.id), "_blank", "noopener,noreferrer")}><Eye /></Button>
                                  <Tooltip.Content>{t.objects.preview}</Tooltip.Content>
                                </Tooltip>
                              ) : null}
                              {owner ? <Tooltip delay={300}><Button isIconOnly size="sm" variant="ghost" aria-label={t.objects.publicLinkLabel(item.key)} onPress={() => void openLinks(item)}><Link2 /></Button><Tooltip.Content>{t.objects.publicLink}</Tooltip.Content></Tooltip> : null}
                              <Tooltip delay={300}>
                                <Button isIconOnly size="sm" variant="ghost" aria-label={t.objects.copyLabel(item.key)} onPress={() => void openCopy(item)}><Copy /></Button>
                                <Tooltip.Content>{t.objects.copyTitle}</Tooltip.Content>
                              </Tooltip>
                              <Tooltip delay={300}>
                                <Button isIconOnly size="sm" variant="ghost" aria-label={t.objects.versionsLabel(item.key)} onPress={() => void openVersions(item)}><History /></Button>
                                <Tooltip.Content>{t.objects.versionsTitle}</Tooltip.Content>
                              </Tooltip>
                              {writable ? <Tooltip delay={300}><Button isIconOnly size="sm" variant="ghost" className="text-danger" aria-label={t.objects.deleteLabel(item.key)} onPress={() => setDeleteTarget(item)}><Trash2 /></Button><Tooltip.Content>{t.objects.deleteTitle}</Tooltip.Content></Tooltip> : null}
                            </div>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
              {nextAfter ? (
                <div className="flex justify-center">
                  <Button variant="outline" isDisabled={loadingMore} onPress={() => void more()}>{loadingMore ? t.common.loadingMore : t.common.loadMore}</Button>
                </div>
              ) : null}
            </>
          )}
        </>
      )}

      <Modal.Backdrop isOpen={showImport} onOpenChange={(open) => { if (!importBusy) setShowImport(open); }}>
        <Modal.Container size="lg">
          <Modal.Dialog className="max-w-2xl">
            <Modal.CloseTrigger aria-label={t.common.close} />
            <Modal.Header>
              <Modal.Heading>{t.objects.importDialogTitle}</Modal.Heading>
              <p className="text-sm text-muted">{t.objects.importDialogDescription}</p>
            </Modal.Header>
            <Modal.Body className="space-y-4 text-foreground">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Select
                    label={t.objects.locationLabel}
                    value={importKind}
                    options={importKindOptions}
                    onValueChange={(kind) => {
                      setImportKind(kind);
                      const driveId = kind === "shared_drive" ? sharedDrives[0]?.id ?? "" : "";
                      setImportDriveId(driveId);
                      setFolderStack([]);
                      setSelectedFolder(null);
                      if (kind === "shared_drive" && !driveId) {
                        setDriveFolders([]);
                        setSelectedFolder(null);
                      } else {
                        void browseFolders(kind, driveId, []);
                      }
                    }}
                  />
                  {noSharedDrives ? <p className="text-xs text-muted">{t.objects.noSharedDriveAccessible}</p> : null}
                </div>
                {importKind === "shared_drive" ? (
                  <Select
                    label={t.objects.sharedDriveLabel}
                    value={importDriveId}
                    options={sharedDrives.map((drive) => ({ value: drive.id, label: drive.name }))}
                    placeholder={t.objects.pickSharedDrive}
                    onValueChange={(driveId) => {
                      setImportDriveId(driveId);
                      setFolderStack([]);
                      setSelectedFolder(null);
                      void browseFolders("shared_drive", driveId, []);
                    }}
                  />
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Button
                  size="sm"
                  variant="ghost"
                  isDisabled={folderStack.length === 0 || importBusy}
                  onPress={() => {
                    const stack = folderStack.slice(0, -1);
                    setFolderStack(stack);
                    setSelectedFolder(null);
                    void browseFolders(importKind, importDriveId, stack);
                  }}
                >
                  {t.objects.up}
                </Button>
                <span className="text-muted">/{folderStack.map((folder) => folder.name).join("/")}</span>
              </div>
              <div className="max-h-72 space-y-1 overflow-y-auto rounded-xl border p-2">
                {importBusy ? (
                  <LoadingState label={t.objects.loadingTraffic} />
                ) : driveFolders.length === 0 ? (
                  <p className="p-4 text-sm text-muted">{t.objects.noSubfolders}</p>
                ) : (
                  driveFolders.map((folder) => (
                    <div key={folder.id} className={`flex items-center justify-between rounded-lg p-2 ${selectedFolder?.id === folder.id ? "bg-default" : ""}`}>
                      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setSelectedFolder(folder)}>
                        <Folder className="size-4 shrink-0" />
                        <span className="truncate">{folder.name}</span>
                      </button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onPress={() => {
                          const stack = [...folderStack, folder];
                          setFolderStack(stack);
                          setSelectedFolder(null);
                          void browseFolders(importKind, importDriveId, stack);
                        }}
                      >
                        {t.objects.open}
                      </Button>
                    </div>
                  ))
                )}
              </div>
              {selectedFolder ? (
                <Alert>
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{t.objects.folderSelectedTitle}</Alert.Title>
                    <Alert.Description>{selectedFolder.name}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary" isDisabled={importBusy}>{t.common.cancel}</Button>
              <Button isDisabled={!selectedFolder || importBusy || (importKind === "shared_drive" && !importDriveId)} onPress={() => void startImport()}>
                {importBusy ? t.objects.preparing : t.objects.startImport}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={showBackup} onOpenChange={(open) => { if (!backupBusy) setShowBackup(open); }}>
        <Modal.Container size="lg">
          <Modal.Dialog className="max-w-2xl">
            <Modal.CloseTrigger aria-label={t.common.close} />
            <Modal.Header>
              <Modal.Heading>{t.backup.dialogTitle}</Modal.Heading>
              <p className="text-sm text-muted">{t.backup.dialogDescription}</p>
            </Modal.Header>
            <Modal.Body className="space-y-4 text-foreground">
              {backupAccounts.length === 0 ? (
                <Alert>
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{t.backup.noAccountsTitle}</Alert.Title>
                    <Alert.Description>{t.backup.noAccountsDescription}</Alert.Description>
                    {onOpenBackupAccounts ? (
                      <Button size="sm" variant="outline" className="mt-2" onPress={() => { setShowBackup(false); onOpenBackupAccounts(); }}>
                        {t.backup.openBackupPage}
                      </Button>
                    ) : null}
                  </Alert.Content>
                </Alert>
              ) : (
                <div className="space-y-2">
                  <Select
                    label={t.backup.targetAccountLabel}
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
                      isDisabled={!backupAccountId || backupBusy || Boolean(activeBackupTransfer)}
                      onPress={() => void doStartBackup()}
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
                  <p className="rounded-xl border p-4 text-sm text-muted">{t.backup.noHistory}</p>
                ) : (
                  <div className="max-h-72 space-y-2 overflow-y-auto">
                    {backupTransfers.map((transfer) => {
                      const account = backupAccounts.find((a) => a.id === transfer.backupAccountId);
                      const isActive =
                        transfer.status === "queued" || transfer.status === "running" || transfer.status === "cancel_requested";
                      const color = BACKUP_STATUS_COLOR[transfer.status];
                      return (
                        <div key={transfer.id} className="space-y-1 rounded-xl border p-3 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="truncate font-medium">{account?.email ?? transfer.backupAccountId}</span>
                            <div className="flex items-center gap-2">
                              <Chip size="sm" color={color} variant={color === "default" ? "secondary" : "soft"}>{BACKUP_STATUS_LABEL[transfer.status]}</Chip>
                              {isActive ? (
                                <Button size="sm" variant="ghost" onPress={() => void doCancelBackup(transfer.id)}>{t.backup.cancelRun}</Button>
                              ) : null}
                            </div>
                          </div>
                          <p className="text-xs text-muted">
                            {t.backup.progressSummary({ copied: transfer.copied, skipped: transfer.skipped, failed: transfer.failed, total: transfer.total })}
                          </p>
                          {transfer.lastError ? <p className="text-xs text-danger">{transfer.lastError}</p> : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="outline">{t.common.close}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={showUpload} onOpenChange={(open) => { if (!uploading) setShowUpload(open); }}>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger aria-label={t.common.close} />
            <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void doUpload(event)}>
              <Modal.Header>
                <Modal.Heading>{t.objects.uploadDialogTitle}</Modal.Heading>
                <p className="text-sm text-muted">{t.objects.uploadDialogDescription}</p>
              </Modal.Header>
              <Modal.Body className="space-y-4 text-foreground">
                <div className="space-y-2">
                  <Label htmlFor="object-file">{t.objects.fileLabel}</Label>
                  <Input
                    ref={fileInput}
                    id="object-file"
                    type="file"
                    fullWidth
                    onChange={(event) => {
                      const selected = event.target.files?.[0] ?? null;
                      setFile(selected);
                      if (selected) setKey(selected.name);
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="object-key">{t.objects.objectKeyLabel}</Label>
                  <Input id="object-key" fullWidth value={key} onChange={(event) => setKey(event.target.value)} maxLength={1024} />
                </div>
                {file ? <p className="text-sm text-muted">{humanBytes(file.size)} · {file.type || "application/octet-stream"}</p> : null}
              </Modal.Body>
              <Modal.Footer>
                <Button slot="close" variant="tertiary" isDisabled={uploading}>{t.common.cancel}</Button>
                <Button type="submit" isDisabled={!file || !key.trim() || uploading}>{uploading ? t.objects.uploading : t.objects.upload}</Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <AlertDialog.Backdrop isOpen={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>{t.objects.deleteConfirmTitle}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>Namespace <span className="break-all font-mono">{deleteTarget?.key}</span> {t.objects.deleteConfirmDescription}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={deleting}>{t.common.cancel}</Button>
              <Button variant="danger" isDisabled={deleting} onPress={() => void doDelete()}>{deleting ? t.common.deleting : t.common.delete}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <Modal.Backdrop isOpen={Boolean(linkTarget)} onOpenChange={(open) => { if (!open && !linkBusy) { setLinkTarget(null); setGenerated(null); setLinkLoaded(false); } }}>
        <Modal.Container size="lg">
          <Modal.Dialog className="max-w-2xl">
            <Modal.CloseTrigger aria-label={t.common.close} />
            <Modal.Header>
              <Modal.Heading>{t.objects.publicLinkDialogTitle}</Modal.Heading>
              <p className="text-sm text-muted">
                {t.objects.publicLinkDialogDescriptionPrefix} <span className="break-all font-mono">{linkTarget?.key}</span>{t.objects.publicLinkDialogDescriptionSuffix}
              </p>
            </Modal.Header>
            <Modal.Body className="space-y-4 text-foreground">
              {!linkLoaded ? (
                <LoadingState label={t.objects.loadingLinkSettings} />
              ) : (
                <>
                  {generated ? (
                    <div className="space-y-2">
                      <Label>{t.objects.newUrlLabel}</Label>
                      <CopyableCode value={generated.url} label={t.objects.publicUrlCopyLabel} />
                      <p className="text-xs text-muted">
                        {generated.expiresAt ? t.objects.validUntil(new Date(generated.expiresAt).toLocaleString()) : t.objects.validUntilRevoked}
                      </p>
                    </div>
                  ) : null}
                  <div className="grid gap-6 md:grid-cols-2">
                    <section className="space-y-3">
                      <h3 className="font-medium">{t.objects.presignedTitle}</h3>
                      <p className="text-sm text-muted">{t.objects.presignedDescription}</p>
                      {credentials.length ? (
                        <>
                          <Select
                            ariaLabel={t.objects.presignedCredentialAriaLabel}
                            value={credentialId}
                            onValueChange={setCredentialId}
                            options={credentials.map((credential) => ({ value: credential.id, label: `${credential.label} · ${credential.access_key_id}` }))}
                          />
                          <Select
                            ariaLabel={t.objects.presignedExpiryAriaLabel}
                            value={String(expiresSeconds)}
                            onValueChange={(value) => setExpiresSeconds(Number(value))}
                            options={EXPIRY_OPTIONS}
                          />
                          <Button variant="outline" isDisabled={linkBusy} onPress={() => void temporaryLink()}>{t.objects.generateTemporary}</Button>
                        </>
                      ) : (
                        <Alert>
                          <Alert.Indicator />
                          <Alert.Content>
                            <Alert.Title>{t.objects.noActiveKeyTitle}</Alert.Title>
                            <Alert.Description>{t.objects.noActiveKeyDescription}</Alert.Description>
                          </Alert.Content>
                        </Alert>
                      )}
                    </section>
                    <section className="space-y-3">
                      <h3 className="font-medium">{t.objects.persistentTitle}</h3>
                      <p className="text-sm text-muted">{t.objects.persistentDescription}</p>
                      <Input fullWidth value={publicLabel} maxLength={100} onChange={(event) => setPublicLabel(event.target.value)} placeholder={t.objects.linkLabelPlaceholder} />
                      <Input fullWidth type="datetime-local" min={new Date().toISOString().slice(0, 16)} value={publicExpiresAt} onChange={(event) => setPublicExpiresAt(event.target.value)} />
                      <Button variant="outline" isDisabled={linkBusy || !publicLabel.trim()} onPress={() => void persistentLink()}>{t.objects.createPermanentLink}</Button>
                    </section>
                  </div>
                  {publicLinks.length ? (
                    <div className="space-y-2">
                      <h3 className="font-medium">{t.objects.permanentLinksTitle}</h3>
                      {publicLinks.map((link) => (
                        <div key={link.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{link.label}</p>
                            <p className="text-xs text-muted">
                              {link.status === "active" ? link.expiresAt ? t.objects.activeUntil(new Date(link.expiresAt).toLocaleString()) : t.objects.activeNoExpiry : t.objects.revoked}
                            </p>
                          </div>
                          {link.status === "active" ? (
                            <Button size="sm" variant="danger" isDisabled={linkBusy} onPress={() => setRevokeTarget(link)}>{t.objects.revoke}</Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button isDisabled={linkBusy} onPress={() => { setLinkTarget(null); setGenerated(null); setLinkLoaded(false); }}>{t.credentials.done}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={showUploadForm} onOpenChange={(open) => { if (!uploadFormBusy) { setShowUploadForm(open); if (!open) setUploadForm(null); } }}>
        <Modal.Container size="lg">
          <Modal.Dialog className="max-w-2xl">
            <Modal.CloseTrigger aria-label={t.common.close} />
            <Modal.Header>
              <Modal.Heading>{t.objects.uploadFormDialogTitle}</Modal.Heading>
              <p className="text-sm text-muted">{t.objects.uploadFormDialogDescription}</p>
            </Modal.Header>
            <Modal.Body className="text-foreground">
              {credentials.length === 0 && !uploadFormBusy ? (
                <Alert>
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{t.objects.noActiveKeyTitle}</Alert.Title>
                    <Alert.Description>{t.objects.noActiveKeyDescription}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : (
                <div className="space-y-4">
                  <p className="text-sm text-muted">{t.objects.uploadFormDescription}</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="upload-form-prefix">{t.objects.uploadFormPrefixLabel}</Label>
                      <Input
                        id="upload-form-prefix"
                        fullWidth
                        value={uploadFormPrefix}
                        placeholder={t.objects.uploadFormPrefixPlaceholder}
                        maxLength={512}
                        onChange={(event) => setUploadFormPrefix(event.target.value)}
                      />
                      <p className="text-xs text-muted">{t.objects.uploadFormPrefixHint}</p>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="upload-form-max">{t.objects.uploadFormMaxSizeLabel}</Label>
                      <Input
                        id="upload-form-max"
                        type="number"
                        fullWidth
                        min={1}
                        max={5120}
                        value={uploadFormMaxMb}
                        onChange={(event) => setUploadFormMaxMb(Math.max(1, Number(event.target.value) || 1))}
                      />
                      <p className="text-xs text-muted">{humanBytes(uploadFormMaxMb * 1024 * 1024)}</p>
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
                  <Button variant="outline" isDisabled={uploadFormBusy || !credentialId} onPress={() => void generateUploadForm()}>
                    {t.objects.uploadFormGenerate}
                  </Button>

                  {uploadForm ? (
                    <div className="space-y-3 border-t border-separator pt-4">
                      <div className="space-y-1">
                        <Label>{t.objects.uploadFormResultTitle} {new Date(uploadForm.expiresAt).toLocaleString()}</Label>
                        <p className="text-xs text-muted">
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
            </Modal.Body>
            <Modal.Footer>
              <Button isDisabled={uploadFormBusy} onPress={() => { setShowUploadForm(false); setUploadForm(null); }}>
                {t.credentials.done}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={Boolean(copyTarget)} onOpenChange={(open) => { if (!open && !copyBusy) setCopyTarget(null); }}>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger aria-label={t.common.close} />
            <Modal.Header>
              <Modal.Heading>{t.objects.copyTitle}</Modal.Heading>
              <p className="text-sm text-muted">
                <span className="break-all font-mono">{copyTarget?.key}</span> — {t.objects.copyDialogDescription}
              </p>
            </Modal.Header>
            <Modal.Body className="text-foreground">
              {copyBuckets.length === 0 && !copyBusy ? (
                <Alert>
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{t.objects.copyNoTargets}</Alert.Title>
                  </Alert.Content>
                </Alert>
              ) : (
                <div className="space-y-4">
                  <Select
                    label={t.objects.copyTargetBucket}
                    value={copyBucketId}
                    onValueChange={setCopyBucketId}
                    options={copyBuckets.map((b) => ({ value: b.id, label: b.name }))}
                  />
                  <div className="space-y-2">
                    <Label htmlFor="copy-key">{t.objects.copyTargetKey}</Label>
                    <Input
                      id="copy-key"
                      fullWidth
                      value={copyKey}
                      maxLength={1024}
                      onChange={(event) => setCopyKey(event.target.value)}
                    />
                  </div>
                </div>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary" isDisabled={copyBusy}>
                {t.common.cancel}
              </Button>
              <Button
                isDisabled={copyBusy || !copyBucketId || !copyKey.trim()}
                onPress={() => void doCopy()}
              >
                {copyBusy ? t.objects.copying : t.objects.copyAction}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={Boolean(versionTarget)} onOpenChange={(open) => { if (!open && !versionBusy) { setVersionTarget(null); setVersions([]); } }}>
        <Modal.Container size="lg">
          <Modal.Dialog className="max-w-2xl">
            <Modal.CloseTrigger aria-label={t.common.close} />
            <Modal.Header>
              <Modal.Heading>{t.objects.versionsTitle}</Modal.Heading>
              <p className="text-sm text-muted">
                <span className="break-all font-mono">{versionTarget?.key}</span> — {t.objects.versionsDialogDescription}
              </p>
            </Modal.Header>
            <Modal.Body className="text-foreground">
              {versionBusy && versions.length === 0 ? (
                <LoadingState label={t.objects.loadingVersions} />
              ) : versions.length === 0 ? (
                <p className="text-sm text-muted">{t.objects.versionsEmpty}</p>
              ) : (
                <div className="space-y-2">
                  {versions.every((version) => version.versionId === "null") ? (
                    <p className="text-xs text-muted">{t.objects.versionsDisabledHint}</p>
                  ) : null}
                  {versions.map((version) => (
                    <div key={version.versionId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
                      {/* The badge row and the timestamp are two stacked lines, not
                          one wrapped one -- without the gap they read as a single
                          cramped block. */}
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {/* S3 reports 'null' as the version id for objects written
                              while versioning was off; showing that literally reads
                              as a bug rather than as "this object has no versions". */}
                          {version.versionId === "null" ? (
                            <span className="text-xs text-muted">{t.objects.versionUnversioned}</span>
                          ) : (
                            <span className="truncate font-mono text-xs">{version.versionId}</span>
                          )}
                          {version.isLatest ? <Chip size="sm" color="success" variant="soft">{t.objects.versionCurrent}</Chip> : null}
                          {version.isDeleteMarker ? <Chip size="sm" color="warning" variant="soft">{t.objects.versionDeleteMarker}</Chip> : null}
                        </div>
                        <p className="text-xs text-muted">
                          {new Date(version.lastModified).toLocaleString()}
                          {version.isDeleteMarker ? "" : ` · ${humanBytes(version.size)}`}
                        </p>
                      </div>
                      {version.isLatest || !writable ? null : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-danger"
                          aria-label={t.objects.versionDeleteLabel(version.versionId)}
                          isDisabled={versionBusy}
                          onPress={() => void removeVersion(version.versionId)}
                        >
                          <Trash2 /> {version.isDeleteMarker ? t.objects.versionRestore : t.objects.versionDelete}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button isDisabled={versionBusy} onPress={() => { setVersionTarget(null); setVersions([]); }}>
                {t.credentials.done}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <AlertDialog.Backdrop isOpen={Boolean(revokeTarget)} onOpenChange={(open) => { if (!open && !revokingLink) setRevokeTarget(null); }}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>{t.objects.revokeLinkConfirmTitle}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>Link <span className="font-medium">{revokeTarget?.label}</span> {t.objects.revokeLinkConfirmDescriptionSuffix}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={revokingLink}>{t.common.cancel}</Button>
              <Button variant="danger" isDisabled={revokingLink} onPress={() => { if (revokeTarget) void revokeLink(revokeTarget.id); }}>
                {revokingLink ? t.objects.revoking : t.objects.revoke}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  );
}
