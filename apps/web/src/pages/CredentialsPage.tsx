import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Download, KeyRound, Plus, RefreshCw, ShieldOff, Trash2, TriangleAlert } from "lucide-react";
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
      <div className="flex justify-end"><Button onClick={() => setShowCreate(true)}><Plus /> {t.credentials.createButton}</Button></div>

      {creds.length === 0 ? <EmptyState icon={KeyRound} title={t.credentials.emptyTitle} description={t.credentials.emptyDescription} /> : (
        <Table><TableHeader><TableRow><TableHead>{t.credentials.tableLabel}</TableHead><TableHead>{t.credentials.tableAccessKeyId}</TableHead><TableHead>{t.credentials.tableStatus}</TableHead><TableHead>{t.credentials.tableLastUsed}</TableHead><TableHead className="text-right">{t.credentials.tableAction}</TableHead></TableRow></TableHeader><TableBody>{creds.map((credential) => (
          <TableRow key={credential.id}>
            <TableRowHeader>{credential.label}</TableRowHeader>
            <TableCell className="font-mono text-xs">{credential.access_key_id}</TableCell>
            <TableCell><Badge variant={credential.status === "active" ? "success" : "secondary"}>{credential.status === "active" ? t.credentials.statusActive : t.credentials.statusRevoked}</Badge></TableCell>
            <TableCell>{credential.last_used_at ? new Date(credential.last_used_at).toLocaleString() : "-"}</TableCell>
            <TableCell><div className="flex justify-end gap-1">{credential.status === "active" ? <>
              <Button size="icon" variant="ghost" aria-label={t.credentials.rotateLabel(credential.label)} title={t.credentials.rotateTitle} disabled={acting} onClick={() => setPending({ kind: "rotate", credential })}><RefreshCw /></Button>
              <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" aria-label={t.credentials.revokeLabel(credential.label)} title={t.credentials.revokeTitle} disabled={acting} onClick={() => setPending({ kind: "revoke", credential })}><ShieldOff /></Button>
            </> : <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" aria-label={t.credentials.deleteLabel(credential.label)} title={t.credentials.deletePermanentTitle} disabled={acting} onClick={() => setPending({ kind: "delete", credential })}><Trash2 /></Button>}</div></TableCell>
          </TableRow>
        ))}</TableBody></Table>
      )}

      <Dialog open={showCreate} onOpenChange={(open) => { if (!creating) { setShowCreate(open); setFormError(null); } }}>
        <DialogContent><form onSubmit={(event) => void doCreate(event)} className="space-y-5"><DialogHeader><DialogTitle>{t.credentials.createDialogTitle}</DialogTitle><DialogDescription>{t.credentials.createDialogDescription}</DialogDescription></DialogHeader>{formError ? <ErrorAlert message={formError} /> : null}<div className="space-y-2"><Label htmlFor="credential-label">{t.credentials.labelField}</Label><Input id="credential-label" maxLength={100} value={label} onChange={(event) => setLabel(event.target.value)} autoFocus aria-invalid={Boolean(formError)} /></div><DialogFooter><Button type="button" variant="outline" disabled={creating} onClick={() => setShowCreate(false)}>{t.common.cancel}</Button><Button type="submit" disabled={!label.trim() || creating}>{creating ? t.credentials.creating : t.credentials.create}</Button></DialogFooter></form></DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(pending)} onOpenChange={(open) => { if (!open && !acting) setPending(null); }}>
        <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{pending?.kind === "rotate" ? t.credentials.rotateConfirmTitle : pending?.kind === "revoke" ? t.credentials.revokeConfirmTitle : t.credentials.deleteConfirmTitle}</AlertDialogTitle><AlertDialogDescription>{pending?.kind === "rotate" ? t.credentials.rotateConfirmDescription : pending?.kind === "revoke" ? t.credentials.revokeConfirmDescription : t.credentials.deleteConfirmDescription}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={acting}>{t.common.cancel}</AlertDialogCancel><AlertDialogAction className={pending?.kind === "rotate" ? "" : "bg-destructive text-destructive-foreground hover:bg-destructive/90"} disabled={acting} onClick={(event) => { event.preventDefault(); void confirmAction(); }}>{acting ? t.credentials.processing : pending?.kind === "rotate" ? t.credentials.rotate : pending?.kind === "revoke" ? t.credentials.revoke : t.credentials.deletePermanent}</AlertDialogAction></AlertDialogFooter></AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(created)} onOpenChange={(open) => { if (!open) setCreated(null); }}>
        <DialogContent className="min-w-0 max-h-[90vh] max-w-2xl overflow-x-hidden overflow-y-auto">
          <DialogHeader><DialogTitle>{secretTitle ?? t.credentials.createdTitle}</DialogTitle><DialogDescription>{t.credentials.saveDialogDescription}</DialogDescription></DialogHeader>
          {created ? <div className="min-w-0 space-y-5"><Alert variant="warning"><TriangleAlert /><AlertTitle>{t.credentials.saveSecretNowTitle}</AlertTitle><AlertDescription>{t.credentials.saveSecretNowDescription}</AlertDescription></Alert><div className="grid gap-3 text-sm sm:grid-cols-2"><div><p className="text-muted-foreground">{t.credentials.s3Endpoint}</p><p className="break-all font-mono text-xs">{created.s3Endpoint}</p></div><div><p className="text-muted-foreground">{t.credentials.region}</p><p className="font-mono text-xs">{created.s3Region}</p></div></div><div className="space-y-2"><Label>{t.credentials.accessKeyId}</Label><CopyableCode value={created.accessKeyId} label={t.credentials.accessKeyId} /></div><div className="space-y-2"><Label>{t.credentials.secretAccessKey}</Label><CopyableCode value={created.secretAccessKey} label={t.credentials.secretAccessKey} /></div><div className="space-y-2"><Label>{t.credentials.cliExampleLabel}</Label><CopyableCode value={credentialSetupExample(created, { accessKeyId: created.accessKeyId, secretAccessKey: created.secretAccessKey })} label={t.credentials.cliExampleCopyLabel} /></div></div> : null}
          <DialogFooter><Button variant="outline" onClick={downloadCredential}><Download /> {t.credentials.downloadAsFile}</Button><Button onClick={() => setCreated(null)}>{t.credentials.done}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
