import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Download, KeyRound, Plus, RefreshCw, ShieldOff, Trash2 } from "lucide-react";
import { Alert, AlertDialog, Button, Chip, Input, Label, Modal, Table, TextField, Tooltip } from "@heroui/react";
import { CopyableCode } from "@/components/copyable-code";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { useToast } from "@/components/toast-provider";
import { credentialFileContent, credentialSetupExample } from "@/lib/s3-cli";
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
  const { t } = useLocale();
  const toast = useToast();
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
  const [secretTitle, setSecretTitle] = useState<string | null>(null);

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
      setSecretTitle(t.credentials.createdTitle);
      setCreated(credential);
      setShowCreate(false);
      setLabel("");
      toast.success(t.toast.credentialCreated(credential.label));
      await load();
    } catch (cause) {
      // Errors stay inline here too: the dialog is still open and the field
      // that caused it is right there.
      setFormError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.credentialFailed, cause);
    } finally {
      setCreating(false);
    }
  };

  const confirmAction = async () => {
    if (!pending || acting) return;
    setActing(true);
    setError(null);
    try {
      const { label: credentialLabel } = pending.credential;
      if (pending.kind === "rotate") {
        const credential = await rotateCredential(pending.credential.id);
        setSecretTitle(t.credentials.rotatedTitle);
        setCreated(credential);
        toast.success(t.toast.credentialRotated(credentialLabel));
      } else if (pending.kind === "revoke") {
        await revokeCredential(pending.credential.id);
        toast.success(t.toast.credentialRevoked(credentialLabel));
      } else {
        await deleteCredential(pending.credential.id);
        toast.success(t.toast.credentialDeleted(credentialLabel));
      }
      setPending(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.credentialFailed, cause);
    } finally {
      setActing(false);
    }
  };

  const downloadCredential = () => {
    if (!created) return;
    const content = credentialFileContent(created, created, t.credentials.downloadFile);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `drives3-${created.accessKeyId}.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    toast.success(t.toast.credentialDownloaded);
  };

  if (loading) return <LoadingState label={t.credentials.loading} />;

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      <div className="flex justify-end"><Button onPress={() => setShowCreate(true)}><Plus /> {t.credentials.createButton}</Button></div>

      {creds.length === 0 ? <EmptyState icon={KeyRound} title={t.credentials.emptyTitle} description={t.credentials.emptyDescription} /> : (
        <Table>
          <Table.ScrollContainer>
            <Table.Content aria-label={t.nav.credentials}>
              <Table.Header>
                <Table.Column isRowHeader>{t.credentials.tableLabel}</Table.Column>
                <Table.Column>{t.credentials.tableAccessKeyId}</Table.Column>
                <Table.Column>{t.credentials.tableStatus}</Table.Column>
                <Table.Column>{t.credentials.tableLastUsed}</Table.Column>
                <Table.Column className="text-end">{t.credentials.tableAction}</Table.Column>
              </Table.Header>
              <Table.Body>
                {creds.map((credential) => (
                  <Table.Row key={credential.id} id={credential.id}>
                    <Table.Cell className="font-medium">{credential.label}</Table.Cell>
                    <Table.Cell className="font-mono text-xs">{credential.access_key_id}</Table.Cell>
                    <Table.Cell>
                      <Chip size="sm" color={credential.status === "active" ? "success" : "default"} variant={credential.status === "active" ? "soft" : "secondary"}>
                        {credential.status === "active" ? t.credentials.statusActive : t.credentials.statusRevoked}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>{credential.last_used_at ? new Date(credential.last_used_at).toLocaleString() : "-"}</Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-1">
                        {credential.status === "active" ? (
                          <>
                            <Tooltip delay={300}>
                              <Button isIconOnly size="sm" variant="ghost" aria-label={t.credentials.rotateLabel(credential.label)} isDisabled={acting} onPress={() => setPending({ kind: "rotate", credential })}><RefreshCw /></Button>
                              <Tooltip.Content>{t.credentials.rotateTitle}</Tooltip.Content>
                            </Tooltip>
                            <Tooltip delay={300}>
                              <Button isIconOnly size="sm" variant="ghost" className="text-danger" aria-label={t.credentials.revokeLabel(credential.label)} isDisabled={acting} onPress={() => setPending({ kind: "revoke", credential })}><ShieldOff /></Button>
                              <Tooltip.Content>{t.credentials.revokeTitle}</Tooltip.Content>
                            </Tooltip>
                          </>
                        ) : (
                          <Tooltip delay={300}>
                            <Button isIconOnly size="sm" variant="ghost" className="text-danger" aria-label={t.credentials.deleteLabel(credential.label)} isDisabled={acting} onPress={() => setPending({ kind: "delete", credential })}><Trash2 /></Button>
                            <Tooltip.Content>{t.credentials.deletePermanentTitle}</Tooltip.Content>
                          </Tooltip>
                        )}
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      <Modal.Backdrop isOpen={showCreate} onOpenChange={(open) => { if (!creating) { setShowCreate(open); setFormError(null); } }}>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger aria-label={t.common.close} />
            <form onSubmit={(event) => void doCreate(event)} className="flex min-h-0 flex-1 flex-col">
              <Modal.Header>
                <Modal.Heading>{t.credentials.createDialogTitle}</Modal.Heading>
                <p className="text-sm text-muted">{t.credentials.createDialogDescription}</p>
              </Modal.Header>
              <Modal.Body className="space-y-4">
                {formError ? <ErrorAlert message={formError} /> : null}
                <TextField fullWidth isInvalid={Boolean(formError)} value={label} onChange={setLabel}>
                  <Label>{t.credentials.labelField}</Label>
                  <Input maxLength={100} autoFocus />
                </TextField>
              </Modal.Body>
              <Modal.Footer>
                <Button slot="close" variant="tertiary" isDisabled={creating}>{t.common.cancel}</Button>
                <Button type="submit" isDisabled={!label.trim() || creating}>{creating ? t.credentials.creating : t.credentials.create}</Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <AlertDialog.Backdrop isOpen={Boolean(pending)} onOpenChange={(open) => { if (!open && !acting) setPending(null); }}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status={pending?.kind === "rotate" ? "warning" : "danger"} />
              <AlertDialog.Heading>{pending?.kind === "rotate" ? t.credentials.rotateConfirmTitle : pending?.kind === "revoke" ? t.credentials.revokeConfirmTitle : t.credentials.deleteConfirmTitle}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{pending?.kind === "rotate" ? t.credentials.rotateConfirmDescription : pending?.kind === "revoke" ? t.credentials.revokeConfirmDescription : t.credentials.deleteConfirmDescription}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={acting}>{t.common.cancel}</Button>
              <Button variant={pending?.kind === "rotate" ? "primary" : "danger"} isDisabled={acting} onPress={() => void confirmAction()}>
                {acting ? t.credentials.processing : pending?.kind === "rotate" ? t.credentials.rotate : pending?.kind === "revoke" ? t.credentials.revoke : t.credentials.deletePermanent}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <Modal.Backdrop isOpen={Boolean(created)} onOpenChange={(open) => { if (!open) setCreated(null); }}>
        <Modal.Container size="lg">
          <Modal.Dialog className="max-w-2xl">
            <Modal.CloseTrigger aria-label={t.common.close} />
            <Modal.Header>
              <Modal.Heading>{secretTitle ?? t.credentials.createdTitle}</Modal.Heading>
              <p className="text-sm text-muted">{t.credentials.saveDialogDescription}</p>
            </Modal.Header>
            <Modal.Body>
              {created ? (
                <div className="min-w-0 space-y-5 text-foreground">
                  <Alert status="warning">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>{t.credentials.saveSecretNowTitle}</Alert.Title>
                      <Alert.Description>{t.credentials.saveSecretNowDescription}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                  <div className="grid gap-3 text-sm sm:grid-cols-2">
                    <div><p className="text-muted">{t.credentials.s3Endpoint}</p><p className="break-all font-mono text-xs">{created.s3Endpoint}</p></div>
                    <div><p className="text-muted">{t.credentials.region}</p><p className="font-mono text-xs">{created.s3Region}</p></div>
                  </div>
                  <div className="space-y-2"><Label>{t.credentials.accessKeyId}</Label><CopyableCode value={created.accessKeyId} label={t.credentials.accessKeyId} /></div>
                  <div className="space-y-2"><Label>{t.credentials.secretAccessKey}</Label><CopyableCode value={created.secretAccessKey} label={t.credentials.secretAccessKey} /></div>
                  <div className="space-y-2"><Label>{t.credentials.cliExampleLabel}</Label><CopyableCode value={credentialSetupExample(created, { accessKeyId: created.accessKeyId, secretAccessKey: created.secretAccessKey })} label={t.credentials.cliExampleCopyLabel} /></div>
                </div>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="outline" onPress={downloadCredential}><Download /> {t.credentials.downloadAsFile}</Button>
              <Button onPress={() => setCreated(null)}>{t.credentials.done}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </div>
  );
}
