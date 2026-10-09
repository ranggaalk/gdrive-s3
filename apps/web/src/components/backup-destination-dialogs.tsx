// The dialogs that add and edit S3 and rclone backup destinations. (A Drive
// destination is added through Google's consent screen, not a form.) Every
// save is a test write on the server first, so a wrong key or bucket name is
// reported here rather than by a failed backup later.

import { useEffect, useState, type FormEvent } from "react";
import { Cloud, Database, HardDrive, Server } from "lucide-react";
import { Alert, Button, Description, Input, Label, Modal, TextField } from "@heroui/react";
import { ErrorAlert } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { Select } from "@/components/ui/select";
import {
  createBackupDestination,
  errorText,
  updateBackupDestination,
  type BackupAccount,
  type BackupDestinationKind,
  type BackupDestinationOptions,
  type RcloneDestinationConfig,
  type S3DestinationConfig,
} from "../api/client.ts";

export const DESTINATION_ICON: Record<BackupDestinationKind, typeof HardDrive> = {
  drive: HardDrive,
  s3: Database,
  rclone: Server,
};

/** One line saying where a destination's copies go. */
export function destinationLocation(account: BackupAccount): string | null {
  if (account.kind === "s3" && account.config) {
    const config = account.config as S3DestinationConfig;
    const host = new URL(config.endpoint).host;
    return `${host} · ${config.bucket}${config.prefix ? `/${config.prefix}` : ""}`;
  }
  if (account.kind === "rclone" && account.config) {
    const config = account.config as RcloneDestinationConfig;
    return `${config.remote}:${config.path}`;
  }
  return null;
}

type S3Preset = "aws" | "r2" | "b2" | "wasabi" | "other";

interface S3Form {
  label: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  storageClass: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Where a provider's endpoint follows from its region, the region decides it. */
function presetEndpoint(preset: S3Preset, region: string): string {
  if (preset === "aws") return region ? `https://s3.${region}.amazonaws.com` : "";
  if (preset === "b2") return region ? `https://s3.${region}.backblazeb2.com` : "";
  if (preset === "wasabi") return region && region !== "us-east-1" ? `https://s3.${region}.wasabisys.com` : "https://s3.wasabisys.com";
  return "";
}

const PRESET_DEFAULTS: Record<S3Preset, { region: string; forcePathStyle: boolean; endpointPlaceholder: string }> = {
  aws: { region: "us-east-1", forcePathStyle: false, endpointPlaceholder: "https://s3.us-east-1.amazonaws.com" },
  r2: { region: "auto", forcePathStyle: true, endpointPlaceholder: "https://<account-id>.r2.cloudflarestorage.com" },
  b2: { region: "us-west-004", forcePathStyle: false, endpointPlaceholder: "https://s3.us-west-004.backblazeb2.com" },
  wasabi: { region: "us-east-1", forcePathStyle: false, endpointPlaceholder: "https://s3.wasabisys.com" },
  other: { region: "us-east-1", forcePathStyle: true, endpointPlaceholder: "https://minio.example.com:9000" },
};

function formFor(preset: S3Preset, previous?: S3Form): S3Form {
  const defaults = PRESET_DEFAULTS[preset];
  return {
    label: previous?.label ?? "",
    endpoint: presetEndpoint(preset, defaults.region),
    region: defaults.region,
    bucket: previous?.bucket ?? "",
    prefix: previous?.prefix ?? "",
    forcePathStyle: defaults.forcePathStyle,
    storageClass: previous?.storageClass ?? "",
    accessKeyId: previous?.accessKeyId ?? "",
    secretAccessKey: previous?.secretAccessKey ?? "",
  };
}

interface DialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (account: BackupAccount) => void;
}

export function S3DestinationDialog({ isOpen, onOpenChange, onSaved }: DialogProps) {
  const { t } = useLocale();
  const [preset, setPreset] = useState<S3Preset>("aws");
  const [form, setForm] = useState<S3Form>(() => formFor("aws"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setPreset("aws");
    setForm(formFor("aws"));
    setError(null);
  }, [isOpen]);

  const set = <K extends keyof S3Form>(key: K) => (value: S3Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const changePreset = (next: S3Preset) => {
    setPreset(next);
    setForm((f) => formFor(next, f));
  };

  // Keep a provider's derived endpoint in step with the region, unless the
  // user has typed an endpoint of their own.
  const changeRegion = (region: string) =>
    setForm((f) => {
      const derived = presetEndpoint(preset, f.region);
      const follows = f.endpoint === "" || f.endpoint === derived;
      return { ...f, region, endpoint: follows ? presetEndpoint(preset, region) : f.endpoint };
    });

  const ready = Boolean(form.endpoint.trim() && form.bucket.trim() && form.accessKeyId.trim() && form.secretAccessKey);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      const account = await createBackupDestination({
        kind: "s3",
        label: form.label.trim() || undefined,
        endpoint: form.endpoint.trim(),
        region: form.region.trim(),
        bucket: form.bucket.trim(),
        prefix: form.prefix.trim(),
        forcePathStyle: form.forcePathStyle,
        storageClass: form.storageClass.trim() || undefined,
        accessKeyId: form.accessKeyId.trim(),
        secretAccessKey: form.secretAccessKey,
      });
      onSaved(account);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => { if (!saving) onOpenChange(open); }}>
      <Modal.Container size="lg">
        <Modal.Dialog className="max-w-2xl">
          <Modal.CloseTrigger aria-label={t.common.close} />
          <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col">
            <Modal.Header>
              <Modal.Heading>{t.backup.s3DialogTitle}</Modal.Heading>
              <p className="text-sm text-muted">{t.backup.s3DialogDescription}</p>
            </Modal.Header>
            <Modal.Body className="space-y-5">
              {error ? <ErrorAlert message={error} /> : null}
              <Select
                label={t.backup.presetLabel}
                value={preset}
                onValueChange={changePreset}
                options={[
                  { value: "aws", label: t.backup.presetAws },
                  { value: "r2", label: t.backup.presetR2 },
                  { value: "b2", label: t.backup.presetB2 },
                  { value: "wasabi", label: t.backup.presetWasabi },
                  { value: "other", label: t.backup.presetOther },
                ]}
              />
              <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
                <TextField fullWidth value={form.endpoint} onChange={set("endpoint")}>
                  <Label>{t.backup.endpointLabel}</Label>
                  <Input placeholder={PRESET_DEFAULTS[preset].endpointPlaceholder} inputMode="url" />
                  <Description>{t.backup.endpointHelp}</Description>
                </TextField>
                <TextField fullWidth value={form.region} onChange={changeRegion}>
                  <Label>{t.backup.regionLabel}</Label>
                  <Input placeholder="us-east-1" />
                  <Description>{t.backup.regionHelp}</Description>
                </TextField>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField fullWidth value={form.bucket} onChange={set("bucket")}>
                  <Label>{t.backup.bucketLabel}</Label>
                  <Input placeholder="my-backups" />
                </TextField>
                <TextField fullWidth value={form.prefix} onChange={set("prefix")}>
                  <Label>{t.backup.prefixLabel}</Label>
                  <Input placeholder="drives3-backup" />
                  <Description>{t.backup.prefixHelp}</Description>
                </TextField>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField fullWidth value={form.accessKeyId} onChange={set("accessKeyId")}>
                  <Label>{t.backup.accessKeyIdLabel}</Label>
                  <Input autoComplete="off" spellCheck={false} />
                </TextField>
                <TextField fullWidth value={form.secretAccessKey} onChange={set("secretAccessKey")}>
                  <Label>{t.backup.secretAccessKeyLabel}</Label>
                  <Input type="password" autoComplete="new-password" spellCheck={false} />
                </TextField>
              </div>
              <p className="-mt-3 text-xs text-muted">{t.backup.secretHelp}</p>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-foreground">{t.backup.addressingLabel}</legend>
                <div className="grid grid-cols-2 gap-2">
                  <Button fullWidth variant={form.forcePathStyle ? "outline" : "primary"} onPress={() => set("forcePathStyle")(false)}>
                    <Cloud /> {t.backup.addressingVirtual}
                  </Button>
                  <Button fullWidth variant={form.forcePathStyle ? "primary" : "outline"} onPress={() => set("forcePathStyle")(true)}>
                    <Server /> {t.backup.addressingPath}
                  </Button>
                </div>
                <p className="text-xs text-muted">{t.backup.addressingHelp}</p>
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField fullWidth value={form.storageClass} onChange={set("storageClass")}>
                  <Label>{t.backup.storageClassLabel}</Label>
                  <Input placeholder="STANDARD" spellCheck={false} />
                  <Description>{t.backup.storageClassHelp}</Description>
                </TextField>
                <TextField fullWidth value={form.label} onChange={set("label")}>
                  <Label>{t.backup.nameLabel}</Label>
                  <Input />
                  <Description>{t.backup.nameHelp}</Description>
                </TextField>
              </div>
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{t.backup.plaintextNote}</Alert.Description>
                </Alert.Content>
              </Alert>
              <p className="text-xs text-muted">{t.backup.checkNote}</p>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary" isDisabled={saving}>{t.common.cancel}</Button>
              <Button type="submit" isDisabled={!ready || saving}>
                {saving ? t.backup.savingDestination : t.backup.saveDestination}
              </Button>
            </Modal.Footer>
          </form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

export function RcloneDestinationDialog({
  isOpen,
  onOpenChange,
  onSaved,
  options,
}: DialogProps & { options: BackupDestinationOptions["rclone"] }) {
  const { t } = useLocale();
  const [remote, setRemote] = useState("");
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setRemote(options.remotes.length === 1 ? options.remotes[0]! : "");
    setPath("");
    setLabel("");
    setError(null);
  }, [isOpen, options.remotes]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!remote || saving) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await createBackupDestination({ kind: "rclone", remote, path: path.trim(), label: label.trim() || undefined }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={(open) => { if (!saving) onOpenChange(open); }}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label={t.common.close} />
          <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col">
            <Modal.Header>
              <Modal.Heading>{t.backup.rcloneDialogTitle}</Modal.Heading>
              <p className="text-sm text-muted">{t.backup.rcloneDialogDescription}</p>
            </Modal.Header>
            <Modal.Body className="space-y-5">
              {error ? <ErrorAlert message={error} /> : null}
              {!options.binaryFound ? (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{t.backup.rcloneBinaryMissing}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}
              <Select
                label={t.backup.remoteLabel}
                value={remote}
                onValueChange={setRemote}
                placeholder={t.backup.pickRemote}
                options={options.remotes.map((name) => ({ value: name, label: name }))}
              />
              <TextField fullWidth value={path} onChange={setPath}>
                <Label>{t.backup.pathLabel}</Label>
                <Input placeholder="backups/drives3" spellCheck={false} />
                <Description>{t.backup.pathHelp}</Description>
              </TextField>
              <TextField fullWidth value={label} onChange={setLabel}>
                <Label>{t.backup.nameLabel}</Label>
                <Input />
              </TextField>
              <Alert status="warning">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{t.backup.plaintextNote}</Alert.Description>
                </Alert.Content>
              </Alert>
              <p className="text-xs text-muted">{t.backup.checkNote}</p>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary" isDisabled={saving}>{t.common.cancel}</Button>
              <Button type="submit" isDisabled={!remote || saving}>
                {saving ? t.backup.savingDestination : t.backup.saveDestination}
              </Button>
            </Modal.Footer>
          </form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

export function EditDestinationDialog({
  account,
  onClose,
  onSaved,
}: {
  account: BackupAccount | null;
  onClose: () => void;
  onSaved: (account: BackupAccount) => void;
}) {
  const { t } = useLocale();
  const [label, setLabel] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!account) return;
    setLabel(account.label);
    setAccessKeyId("");
    setSecretAccessKey("");
    setError(null);
  }, [account]);

  const rotating = Boolean(accessKeyId.trim() || secretAccessKey);
  const ready = Boolean(label.trim()) && (!rotating || Boolean(accessKeyId.trim() && secretAccessKey));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!account || !ready || saving) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await updateBackupDestination(account.id, {
          label: label.trim(),
          ...(rotating ? { accessKeyId: accessKeyId.trim(), secretAccessKey } : {}),
        }),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const location = account ? destinationLocation(account) : null;

  return (
    <Modal.Backdrop isOpen={Boolean(account)} onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label={t.common.close} />
          <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-1 flex-col">
            <Modal.Header>
              <Modal.Heading>{t.backup.editDialogTitle}</Modal.Heading>
              <p className="text-sm text-muted">{t.backup.editDialogDescription}</p>
            </Modal.Header>
            <Modal.Body className="space-y-5">
              {error ? <ErrorAlert message={error} /> : null}
              {location ? <p className="break-all rounded-xl border p-3 font-mono text-xs text-muted">{location}</p> : null}
              <TextField fullWidth value={label} onChange={setLabel}>
                <Label>{t.backup.nameLabel}</Label>
                <Input />
              </TextField>
              {account?.kind === "s3" ? (
                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium text-foreground">{t.backup.rotateKeysLabel}</legend>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <TextField fullWidth value={accessKeyId} onChange={setAccessKeyId}>
                      <Label>{t.backup.accessKeyIdLabel}</Label>
                      <Input autoComplete="off" spellCheck={false} placeholder={(account.config as S3DestinationConfig | null)?.accessKeyId} />
                    </TextField>
                    <TextField fullWidth value={secretAccessKey} onChange={setSecretAccessKey}>
                      <Label>{t.backup.secretAccessKeyLabel}</Label>
                      <Input type="password" autoComplete="new-password" spellCheck={false} />
                    </TextField>
                  </div>
                  <p className="text-xs text-muted">{t.backup.rotateKeysHelp}</p>
                </fieldset>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close" variant="tertiary" isDisabled={saving}>{t.common.cancel}</Button>
              <Button type="submit" isDisabled={!ready || saving}>
                {saving ? t.backup.savingChanges : t.backup.saveChanges}
              </Button>
            </Modal.Footer>
          </form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
