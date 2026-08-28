import { useCallback, useEffect, useState, type FormEvent } from "react";
import { HardDrive, PackageOpen, Plus, Share2, Trash2, Users } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableRowHeader } from "@/components/ui/table";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { useToast } from "@/components/toast-provider";
import {
  addBucketMember,
  createBucket,
  deleteBucket,
  getBucketAccess,
  listBucketMembers,
  listBuckets,
  listSharedDrives,
  removeBucketMember,
  updateBucketAccess,
  updateBucketMember,
  listKmsKeys,
  pruneBucketVersions,
  type Bucket,
  type BucketAccessConfig,
  type BucketAcl,
  type BucketMember,
  type BucketVersioning,
  type KmsKey,
  type SseAlgorithm,
  type SharedDriveSummary,
  type StorageKind,
} from "../api/client.ts";

/** Re-indent a stored policy so the editor shows something readable. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

const POLICY_TEMPLATES = {
  publicRead: (bucket: string) =>
    JSON.stringify(
      {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "PublicRead",
            Effect: "Allow",
            Principal: "*",
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${bucket}/*`,
          },
        ],
      },
      null,
      2,
    ),
  grantUser: (bucket: string) =>
    JSON.stringify(
      {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "GrantOneUser",
            Effect: "Allow",
            Principal: { AWS: "arn:aws:iam:::user/someone@example.com" },
            Action: ["s3:GetObject", "s3:PutObject"],
            Resource: `arn:aws:s3:::${bucket}/*`,
          },
        ],
      },
      null,
      2,
    ),
};

export function BucketsPage({ onOpen }: { onOpen: (bucket: Bucket) => void }) {
  const { t } = useLocale();
  const toast = useToast();
  const ROLE_OPTIONS: Array<{ value: "viewer" | "editor"; label: string }> = [
    { value: "viewer", label: t.common.role.viewer },
    { value: "editor", label: t.common.role.editor },
  ];

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
  const [drivesLoaded, setDrivesLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Bucket | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [accessBucket, setAccessBucket] = useState<Bucket | null>(null);
  const [members, setMembers] = useState<BucketMember[]>([]);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<"viewer" | "editor">("viewer");
  const [memberBusy, setMemberBusy] = useState(false);
  const [accessTab, setAccessTab] = useState<"members" | "policy">("members");
  const [access, setAccess] = useState<BucketAccessConfig | null>(null);
  const [aclDraft, setAclDraft] = useState<BucketAcl>("private");
  const [policyDraft, setPolicyDraft] = useState("");
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [sseDraft, setSseDraft] = useState<SseAlgorithm | "none">("none");
  const [sseKeyDraft, setSseKeyDraft] = useState("");
  const [kmsKeys, setKmsKeys] = useState<KmsKey[]>([]);
  const [versioningDraft, setVersioningDraft] = useState<BucketVersioning>("Disabled");
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [pruning, setPruning] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try { setBuckets(await listBuckets()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadSharedDrives = async () => {
    if (drivesLoaded || drivesLoading) return;
    setDrivesLoading(true);
    setFormError(null);
    try {
      const page = await listSharedDrives();
      setSharedDrives(page.items);
      setDrivesLoaded(true);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrivesLoading(false);
    }
  };
  const writableSharedDrives = sharedDrives.filter((drive) => drive.canAddChildren);
  const noSharedDrives = drivesLoaded && writableSharedDrives.length === 0;

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
      toast.success(t.toast.bucketCreated(value));
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
      toast.fromError(t.toast.bucketCreateFailed, e);
    } finally {
      setCreating(false);
    }
  };

  const doDelete = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      const deletedName = pendingDelete.name;
      await deleteBucket(pendingDelete.id);
      setPendingDelete(null);
      toast.success(t.toast.bucketDeleted(deletedName));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPendingDelete(null);
      toast.fromError(t.toast.bucketDeleteFailed, e);
    } finally {
      setDeleting(false);
    }
  };

  const openAccess = async (bucket: Bucket) => {
    setAccessBucket(bucket);
    setMemberEmail("");
    setAccessTab("members");
    setPolicyError(null);
    setError(null);
    try {
      const [memberRows, accessConfig, keys] = await Promise.all([
        listBucketMembers(bucket.id),
        getBucketAccess(bucket.id),
        listKmsKeys().catch(() => [] as KmsKey[]),
      ]);
      setMembers(memberRows);
      setAccess(accessConfig);
      setAclDraft(accessConfig.acl);
      setPolicyDraft(accessConfig.policy ? prettyJson(accessConfig.policy) : "");
      setKmsKeys(keys);
      setVersioningDraft(accessConfig.versioning);
      setSseDraft(accessConfig.defaultSseAlgorithm ?? "none");
      setSseKeyDraft(accessConfig.defaultKmsKeyId ?? keys.find((k) => k.status === "active")?.id ?? "");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const doPruneVersions = async () => {
    if (!accessBucket) return;
    setPruning(true);
    try {
      await pruneBucketVersions(accessBucket.id);
      setAccess(await getBucketAccess(accessBucket.id));
      toast.success(t.toast.versionsPruned);
    } catch (cause) {
      toast.fromError(t.toast.versionsFailed, cause);
    } finally {
      setPruning(false);
      setConfirmPrune(false);
    }
  };

  const saveAccess = async () => {
    if (!accessBucket) return;
    const trimmed = policyDraft.trim();
    // Fail here rather than at the server so the operator sees which line is
    // wrong while the text is still in front of them.
    if (trimmed) {
      try { JSON.parse(trimmed); }
      catch (e) {
        setPolicyError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    setAccessBusy(true);
    setPolicyError(null);
    try {
      const updated = await updateBucketAccess(accessBucket.id, {
        acl: aclDraft,
        policy: trimmed === "" ? null : trimmed,
        defaultSseAlgorithm: sseDraft === "none" ? null : sseDraft,
        ...(sseDraft === "aws:kms" ? { defaultKmsKeyId: sseKeyDraft } : {}),
        // Disabled is not a value S3 accepts once versioning has been turned
        // on, so it is only ever sent as Enabled or Suspended.
        ...(versioningDraft === "Disabled" ? {} : { versioning: versioningDraft }),
      });
      setAccess(updated);
      setAclDraft(updated.acl);
      setPolicyDraft(updated.policy ? prettyJson(updated.policy) : "");
      setSseDraft(updated.defaultSseAlgorithm ?? "none");
      setSseKeyDraft(updated.defaultKmsKeyId ?? "");
      setVersioningDraft(updated.versioning);
      toast.success(t.toast.accessSaved);
    } catch (e) {
      setPolicyError(e instanceof Error ? e.message : String(e));
      toast.fromError(t.toast.accessFailed, e);
    } finally {
      setAccessBusy(false);
    }
  };

  const addMember = async (event: FormEvent) => {
    event.preventDefault();
    if (!accessBucket || !memberEmail.trim() || memberBusy) return;
    setMemberBusy(true);
    setError(null);
    try {
      const added = memberEmail.trim();
      await addBucketMember(accessBucket.id, added, memberRole);
      setMembers(await listBucketMembers(accessBucket.id));
      setMemberEmail("");
      toast.success(t.toast.memberAdded(added));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      toast.fromError(t.toast.memberAddFailed, e);
    } finally {
      setMemberBusy(false);
    }
  };

  if (loading) return <LoadingState label={t.buckets.loading} />;

  const roleLabel = (role: "owner" | "editor" | "viewer") =>
    role === "owner" ? t.common.role.owner : role === "editor" ? t.common.role.editor : t.common.role.viewer;

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      <div className="flex justify-end"><Button onClick={() => { setShowCreate(true); void loadSharedDrives(); }}><Plus /> {t.buckets.createButton}</Button></div>

      {buckets.length === 0 ? (
        <EmptyState icon={PackageOpen} title={t.buckets.emptyTitle} description={t.buckets.emptyDescription} />
      ) : (
        <Table>
            <TableHeader><TableRow><TableHead>{t.buckets.tableName}</TableHead><TableHead>{t.buckets.tableLocation}</TableHead><TableHead>{t.buckets.tableAccess}</TableHead><TableHead>{t.buckets.tableObjects}</TableHead><TableHead>{t.buckets.tableMultipart}</TableHead><TableHead>{t.buckets.tableStatus}</TableHead><TableHead>{t.buckets.tableCreated}</TableHead><TableHead className="text-right">{t.buckets.tableAction}</TableHead></TableRow></TableHeader>
            <TableBody>{buckets.map((bucket) => (
              <TableRow key={bucket.id}>
                <TableRowHeader><div className="flex flex-wrap items-center gap-2"><Button variant="link" className="h-auto p-0" onClick={() => onOpen(bucket)}>{bucket.name}</Button>{bucket.isPublic ? <Badge variant="warning">{t.buckets.publicBadge}</Badge> : null}</div></TableRowHeader>
                <TableCell><div className="flex min-w-40 items-center gap-2">{bucket.storageKind === "shared_drive" ? <Share2 className="size-4 text-muted-foreground" /> : <HardDrive className="size-4 text-muted-foreground" />}<span>{bucket.storageDisplayName}</span></div></TableCell>
                <TableCell><Badge variant={bucket.effectiveRole === "owner" ? "default" : "secondary"}>{roleLabel(bucket.effectiveRole)}</Badge></TableCell>
                <TableCell>{bucket.objectCount ?? 0}</TableCell><TableCell>{bucket.multipartOpen ?? 0}</TableCell><TableCell><Badge variant={bucket.storageStatus === "active" ? "success" : "destructive"}>{bucket.storageStatus === "active" ? t.buckets.statusActive : t.buckets.statusIssue}</Badge></TableCell><TableCell className="whitespace-nowrap">{new Date(bucket.createdAt).toLocaleString()}</TableCell>
                <TableCell className="text-right"><div className="flex justify-end gap-1">{bucket.ownedByMe && bucket.storageKind === "shared_drive" ? <Button size="icon" variant="ghost" aria-label={t.buckets.manageAccessLabel(bucket.name)} title={t.buckets.manageAccessTitle} onClick={() => void openAccess(bucket)}><Users /></Button> : null}{bucket.ownedByMe ? <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" aria-label={t.buckets.deleteBucketLabel(bucket.name)} title={t.buckets.deleteBucketTitle} onClick={() => setPendingDelete(bucket)}><Trash2 /></Button> : null}</div></TableCell>
              </TableRow>
            ))}</TableBody>
          </Table>
      )}

      <Dialog open={showCreate} onOpenChange={(open) => { if (!creating) { setShowCreate(open); setFormError(null); if (open) void loadSharedDrives(); } }}>
        <DialogContent>
          <form onSubmit={(event) => void doCreate(event)} className="space-y-5">
            <DialogHeader><DialogTitle>{t.buckets.createDialogTitle}</DialogTitle><DialogDescription>{t.buckets.createDialogDescription}</DialogDescription></DialogHeader>
            {formError ? <ErrorAlert message={formError} /> : null}
            <div className="space-y-2"><Label htmlFor="bucket-name">{t.buckets.nameLabel}</Label><Input id="bucket-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus aria-invalid={Boolean(formError)} aria-describedby="bucket-help" /><p id="bucket-help" className="text-xs text-muted-foreground">{t.buckets.nameHelp}</p></div>
            <fieldset className="space-y-2"><legend className="text-sm font-medium">{t.buckets.locationLegend}</legend><div className="grid grid-cols-2 gap-2"><Button type="button" variant={storageKind === "my_drive" ? "default" : "outline"} onClick={() => setStorageKind("my_drive")}><HardDrive /> My Drive</Button><Button type="button" variant={storageKind === "shared_drive" ? "default" : "outline"} disabled={drivesLoading || noSharedDrives} title={noSharedDrives ? t.buckets.noWritableSharedDriveTitle : undefined} onClick={() => setStorageKind("shared_drive")}><Share2 /> Shared Drive</Button></div>{noSharedDrives ? <p className="text-xs text-muted-foreground">{t.buckets.noWritableSharedDriveHelp}</p> : null}</fieldset>
            {storageKind === "shared_drive" ? <div className="space-y-2"><Label>{t.buckets.sharedDriveLabel}</Label><Select value={sharedDriveId} onValueChange={setSharedDriveId} disabled={drivesLoading} placeholder={drivesLoading ? t.buckets.loadingSharedDrives : t.buckets.pickSharedDrive} options={writableSharedDrives.map((drive) => ({ value: drive.id, label: drive.name }))} /><p className="text-xs text-muted-foreground">{t.buckets.sharedDriveHelp}</p></div> : null}
            <DialogFooter><Button type="button" variant="outline" disabled={creating} onClick={() => setShowCreate(false)}>{t.common.cancel}</Button><Button type="submit" disabled={name.trim().length < 3 || creating || (storageKind === "shared_drive" && !sharedDriveId)}>{creating ? t.buckets.creating : t.buckets.create}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(accessBucket)} onOpenChange={(open) => { if (!open && !memberBusy) setAccessBucket(null); }}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{t.buckets.manageAccessDialogTitle(accessBucket?.name ?? "")}</DialogTitle><DialogDescription>{t.buckets.manageAccessDialogDescription}</DialogDescription></DialogHeader>
        <div className="grid w-fit grid-cols-2 gap-2">
          <Button type="button" size="sm" variant={accessTab === "members" ? "default" : "outline"} onClick={() => setAccessTab("members")}>{t.buckets.accessTabMembers}</Button>
          <Button type="button" size="sm" variant={accessTab === "policy" ? "default" : "outline"} onClick={() => setAccessTab("policy")}>{t.buckets.accessTabPolicy}</Button>
        </div>
        {accessTab === "policy" ? (
          <div className="space-y-4">
            {aclDraft === "public-read-write" ? (
              <Alert variant="destructive"><AlertTitle>{t.buckets.publicBadge}</AlertTitle><AlertDescription>{t.buckets.aclPublicWriteWarning}</AlertDescription></Alert>
            ) : aclDraft === "public-read" ? (
              <Alert><AlertTitle>{t.buckets.publicBadge}</AlertTitle><AlertDescription>{t.buckets.aclPublicWarning}</AlertDescription></Alert>
            ) : null}
            <div className="space-y-2">
              <Label htmlFor="bucket-acl">{t.buckets.aclLabel}</Label>
              <Select
                value={aclDraft}
                onValueChange={(value) => setAclDraft(value as BucketAcl)}
                ariaLabel={t.buckets.aclLabel}
                options={[
                  { value: "private", label: t.buckets.aclPrivate },
                  { value: "public-read", label: t.buckets.aclPublicRead },
                  { value: "public-read-write", label: t.buckets.aclPublicReadWrite },
                  { value: "authenticated-read", label: t.buckets.aclAuthenticatedRead },
                ]}
              />
              <p className="text-xs text-muted-foreground">{t.buckets.aclHelp}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="bucket-versioning">{t.buckets.versioningLabel}</Label>
              <Select
                value={versioningDraft}
                onValueChange={(value) => setVersioningDraft(value as BucketVersioning)}
                ariaLabel={t.buckets.versioningLabel}
                options={[
                  {
                    value: "Disabled",
                    label: t.buckets.versioningDisabled,
                    // S3 has no path back to Disabled once versioning is on.
                    disabled: access ? access.versioning !== "Disabled" : false,
                  },
                  { value: "Enabled", label: t.buckets.versioningEnabled },
                  { value: "Suspended", label: t.buckets.versioningSuspended },
                ]}
              />
              <p className="text-xs text-muted-foreground">{t.buckets.versioningHelp}</p>
              {access && access.retainedVersions > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {t.buckets.versioningRetained(access.retainedVersions)} · {t.buckets.versioningStorageHint}
                  </span>
                  <Button size="sm" variant="outline" disabled={pruning} onClick={() => setConfirmPrune(true)}>
                    {pruning ? t.buckets.pruning : t.buckets.pruneVersions}
                  </Button>
                </div>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="bucket-encryption">{t.buckets.encryptionLabel}</Label>
              <Select
                value={sseDraft}
                onValueChange={(value) => setSseDraft(value as SseAlgorithm | "none")}
                ariaLabel={t.buckets.encryptionLabel}
                options={[
                  { value: "none", label: t.buckets.encryptionNone },
                  { value: "AES256", label: t.buckets.encryptionSseS3 },
                  { value: "aws:kms", label: t.buckets.encryptionSseKms, disabled: kmsKeys.length === 0 },
                ]}
              />
              <p className="text-xs text-muted-foreground">{t.buckets.encryptionHelp}</p>
              {sseDraft === "aws:kms" ? (
                kmsKeys.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t.buckets.encryptionNoKeys}</p>
                ) : (
                  <Select
                    value={sseKeyDraft}
                    onValueChange={setSseKeyDraft}
                    ariaLabel={t.buckets.encryptionKeyLabel}
                    options={kmsKeys.map((key) => ({
                      value: key.id,
                      label: `${key.alias} · v${key.version}`,
                      disabled: key.status !== "active",
                    }))}
                  />
                )
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="bucket-policy">{t.buckets.policyLabel}</Label>
              <textarea
                id="bucket-policy"
                className="min-h-56 w-full rounded-md border bg-background p-3 font-mono text-xs"
                spellCheck={false}
                value={policyDraft}
                placeholder={t.buckets.policyPlaceholder}
                onChange={(event) => { setPolicyDraft(event.target.value); setPolicyError(null); }}
              />
              <p className="text-xs text-muted-foreground">{t.buckets.policyHelp}</p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t.buckets.policyTemplateLabel}</span>
                <Button type="button" size="sm" variant="outline" onClick={() => { setPolicyDraft(POLICY_TEMPLATES.publicRead(accessBucket?.name ?? "bucket")); setPolicyError(null); }}>{t.buckets.policyTemplatePublicRead}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => { setPolicyDraft(POLICY_TEMPLATES.grantUser(accessBucket?.name ?? "bucket")); setPolicyError(null); }}>{t.buckets.policyTemplateGrantUser}</Button>
              </div>
              {policyError ? <Alert variant="destructive"><AlertTitle>{t.buckets.policyInvalid}</AlertTitle><AlertDescription className="break-all">{policyError}</AlertDescription></Alert> : null}
              {access?.policyUpdatedAt ? <p className="text-xs text-muted-foreground">{t.buckets.policySavedAt(new Date(access.policyUpdatedAt).toLocaleString())}</p> : null}
            </div>
            <DialogFooter>
              <Button disabled={accessBusy} onClick={() => void saveAccess()}>{accessBusy ? t.buckets.savingAccess : t.buckets.saveAccess}</Button>
            </DialogFooter>
          </div>
        ) : (
        <><form className="grid gap-3 sm:grid-cols-[1fr_auto_auto]" onSubmit={(event) => void addMember(event)}><Input type="email" placeholder={t.buckets.memberEmailPlaceholder} value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} aria-label={t.buckets.memberEmailLabel} /><Select value={memberRole} onValueChange={setMemberRole} options={ROLE_OPTIONS} buttonClassName="min-w-28" /><Button type="submit" disabled={!memberEmail.trim() || memberBusy}>{memberBusy ? t.buckets.addingMember : t.buckets.addMember}</Button></form><div className="space-y-2">{members.length === 0 ? <p className="text-sm text-muted-foreground">{t.buckets.noExtraMembers}</p> : members.map((member) => <div key={member.user_id} className="flex items-center justify-between gap-3 rounded-md border p-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{member.email}</p><p className="text-xs text-muted-foreground">{member.access_status}</p></div><div className="flex items-center gap-2"><Select value={member.role} disabled={memberBusy} options={ROLE_OPTIONS} buttonClassName="h-9 min-w-28 px-2" onValueChange={async (role) => { if (!accessBucket) return; setMemberBusy(true); try { await updateBucketMember(accessBucket.id, member.user_id, role); setMembers(await listBucketMembers(accessBucket.id)); toast.success(t.toast.memberRoleUpdated(member.email)); } catch (e) { toast.fromError(t.toast.memberUpdateFailed, e); } finally { setMemberBusy(false); } }} /><Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" aria-label={t.buckets.removeMemberLabel(member.email)} disabled={memberBusy} onClick={async () => { if (!accessBucket) return; setMemberBusy(true); try { await removeBucketMember(accessBucket.id, member.user_id); setMembers(await listBucketMembers(accessBucket.id)); toast.success(t.toast.memberRemoved(member.email)); } catch (e) { toast.fromError(t.toast.memberUpdateFailed, e); } finally { setMemberBusy(false); } }}><Trash2 /></Button></div></div>)}</div></>)}</DialogContent>
      </Dialog>

      <AlertDialog open={confirmPrune} onOpenChange={(open) => { if (!pruning) setConfirmPrune(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.buckets.pruneConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.buckets.pruneConfirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pruning}>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={pruning}
              onClick={(event) => { event.preventDefault(); void doPruneVersions(); }}
            >
              {pruning ? t.buckets.pruning : t.buckets.pruneVersions}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open && !deleting) setPendingDelete(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t.buckets.deleteBucketConfirmTitle(pendingDelete?.name ?? "")}</AlertDialogTitle><AlertDialogDescription>{t.buckets.deleteBucketConfirmDescription(pendingDelete?.storageDisplayName ?? "")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={deleting}>{t.common.cancel}</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleting} onClick={(event) => { event.preventDefault(); void doDelete(); }}>{deleting ? t.buckets.deleting : t.buckets.delete}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </div>
  );
}
