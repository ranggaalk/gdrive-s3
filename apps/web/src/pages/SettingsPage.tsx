import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FolderCog, KeyRound, RotateCcw, ShieldAlert, TriangleAlert } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import {
  getSettingsStatus,
  resetGoogleOAuthSettings,
  resetRootFolderNameSetting,
  updateGoogleOAuthSettings,
  updateRootFolderNameSetting,
  type GoogleOAuthSettingsStatus,
  type RootFolderNameStatus,
} from "../api/client.ts";

export function SettingsPage() {
  const { t } = useLocale();
  const SOURCE_LABEL: Record<GoogleOAuthSettingsStatus["clientIdSource"], string> = {
    database: t.settings.sourceDatabase,
    env: t.settings.sourceEnv,
  };
  const FOLDER_SOURCE_LABEL: Record<RootFolderNameStatus["source"], string> = {
    custom: t.settings.folderSourceCustom,
    default: t.settings.folderSourceDefault,
  };

  const [status, setStatus] = useState<GoogleOAuthSettingsStatus | null>(null);
  const [folderStatus, setFolderStatus] = useState<RootFolderNameStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formError, setFormError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const [folderFormError, setFolderFormError] = useState<string | null>(null);
  const [folderName, setFolderName] = useState("");
  const [savingFolder, setSavingFolder] = useState(false);
  const [folderSavedMessage, setFolderSavedMessage] = useState<string | null>(null);
  const [confirmFolderReset, setConfirmFolderReset] = useState(false);
  const [resettingFolder, setResettingFolder] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { googleOAuth, rootFolderName } = await getSettingsStatus();
      setStatus(googleOAuth);
      setClientId(googleOAuth.clientId);
      setFolderStatus(rootFolderName);
      setFolderName(rootFolderName.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onSave = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !clientId.trim() || !clientSecret.trim()) return;
    setSaving(true);
    setFormError(null);
    setSavedMessage(null);
    try {
      const { googleOAuth } = await updateGoogleOAuthSettings(clientId.trim(), clientSecret.trim());
      setStatus(googleOAuth);
      setClientSecret("");
      setSavedMessage(t.settings.oauthSavedMessage);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const onReset = async () => {
    if (resetting) return;
    setResetting(true);
    setError(null);
    try {
      const { googleOAuth } = await resetGoogleOAuthSettings();
      setStatus(googleOAuth);
      setClientId(googleOAuth.clientId);
      setClientSecret("");
      setConfirmReset(false);
      setSavedMessage(t.settings.oauthResetMessage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setResetting(false);
    }
  };

  const onSaveFolderName = async (event: FormEvent) => {
    event.preventDefault();
    if (savingFolder || !folderName.trim()) return;
    setSavingFolder(true);
    setFolderFormError(null);
    setFolderSavedMessage(null);
    try {
      const { rootFolderName } = await updateRootFolderNameSetting(folderName.trim());
      setFolderStatus(rootFolderName);
      setFolderName(rootFolderName.name);
      setFolderSavedMessage(t.settings.folderSavedMessage);
    } catch (cause) {
      setFolderFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingFolder(false);
    }
  };

  const onResetFolderName = async () => {
    if (resettingFolder) return;
    setResettingFolder(true);
    setError(null);
    try {
      const { rootFolderName } = await resetRootFolderNameSetting();
      setFolderStatus(rootFolderName);
      setFolderName(rootFolderName.name);
      setConfirmFolderReset(false);
      setFolderSavedMessage(t.settings.folderResetMessage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setResettingFolder(false);
    }
  };

  if (loading) return <LoadingState label={t.settings.loading} />;

  if (error) {
    return (
      <div className="space-y-4">
        <ErrorAlert message={error} />
      </div>
    );
  }

  if (!status || !folderStatus) return null;

  const hasCustomCredentials = status.clientIdSource === "database" || status.clientSecretSource === "database";

  return (
    <div className="space-y-6">
      <Alert variant="warning">
        <ShieldAlert />
        <AlertTitle>{t.settings.impactWarningTitle}</AlertTitle>
        <AlertDescription>{t.settings.impactWarningDescription}</AlertDescription>
      </Alert>

      {savedMessage ? (
        <Alert variant="success"><AlertTitle>{t.settings.savedTitle}</AlertTitle><AlertDescription>{savedMessage}</AlertDescription></Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound className="size-5 text-primary" /> {t.settings.oauthCardTitle}</CardTitle>
          <CardDescription>{t.settings.oauthCardDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-muted-foreground">{t.settings.clientIdSourceLabel}</p>
              <Badge variant={status.clientIdSource === "database" ? "default" : "secondary"}>
                {SOURCE_LABEL[status.clientIdSource]}
              </Badge>
            </div>
            <div className="space-y-1">
              <p className="text-muted-foreground">{t.settings.clientSecretSourceLabel}</p>
              <Badge variant={status.clientSecretSource === "database" ? "default" : "secondary"}>
                {SOURCE_LABEL[status.clientSecretSource]}
              </Badge>
            </div>
          </div>

          <form onSubmit={(event) => void onSave(event)} className="space-y-4 border-t pt-5">
            {formError ? <ErrorAlert message={formError} /> : null}
            <div className="space-y-2">
              <Label htmlFor="settings-client-id">{t.settings.clientIdLabel}</Label>
              <Input
                id="settings-client-id"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="xxxxxxxxxx.apps.googleusercontent.com"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="settings-client-secret">{t.settings.clientSecretLabel}</Label>
              <Input
                id="settings-client-secret"
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder={t.settings.clientSecretPlaceholder}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">{t.settings.clientSecretHelp}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="submit" disabled={saving || !clientId.trim() || !clientSecret.trim()}>
                {saving ? t.settings.saving : t.settings.save}
              </Button>
              {hasCustomCredentials ? (
                <Button type="button" variant="outline" onClick={() => setConfirmReset(true)} disabled={resetting}>
                  <RotateCcw /> {t.settings.resetToEnv}
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {folderSavedMessage ? (
        <Alert variant="success"><AlertTitle>{t.settings.savedTitle}</AlertTitle><AlertDescription>{folderSavedMessage}</AlertDescription></Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FolderCog className="size-5 text-primary" /> {t.settings.folderCardTitle}</CardTitle>
          <CardDescription>{t.settings.folderCardDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-1 text-sm">
            <p className="text-muted-foreground">{t.settings.sourceLabel}</p>
            <Badge variant={folderStatus.source === "custom" ? "default" : "secondary"}>
              {FOLDER_SOURCE_LABEL[folderStatus.source]}
            </Badge>
          </div>

          <form onSubmit={(event) => void onSaveFolderName(event)} className="space-y-4 border-t pt-5">
            {folderFormError ? <ErrorAlert message={folderFormError} /> : null}
            <div className="space-y-2">
              <Label htmlFor="settings-root-folder-name">{t.settings.folderNameLabel}</Label>
              <Input
                id="settings-root-folder-name"
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                placeholder="[DRIVE-S3-GATEWAY]"
                maxLength={255}
              />
              <p className="text-xs text-muted-foreground">{t.settings.folderNameHelp}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="submit" disabled={savingFolder || !folderName.trim()}>
                {savingFolder ? t.settings.saving : t.settings.save}
              </Button>
              {folderStatus.source === "custom" ? (
                <Button type="button" variant="outline" onClick={() => setConfirmFolderReset(true)} disabled={resettingFolder}>
                  <RotateCcw /> {t.settings.resetToDefault}
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      <AlertDialog open={confirmReset} onOpenChange={(open) => { if (!resetting) setConfirmReset(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.settings.resetOauthConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span className="flex items-start gap-2">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                {t.settings.resetOauthConfirmDescription}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resetting}>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction disabled={resetting} onClick={(event) => { event.preventDefault(); void onReset(); }}>
              {resetting ? t.settings.resetting : t.settings.reset}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmFolderReset} onOpenChange={(open) => { if (!resettingFolder) setConfirmFolderReset(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.settings.resetFolderConfirmTitle}</AlertDialogTitle>
            <AlertDialogDescription>{t.settings.resetFolderConfirmDescription}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resettingFolder}>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction disabled={resettingFolder} onClick={(event) => { event.preventDefault(); void onResetFolderName(); }}>
              {resettingFolder ? t.settings.resetting : t.settings.reset}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
