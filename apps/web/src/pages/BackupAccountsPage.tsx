import { useCallback, useEffect, useState } from "react";
import { CloudCog, HardDriveDownload, Plus, ShieldAlert, Trash2 } from "lucide-react";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import {
  deleteBackupAccount,
  listBackupAccounts,
  startBackupAccountLink,
  type BackupAccount,
} from "../api/client.ts";

function readAndClearLinkFeedback(): { linked: boolean; error: string | null } {
  const params = new URLSearchParams(window.location.search);
  const linked = params.get("linked") === "1";
  const error = params.get("link_error");
  if (linked || error) {
    window.history.replaceState(null, "", window.location.pathname);
  }
  return { linked, error };
}

export function BackupAccountsPage() {
  const { t } = useLocale();
  const STATUS_LABEL: Record<BackupAccount["status"], string> = {
    active: t.backup.statusActive,
    reauthorization_required: t.backup.statusReauthRequired,
    error: t.backup.statusError,
  };
  const STATUS_VARIANT: Record<BackupAccount["status"], "success" | "warning" | "destructive"> = {
    active: "success",
    reauthorization_required: "warning",
    error: "destructive",
  };

  const [accounts, setAccounts] = useState<BackupAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [linkedMessage, setLinkedMessage] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupAccount | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setAccounts(await listBackupAccounts());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const feedback = readAndClearLinkFeedback();
    setLinkedMessage(feedback.linked);
    setLinkError(feedback.error);
    void load();
  }, [load]);

  const doDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteBackupAccount(deleteTarget.id);
      setDeleteTarget(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <LoadingState label={t.backup.loading} />;

  return (
    <div className="space-y-6">
      {error ? <ErrorAlert message={error} /> : null}
      {linkedMessage ? (
        <Alert variant="success"><AlertTitle>{t.backup.linkedTitle}</AlertTitle><AlertDescription>{t.backup.linkedDescription}</AlertDescription></Alert>
      ) : null}
      {linkError ? (
        <Alert variant="destructive"><ShieldAlert /><AlertTitle>{t.backup.linkErrorTitle}</AlertTitle><AlertDescription>{decodeURIComponent(linkError)}</AlertDescription></Alert>
      ) : null}

      <Alert>
        <CloudCog />
        <AlertTitle>{t.backup.infoTitle}</AlertTitle>
        <AlertDescription>{t.backup.infoDescription}</AlertDescription>
      </Alert>

      <div className="flex justify-end">
        <Button onClick={() => startBackupAccountLink()}><Plus /> {t.backup.connectButton}</Button>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          icon={HardDriveDownload}
          title={t.backup.emptyTitle}
          description={t.backup.emptyDescription}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {accounts.map((account) => (
            <Card key={account.id}>
              <CardHeader className="flex-row items-start justify-between space-y-0 pb-2">
                <div className="min-w-0">
                  <CardTitle className="truncate text-base">{account.email}</CardTitle>
                  <CardDescription>{t.backup.connectedAt(new Date(account.createdAt).toLocaleString())}</CardDescription>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="shrink-0 text-destructive hover:text-destructive"
                  aria-label={t.backup.disconnectLabel(account.email)}
                  onClick={() => setDeleteTarget(account)}
                >
                  <Trash2 />
                </Button>
              </CardHeader>
              <CardContent className="space-y-2">
                <Badge variant={STATUS_VARIANT[account.status]}>{STATUS_LABEL[account.status]}</Badge>
                {account.status === "reauthorization_required" ? (
                  <p className="text-xs text-muted-foreground">{t.backup.reauthHint}</p>
                ) : null}
                {account.lastError ? <p className="text-xs text-destructive">{account.lastError}</p> : null}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => { if (!open && !deleting) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.backup.disconnectConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription className="break-all">
              <span className="font-medium text-foreground">{deleteTarget?.email}</span> {t.backup.disconnectConfirmDescription}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={(event) => { event.preventDefault(); void doDelete(); }}
            >
              {deleting ? t.backup.disconnecting : t.backup.disconnect}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
