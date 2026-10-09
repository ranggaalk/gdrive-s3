import { useCallback, useEffect, useState, type FormEvent } from "react";
import { HardDrive, PackageOpen, Plus, Settings2, Share2, Trash2 } from "lucide-react";
import { Alert, AlertDialog, Button, Chip, Description, Input, Label, Modal, Table, TextArea, TextField, Tooltip } from "@heroui/react";
import { Select } from "@/components/ui/select";
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
  type LockMode,
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
  const [confirmLock, setConfirmLock] = useState(false);
  const [lockDefaultMode, setLockDefaultMode] = useState<LockMode | "none">("none");
  const [lockDefaultDays, setLockDefaultDays] = useState(30);

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
    // Members are a Shared Drive concept; a My Drive bucket has only the ACL,
    // policy, versioning, encryption, and lock settings.
    setAccessTab(bucket.storageKind === "shared_drive" ? "members" : "policy");
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
      setLockDefaultMode(accessConfig.objectLockDefault?.mode ?? "none");
      setLockDefaultDays(accessConfig.objectLockDefault?.days ?? 30);
      setSseDraft(accessConfig.defaultSseAlgorithm ?? "none");
      setSseKeyDraft(accessConfig.defaultKmsKeyId ?? keys.find((k) => k.status === "active")?.id ?? "");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const doEnableObjectLock = async () => {
    if (!accessBucket) return;
    setAccessBusy(true);
    try {
      const updated = await updateBucketAccess(accessBucket.id, { objectLockEnabled: true });
      setAccess(updated);
      setVersioningDraft(updated.versioning);
      toast.success(t.toast.objectLockEnabled);
    } catch (cause) {
      toast.fromError(t.toast.accessFailed, cause);
    } finally {
      setAccessBusy(false);
      setConfirmLock(false);
    }
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
        // Only meaningful once Object Lock is on, and only sent when the
        // operator actually changed it.
        ...(access?.objectLockEnabled
          ? {
              objectLockDefault:
                lockDefaultMode === "none"
                  ? null
                  : { mode: lockDefaultMode, days: lockDefaultDays },
            }
          : {}),
      });
      setAccess(updated);
      setAclDraft(updated.acl);
      setPolicyDraft(updated.policy ? prettyJson(updated.policy) : "");
      setSseDraft(updated.defaultSseAlgorithm ?? "none");
      setSseKeyDraft(updated.defaultKmsKeyId ?? "");
      setVersioningDraft(updated.versioning);
      setLockDefaultMode(updated.objectLockDefault?.mode ?? "none");
      setLockDefaultDays(updated.objectLockDefault?.days ?? 30);
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
      <div className="flex justify-end"><Button onPress={() => { setShowCreate(true); void loadSharedDrives(); }}><Plus /> {t.buckets.createButton}</Button></div>

      {buckets.length === 0 ? (
        <EmptyState icon={PackageOpen} title={t.buckets.emptyTitle} description={t.buckets.emptyDescription} />
      ) : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label={t.nav.buckets}>
              <Table.Header>
                <Table.Column isRowHeader>{t.buckets.tableName}</Table.Column>
                <Table.Column>{t.buckets.tableLocation}</Table.Column>
                <Table.Column>{t.buckets.tableAccess}</Table.Column>
                <Table.Column>{t.buckets.tableObjects}</Table.Column>
                <Table.Column>{t.buckets.tableMultipart}</Table.Column>
                <Table.Column>{t.buckets.tableStatus}</Table.Column>
                <Table.Column>{t.buckets.tableCreated}</Table.Column>
                <Table.Column className="text-end">{t.buckets.tableAction}</Table.Column>
              </Table.Header>
              <Table.Body>{buckets.map((bucket) => (
                <Table.Row key={bucket.id} id={bucket.id}>
                  <Table.Cell><div className="flex flex-wrap items-center gap-2"><button type="button" className="rounded-sm font-medium text-accent underline-offset-4 hover:underline focus-visible:focus-ring" onClick={() => onOpen(bucket)}>{bucket.name}</button>{bucket.isPublic ? <Chip size="sm" color="warning" variant="soft">{t.buckets.publicBadge}</Chip> : null}</div></Table.Cell>
                  <Table.Cell><div className="flex min-w-40 items-center gap-2">{bucket.storageKind === "shared_drive" ? <Share2 className="size-4 text-muted" /> : <HardDrive className="size-4 text-muted" />}<span>{bucket.storageDisplayName}</span></div></Table.Cell>
                  <Table.Cell>{bucket.effectiveRole === "owner" ? <Chip size="sm" color="accent" variant="soft">{roleLabel(bucket.effectiveRole)}</Chip> : <Chip size="sm">{roleLabel(bucket.effectiveRole)}</Chip>}</Table.Cell>
                  <Table.Cell>{bucket.objectCount ?? 0}</Table.Cell>
                  <Table.Cell>{bucket.multipartOpen ?? 0}</Table.Cell>
                  <Table.Cell><Chip size="sm" color={bucket.storageStatus === "active" ? "success" : "danger"} variant="soft">{bucket.storageStatus === "active" ? t.buckets.statusActive : t.buckets.statusIssue}</Chip></Table.Cell>
                  <Table.Cell className="whitespace-nowrap">{new Date(bucket.createdAt).toLocaleString()}</Table.Cell>
                  <Table.Cell className="text-end"><div className="flex justify-end gap-1">{bucket.ownedByMe ? <Tooltip delay={300}><Button onPress={() => void openAccess(bucket)} isIconOnly size="sm" variant="ghost" aria-label={t.buckets.manageAccessLabel(bucket.name)}><Settings2 /></Button><Tooltip.Content>{t.buckets.manageAccessTitle}</Tooltip.Content></Tooltip> : null}{bucket.ownedByMe ? <Tooltip delay={300}><Button onPress={() => setPendingDelete(bucket)} isIconOnly size="sm" variant="ghost" className="text-danger" aria-label={t.buckets.deleteBucketLabel(bucket.name)}><Trash2 /></Button><Tooltip.Content>{t.buckets.deleteBucketTitle}</Tooltip.Content></Tooltip> : null}</div></Table.Cell>
                </Table.Row>
              ))}</Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      <Modal.Backdrop isOpen={showCreate} onOpenChange={(open) => { if (!creating) { setShowCreate(open); setFormError(null); if (open) void loadSharedDrives(); } }}>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger aria-label={t.common.close} />
            <form onSubmit={(event) => void doCreate(event)} className="flex min-h-0 flex-1 flex-col">
              <Modal.Header>
                <Modal.Heading>{t.buckets.createDialogTitle}</Modal.Heading>
                <p className="text-sm text-muted">{t.buckets.createDialogDescription}</p>
              </Modal.Header>
              <Modal.Body className="space-y-5">
                {formError ? <ErrorAlert message={formError} /> : null}
                <TextField fullWidth isInvalid={Boolean(formError)} value={name} onChange={setName}>
                  <Label>{t.buckets.nameLabel}</Label>
                  <Input autoFocus />
                  <Description>{t.buckets.nameHelp}</Description>
                </TextField>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium text-foreground">{t.buckets.locationLegend}</legend>
                  <div className="grid grid-cols-2 gap-2">
                    <Button fullWidth variant={storageKind === "my_drive" ? "primary" : "outline"} onPress={() => setStorageKind("my_drive")}><HardDrive /> My Drive</Button>
                    <Button fullWidth variant={storageKind === "shared_drive" ? "primary" : "outline"} isDisabled={drivesLoading || noSharedDrives} onPress={() => setStorageKind("shared_drive")}><Share2 /> Shared Drive</Button>
                  </div>
                  {noSharedDrives ? <p className="text-xs text-muted">{t.buckets.noWritableSharedDriveHelp}</p> : null}
                </fieldset>
                {storageKind === "shared_drive" ? (
                  <div className="space-y-2">
                    <Select label={t.buckets.sharedDriveLabel} value={sharedDriveId} onValueChange={setSharedDriveId} disabled={drivesLoading} placeholder={drivesLoading ? t.buckets.loadingSharedDrives : t.buckets.pickSharedDrive} options={writableSharedDrives.map((drive) => ({ value: drive.id, label: drive.name }))} />
                    <p className="text-xs text-muted">{t.buckets.sharedDriveHelp}</p>
                  </div>
                ) : null}
              </Modal.Body>
              <Modal.Footer>
                <Button slot="close" variant="tertiary" isDisabled={creating}>{t.common.cancel}</Button>
                <Button type="submit" isDisabled={name.trim().length < 3 || creating || (storageKind === "shared_drive" && !sharedDriveId)}>{creating ? t.buckets.creating : t.buckets.create}</Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={Boolean(accessBucket)} onOpenChange={(open) => { if (!open && !memberBusy) setAccessBucket(null); }}>
        <Modal.Container size="lg">
          <Modal.Dialog className="max-w-xl">
            <Modal.CloseTrigger aria-label={t.common.close} />
            <Modal.Header>
              <Modal.Heading>{accessBucket?.storageKind === "shared_drive" ? t.buckets.manageAccessDialogTitle(accessBucket?.name ?? "") : t.buckets.bucketSettingsTitle(accessBucket?.name ?? "")}</Modal.Heading>
              <p className="text-sm text-muted">{accessBucket?.storageKind === "shared_drive" ? t.buckets.manageAccessDialogDescription : t.buckets.bucketSettingsDescription}</p>
              {/* Members are a Shared Drive concept, so a My Drive bucket has only
                  one panel and needs no tabs. */}
              {accessBucket?.storageKind === "shared_drive" ? (
                <div className="grid w-fit grid-cols-2 gap-2">
                  <Button size="sm" variant={accessTab === "members" ? "primary" : "outline"} onPress={() => setAccessTab("members")}>{t.buckets.accessTabMembers}</Button>
                  <Button size="sm" variant={accessTab === "policy" ? "primary" : "outline"} onPress={() => setAccessTab("policy")}>{t.buckets.accessTabPolicy}</Button>
                </div>
              ) : null}
            </Modal.Header>
            {accessTab === "policy" ? (
              <>
                <Modal.Body className="space-y-4">
                  {aclDraft === "public-read-write" ? (
                    <Alert status="danger">
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Title>{t.buckets.publicBadge}</Alert.Title>
                        <Alert.Description>{t.buckets.aclPublicWriteWarning}</Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : aclDraft === "public-read" ? (
                    <Alert>
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Title>{t.buckets.publicBadge}</Alert.Title>
                        <Alert.Description>{t.buckets.aclPublicWarning}</Alert.Description>
                      </Alert.Content>
                    </Alert>
                  ) : null}
                  <div className="space-y-2">
                    <Select
                      label={t.buckets.aclLabel}
                      value={aclDraft}
                      onValueChange={(value) => setAclDraft(value as BucketAcl)}
                      options={[
                        { value: "private", label: t.buckets.aclPrivate },
                        { value: "public-read", label: t.buckets.aclPublicRead },
                        { value: "public-read-write", label: t.buckets.aclPublicReadWrite },
                        { value: "authenticated-read", label: t.buckets.aclAuthenticatedRead },
                      ]}
                    />
                    <p className="text-xs text-muted">{t.buckets.aclHelp}</p>
                  </div>
                  <div className="space-y-2">
                    <Label>{t.buckets.lockLabel}</Label>
                    {access?.objectLockEnabled ? (
                      <>
                        <Chip size="sm" color="success" variant="soft">{t.buckets.lockEnabled}</Chip>
                        <Select
                          value={lockDefaultMode}
                          onValueChange={(value) => setLockDefaultMode(value as LockMode | "none")}
                          ariaLabel={t.buckets.lockDefaultLabel}
                          options={[
                            { value: "none", label: t.buckets.lockDefaultNone },
                            { value: "GOVERNANCE", label: t.buckets.lockModeGovernance },
                            { value: "COMPLIANCE", label: t.buckets.lockModeCompliance },
                          ]}
                        />
                        {lockDefaultMode === "none" ? null : (
                          <div className="space-y-1">
                            <Label htmlFor="lock-days">{t.buckets.lockDefaultDaysLabel}</Label>
                            <Input
                              id="lock-days"
                              fullWidth
                              type="number"
                              min={1}
                              max={36500}
                              value={lockDefaultDays}
                              onChange={(event) => setLockDefaultDays(Math.max(1, Number(event.target.value) || 1))}
                            />
                          </div>
                        )}
                      </>
                    ) : (
                      <Button variant="outline" size="sm" isDisabled={accessBusy} onPress={() => setConfirmLock(true)}>
                        {t.buckets.lockEnable}
                      </Button>
                    )}
                    <p className="text-xs text-muted">{t.buckets.lockHelp}</p>
                  </div>

                  <div className="space-y-2">
                    <Select
                      label={t.buckets.versioningLabel}
                      value={versioningDraft}
                      onValueChange={(value) => setVersioningDraft(value as BucketVersioning)}
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
                    <p className="text-xs text-muted">{t.buckets.versioningHelp}</p>
                    {access && access.retainedVersions > 0 ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted">
                          {t.buckets.versioningRetained(access.retainedVersions)} · {t.buckets.versioningStorageHint}
                        </span>
                        <Button size="sm" variant="outline" isDisabled={pruning} onPress={() => setConfirmPrune(true)}>
                          {pruning ? t.buckets.pruning : t.buckets.pruneVersions}
                        </Button>
                      </div>
                    ) : null}
                  </div>

                  <div className="space-y-2">
                    <Select
                      label={t.buckets.encryptionLabel}
                      value={sseDraft}
                      onValueChange={(value) => setSseDraft(value as SseAlgorithm | "none")}
                      options={[
                        { value: "none", label: t.buckets.encryptionNone },
                        { value: "AES256", label: t.buckets.encryptionSseS3 },
                        { value: "aws:kms", label: t.buckets.encryptionSseKms, disabled: kmsKeys.length === 0 },
                      ]}
                    />
                    <p className="text-xs text-muted">{t.buckets.encryptionHelp}</p>
                    {sseDraft === "aws:kms" ? (
                      kmsKeys.length === 0 ? (
                        <p className="text-xs text-muted">{t.buckets.encryptionNoKeys}</p>
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
                    <TextArea
                      id="bucket-policy"
                      fullWidth
                      className="min-h-56 font-mono text-xs"
                      spellCheck={false}
                      value={policyDraft}
                      placeholder={t.buckets.policyPlaceholder}
                      onChange={(event) => { setPolicyDraft(event.target.value); setPolicyError(null); }}
                    />
                    <p className="text-xs text-muted">{t.buckets.policyHelp}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted">{t.buckets.policyTemplateLabel}</span>
                      <Button size="sm" variant="outline" onPress={() => { setPolicyDraft(POLICY_TEMPLATES.publicRead(accessBucket?.name ?? "bucket")); setPolicyError(null); }}>{t.buckets.policyTemplatePublicRead}</Button>
                      <Button size="sm" variant="outline" onPress={() => { setPolicyDraft(POLICY_TEMPLATES.grantUser(accessBucket?.name ?? "bucket")); setPolicyError(null); }}>{t.buckets.policyTemplateGrantUser}</Button>
                    </div>
                    {policyError ? (
                      <Alert status="danger">
                        <Alert.Indicator />
                        <Alert.Content>
                          <Alert.Title>{t.buckets.policyInvalid}</Alert.Title>
                          <Alert.Description className="break-all">{policyError}</Alert.Description>
                        </Alert.Content>
                      </Alert>
                    ) : null}
                    {access?.policyUpdatedAt ? <p className="text-xs text-muted">{t.buckets.policySavedAt(new Date(access.policyUpdatedAt).toLocaleString())}</p> : null}
                  </div>
                </Modal.Body>
                <Modal.Footer>
                  <Button isDisabled={accessBusy} onPress={() => void saveAccess()}>{accessBusy ? t.buckets.savingAccess : t.buckets.saveAccess}</Button>
                </Modal.Footer>
              </>
            ) : (
              <>
                {/* The add form stays pinned above the scrolling member list. */}
                <form className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_auto]" onSubmit={(event) => void addMember(event)}>
                  <Input fullWidth type="email" placeholder={t.buckets.memberEmailPlaceholder} value={memberEmail} onChange={(event) => setMemberEmail(event.target.value)} aria-label={t.buckets.memberEmailLabel} />
                  <Select value={memberRole} onValueChange={setMemberRole} options={ROLE_OPTIONS} ariaLabel={t.buckets.memberRoleLabel} triggerClassName="min-w-28" />
                  <Button type="submit" isDisabled={!memberEmail.trim() || memberBusy}>{memberBusy ? t.buckets.addingMember : t.buckets.addMember}</Button>
                </form>
                <Modal.Body className="mt-4 space-y-2 text-foreground">
                  {members.length === 0 ? <p className="text-sm text-muted">{t.buckets.noExtraMembers}</p> : members.map((member) => (
                    <div key={member.user_id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{member.email}</p>
                        <p className="text-xs text-muted">{member.access_status}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Select value={member.role} disabled={memberBusy} options={ROLE_OPTIONS} ariaLabel={t.buckets.memberRoleLabel} triggerClassName="min-w-28" onValueChange={async (role) => { if (!accessBucket) return; setMemberBusy(true); try { await updateBucketMember(accessBucket.id, member.user_id, role); setMembers(await listBucketMembers(accessBucket.id)); toast.success(t.toast.memberRoleUpdated(member.email)); } catch (e) { toast.fromError(t.toast.memberUpdateFailed, e); } finally { setMemberBusy(false); } }} />
                        <Button isIconOnly size="sm" variant="ghost" className="text-danger" aria-label={t.buckets.removeMemberLabel(member.email)} isDisabled={memberBusy} onPress={async () => { if (!accessBucket) return; setMemberBusy(true); try { await removeBucketMember(accessBucket.id, member.user_id); setMembers(await listBucketMembers(accessBucket.id)); toast.success(t.toast.memberRemoved(member.email)); } catch (e) { toast.fromError(t.toast.memberUpdateFailed, e); } finally { setMemberBusy(false); } }}><Trash2 /></Button>
                      </div>
                    </div>
                  ))}
                </Modal.Body>
              </>
            )}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <AlertDialog.Backdrop isOpen={confirmLock} onOpenChange={(open) => { if (!accessBusy) setConfirmLock(open); }}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning" />
              <AlertDialog.Heading>{t.buckets.lockConfirmTitle}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{t.buckets.lockConfirmDescription} {t.buckets.lockIrreversible}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={accessBusy}>{t.common.cancel}</Button>
              <Button isDisabled={accessBusy} onPress={() => void doEnableObjectLock()}>{t.buckets.lockEnable}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop isOpen={confirmPrune} onOpenChange={(open) => { if (!pruning) setConfirmPrune(open); }}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>{t.buckets.pruneConfirmTitle}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{t.buckets.pruneConfirmDescription}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={pruning}>{t.common.cancel}</Button>
              <Button variant="danger" isDisabled={pruning} onPress={() => void doPruneVersions()}>{pruning ? t.buckets.pruning : t.buckets.pruneVersions}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop isOpen={Boolean(pendingDelete)} onOpenChange={(open) => { if (!open && !deleting) setPendingDelete(null); }}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>{t.buckets.deleteBucketConfirmTitle(pendingDelete?.name ?? "")}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{t.buckets.deleteBucketConfirmDescription(pendingDelete?.storageDisplayName ?? "")}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={deleting}>{t.common.cancel}</Button>
              <Button variant="danger" isDisabled={deleting} onPress={() => void doDelete()}>{deleting ? t.buckets.deleting : t.buckets.delete}</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  );
}
