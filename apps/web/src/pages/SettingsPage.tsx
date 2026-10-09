import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FolderCog, KeyRound, RotateCcw, ShieldAlert } from "lucide-react";
import { Alert, AlertDialog, Button, Card, Chip, Input, Label } from "@heroui/react";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { useToast } from "@/components/toast-provider";
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
  const toast = useToast();
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
      toast.success(t.toast.settingsSaved, t.settings.oauthSavedMessage);
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.settingsFailed, cause);
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
      toast.success(t.toast.settingsReset, t.settings.oauthResetMessage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.settingsFailed, cause);
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
      toast.success(t.toast.settingsSaved, t.settings.folderSavedMessage);
    } catch (cause) {
      setFolderFormError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.settingsFailed, cause);
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
      toast.success(t.toast.settingsReset, t.settings.folderResetMessage);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.settingsFailed, cause);
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
      <Alert status="warning">
        <Alert.Indicator>
          <ShieldAlert />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>{t.settings.impactWarningTitle}</Alert.Title>
          <Alert.Description>{t.settings.impactWarningDescription}</Alert.Description>
        </Alert.Content>
      </Alert>

      {savedMessage ? (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.settings.savedTitle}</Alert.Title>
            <Alert.Description>{savedMessage}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <Card>
        <Card.Header>
          <Card.Title className="flex items-center gap-2 text-base font-semibold"><KeyRound className="size-5 text-accent" /> {t.settings.oauthCardTitle}</Card.Title>
          <Card.Description>{t.settings.oauthCardDescription}</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-5">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-muted">{t.settings.clientIdSourceLabel}</p>
              <Chip color={status.clientIdSource === "database" ? "accent" : "default"} variant={status.clientIdSource === "database" ? "soft" : "secondary"}>
                {SOURCE_LABEL[status.clientIdSource]}
              </Chip>
            </div>
            <div className="space-y-1">
              <p className="text-muted">{t.settings.clientSecretSourceLabel}</p>
              <Chip color={status.clientSecretSource === "database" ? "accent" : "default"} variant={status.clientSecretSource === "database" ? "soft" : "secondary"}>
                {SOURCE_LABEL[status.clientSecretSource]}
              </Chip>
            </div>
          </div>

          <form onSubmit={(event) => void onSave(event)} className="space-y-4 border-t border-separator pt-5">
            {formError ? <ErrorAlert message={formError} /> : null}
            <div className="space-y-2">
              <Label htmlFor="settings-client-id">{t.settings.clientIdLabel}</Label>
              <Input
                id="settings-client-id"
                fullWidth
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
                fullWidth
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder={t.settings.clientSecretPlaceholder}
                autoComplete="off"
              />
              <p className="text-xs text-muted">{t.settings.clientSecretHelp}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="submit" isDisabled={saving || !clientId.trim() || !clientSecret.trim()}>
                {saving ? t.settings.saving : t.settings.save}
              </Button>
              {hasCustomCredentials ? (
                <Button variant="outline" onPress={() => setConfirmReset(true)} isDisabled={resetting}>
                  <RotateCcw /> {t.settings.resetToEnv}
                </Button>
              ) : null}
            </div>
          </form>
        </Card.Content>
      </Card>

      {folderSavedMessage ? (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t.settings.savedTitle}</Alert.Title>
            <Alert.Description>{folderSavedMessage}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}

      <Card>
        <Card.Header>
          <Card.Title className="flex items-center gap-2 text-base font-semibold"><FolderCog className="size-5 text-accent" /> {t.settings.folderCardTitle}</Card.Title>
          <Card.Description>{t.settings.folderCardDescription}</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-5">
          <div className="space-y-1 text-sm">
            <p className="text-muted">{t.settings.sourceLabel}</p>
            <Chip color={folderStatus.source === "custom" ? "accent" : "default"} variant={folderStatus.source === "custom" ? "soft" : "secondary"}>
              {FOLDER_SOURCE_LABEL[folderStatus.source]}
            </Chip>
          </div>

          <form onSubmit={(event) => void onSaveFolderName(event)} className="space-y-4 border-t border-separator pt-5">
            {folderFormError ? <ErrorAlert message={folderFormError} /> : null}
            <div className="space-y-2">
              <Label htmlFor="settings-root-folder-name">{t.settings.folderNameLabel}</Label>
              <Input
                id="settings-root-folder-name"
                fullWidth
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
                placeholder="[DRIVE-S3-GATEWAY]"
                maxLength={255}
              />
              <p className="text-xs text-muted">{t.settings.folderNameHelp}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button type="submit" isDisabled={savingFolder || !folderName.trim()}>
                {savingFolder ? t.settings.saving : t.settings.save}
              </Button>
              {folderStatus.source === "custom" ? (
                <Button variant="outline" onPress={() => setConfirmFolderReset(true)} isDisabled={resettingFolder}>
                  <RotateCcw /> {t.settings.resetToDefault}
                </Button>
              ) : null}
            </div>
          </form>
        </Card.Content>
      </Card>

      <AlertDialog.Backdrop isOpen={confirmReset} onOpenChange={(open) => { if (!resetting) setConfirmReset(open); }}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning" />
              <AlertDialog.Heading>{t.settings.resetOauthConfirmTitle}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{t.settings.resetOauthConfirmDescription}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={resetting}>{t.common.cancel}</Button>
              <Button isDisabled={resetting} onPress={() => void onReset()}>
                {resetting ? t.settings.resetting : t.settings.reset}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop isOpen={confirmFolderReset} onOpenChange={(open) => { if (!resettingFolder) setConfirmFolderReset(open); }}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning" />
              <AlertDialog.Heading>{t.settings.resetFolderConfirmTitle}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>{t.settings.resetFolderConfirmDescription}</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary" isDisabled={resettingFolder}>{t.common.cancel}</Button>
              <Button isDisabled={resettingFolder} onPress={() => void onResetFolderName()}>
                {resettingFolder ? t.settings.resetting : t.settings.reset}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  );
}
