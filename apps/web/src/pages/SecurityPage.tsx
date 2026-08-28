import { useCallback, useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { Download, KeyRound, RotateCcw, ShieldCheck, ShieldOff, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CopyableCode } from "@/components/copyable-code";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { useToast } from "@/components/toast-provider";
import {
  confirmTotpSetup,
  disableTotp,
  getTotpStatus,
  regenerateRecoveryCodes,
  startTotpSetup,
  createKmsKey,
  listKmsKeys,
  rotateKmsKey,
  setKmsKeyStatus,
  type KmsKey,
  type TotpStatus,
} from "../api/client.ts";

type ConfirmAction = "disable" | "regenerate";

export function SecurityPage() {
  const { t } = useLocale();
  const toast = useToast();
  const [status, setStatus] = useState<TotpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Setup (enable) flow.
  const [settingUp, setSettingUp] = useState(false);
  const [setupInfo, setSetupInfo] = useState<{ otpauthUri: string; manualEntryKey: string } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  // Recovery codes reveal (shared by confirm-setup and regenerate).
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  // Disable / regenerate confirmation dialog (both require re-proving 2FA).
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  // Customer master keys for server-side encryption.
  const [kmsKeys, setKmsKeys] = useState<KmsKey[]>([]);
  const [kmsAlias, setKmsAlias] = useState("");
  const [kmsBusy, setKmsBusy] = useState(false);
  const [confirmCode, setConfirmCode] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [totp, keys] = await Promise.all([getTotpStatus(), listKmsKeys()]);
      setStatus(totp);
      setKmsKeys(keys);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const addKmsKey = async (event: FormEvent) => {
    event.preventDefault();
    const alias = kmsAlias.trim();
    if (!alias || kmsBusy) return;
    setKmsBusy(true);
    try {
      await createKmsKey(alias);
      setKmsKeys(await listKmsKeys());
      setKmsAlias("");
      toast.success(t.toast.kmsKeyCreated);
    } catch (cause) {
      toast.fromError(t.toast.kmsFailed, cause);
    } finally {
      setKmsBusy(false);
    }
  };

  const doRotateKey = async (key: KmsKey) => {
    setKmsBusy(true);
    try {
      await rotateKmsKey(key.id);
      setKmsKeys(await listKmsKeys());
      toast.success(t.toast.kmsKeyRotated);
    } catch (cause) {
      toast.fromError(t.toast.kmsFailed, cause);
    } finally {
      setKmsBusy(false);
    }
  };

  const toggleKeyStatus = async (key: KmsKey) => {
    setKmsBusy(true);
    try {
      await setKmsKeyStatus(key.id, key.status === "active" ? "disabled" : "active");
      setKmsKeys(await listKmsKeys());
    } catch (cause) {
      toast.fromError(t.toast.kmsFailed, cause);
    } finally {
      setKmsBusy(false);
    }
  };

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!setupInfo) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(setupInfo.otpauthUri, { width: 220, margin: 1 }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => { cancelled = true; };
  }, [setupInfo]);

  const onStartSetup = async () => {
    if (settingUp) return;
    setSettingUp(true);
    setSetupError(null);
    setError(null);
    try {
      setSetupInfo(await startTotpSetup());
      setSetupCode("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.totpFailed, cause);
    } finally {
      setSettingUp(false);
    }
  };

  const onCancelSetup = () => {
    setSetupInfo(null);
    setSetupCode("");
    setSetupError(null);
  };

  const onConfirmSetup = async (event: FormEvent) => {
    event.preventDefault();
    const value = setupCode.trim();
    if (!value || confirming) return;
    setConfirming(true);
    setSetupError(null);
    try {
      const { recoveryCodes: codes } = await confirmTotpSetup(value);
      setSetupInfo(null);
      setSetupCode("");
      setRecoveryCodes(codes);
      toast.success(t.toast.totpEnabled);
      await load();
    } catch (cause) {
      setSetupError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.totpFailed, cause);
    } finally {
      setConfirming(false);
    }
  };

  const onConfirmDialogSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const value = confirmCode.trim();
    if (!value || confirmBusy || !confirmAction) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (confirmAction === "disable") {
        await disableTotp(value);
        setConfirmAction(null);
        setConfirmCode("");
        toast.success(t.toast.totpDisabled);
        await load();
      } else {
        const { recoveryCodes: codes } = await regenerateRecoveryCodes(value);
        setConfirmAction(null);
        setConfirmCode("");
        setRecoveryCodes(codes);
        toast.success(t.toast.recoveryCodesRegenerated);
        await load();
      }
    } catch (cause) {
      setConfirmError(cause instanceof Error ? cause.message : String(cause));
      toast.fromError(t.toast.totpFailed, cause);
    } finally {
      setConfirmBusy(false);
    }
  };

  const downloadRecoveryCodes = () => {
    if (!recoveryCodes) return;
    const lines = [
      t.security.recoveryCodesFileHeading,
      "=".repeat(t.security.recoveryCodesFileHeading.length),
      "",
      ...t.security.recoveryCodesFileWarning,
      "",
      ...recoveryCodes,
      "",
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "drives3-2fa-recovery-codes.txt";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  if (loading) return <LoadingState label={t.security.loading} />;

  if (error) {
    return <ErrorAlert message={error} />;
  }

  if (!status) return null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" /> {t.security.cardTitle}
          </CardTitle>
          <CardDescription>{t.security.cardDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={status.enabled ? "success" : "secondary"}>
              {status.enabled ? t.security.statusEnabled : t.security.statusDisabled}
            </Badge>
            {status.enabled ? (
              <span className="text-sm text-muted-foreground">
                {t.security.recoveryCodesRemaining(status.recoveryCodesRemaining)}
              </span>
            ) : null}
          </div>

          {!status.enabled && !setupInfo ? (
            <Button onClick={() => void onStartSetup()} disabled={settingUp}>
              <ShieldCheck /> {t.security.enableButton}
            </Button>
          ) : null}

          {status.enabled ? (
            <div className="flex flex-wrap gap-2 border-t pt-5">
              <Button
                type="button"
                variant="outline"
                onClick={() => { setConfirmAction("regenerate"); setConfirmCode(""); setConfirmError(null); }}
              >
                <RotateCcw /> {t.security.regenerateButton}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => { setConfirmAction("disable"); setConfirmCode(""); setConfirmError(null); }}
              >
                <ShieldOff /> {t.security.disableButton}
              </Button>
            </div>
          ) : null}

          {setupInfo ? (
            <form onSubmit={(event) => void onConfirmSetup(event)} className="space-y-4 border-t pt-5">
              <div>
                <h3 className="font-medium">{t.security.setupTitle}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t.security.setupDescription}</p>
              </div>
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={t.security.setupTitle}
                  width={220}
                  height={220}
                  className="rounded-md border bg-white p-2"
                />
              ) : (
                <div className="flex size-[220px] items-center justify-center rounded-md border">
                  <span className="text-xs text-muted-foreground">…</span>
                </div>
              )}
              <div className="space-y-2">
                <Label>{t.security.manualEntryLabel}</Label>
                <CopyableCode value={setupInfo.manualEntryKey} label={t.security.manualEntryCopyLabel} />
              </div>
              {setupError ? <ErrorAlert message={setupError} /> : null}
              <div className="space-y-2">
                <Label htmlFor="security-setup-code">{t.security.confirmCodeLabel}</Label>
                <Input
                  id="security-setup-code"
                  value={setupCode}
                  onChange={(event) => setSetupCode(event.target.value)}
                  placeholder="123456"
                  autoComplete="one-time-code"
                  aria-invalid={Boolean(setupError)}
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={!setupCode.trim() || confirming}>
                  {confirming ? t.security.confirming : t.security.confirmButton}
                </Button>
                <Button type="button" variant="outline" onClick={onCancelSetup} disabled={confirming}>
                  {t.security.cancelSetup}
                </Button>
              </div>
            </form>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(confirmAction)}
        onOpenChange={(open) => { if (!open && !confirmBusy) { setConfirmAction(null); setConfirmError(null); } }}
      >
        <DialogContent>
          <form onSubmit={(event) => void onConfirmDialogSubmit(event)} className="space-y-5">
            <DialogHeader>
              <DialogTitle>
                {confirmAction === "disable" ? t.security.disableConfirmTitle : t.security.regenerateConfirmTitle}
              </DialogTitle>
              <DialogDescription>
                {confirmAction === "disable"
                  ? t.security.disableConfirmDescription
                  : t.security.regenerateConfirmDescription}
              </DialogDescription>
            </DialogHeader>
            {confirmError ? <ErrorAlert message={confirmError} /> : null}
            <div className="space-y-2">
              <Label htmlFor="security-confirm-code">{t.security.confirmCodeInputLabel}</Label>
              <Input
                id="security-confirm-code"
                value={confirmCode}
                onChange={(event) => setConfirmCode(event.target.value)}
                autoComplete="one-time-code"
                autoFocus
                aria-invalid={Boolean(confirmError)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={confirmBusy}
                onClick={() => { setConfirmAction(null); setConfirmError(null); }}
              >
                {t.common.cancel}
              </Button>
              <Button
                type="submit"
                className={confirmAction === "disable" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
                disabled={!confirmCode.trim() || confirmBusy}
              >
                {confirmBusy
                  ? t.security.processing
                  : confirmAction === "disable"
                    ? t.security.confirmAndDisable
                    : t.security.confirmAndRegenerate}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(recoveryCodes)} onOpenChange={(open) => { if (!open) setRecoveryCodes(null); }}>
        <DialogContent className="min-w-0 max-h-[90vh] max-w-lg overflow-x-hidden overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t.security.recoveryCodesTitle}</DialogTitle>
            <DialogDescription>{t.security.recoveryCodesDescription}</DialogDescription>
          </DialogHeader>
          {recoveryCodes ? (
            <div className="min-w-0 space-y-5">
              <Alert variant="warning">
                <TriangleAlert />
                <AlertTitle>{t.security.recoveryCodesTitle}</AlertTitle>
                <AlertDescription>{t.security.recoveryCodesDescription}</AlertDescription>
              </Alert>
              <CopyableCode value={recoveryCodes.join("\n")} label={t.security.recoveryCodesCopyLabel} />
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={downloadRecoveryCodes}>
              <Download /> {t.security.downloadRecoveryCodes}
            </Button>
            <Button onClick={() => setRecoveryCodes(null)}>{t.security.done}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-primary" /> {t.security.kmsTitle}
          </CardTitle>
          <CardDescription>{t.security.kmsDescription}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void addKmsKey(event)}>
            <div className="min-w-52 flex-1 space-y-2">
              <Label htmlFor="kms-alias">{t.security.kmsAliasLabel}</Label>
              <Input
                id="kms-alias"
                value={kmsAlias}
                maxLength={128}
                placeholder={t.security.kmsAliasPlaceholder}
                onChange={(event) => setKmsAlias(event.target.value)}
              />
            </div>
            <Button type="submit" disabled={!kmsAlias.trim() || kmsBusy}>
              {kmsBusy ? t.security.kmsCreating : t.security.kmsCreate}
            </Button>
          </form>

          {kmsKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.security.kmsEmpty}</p>
          ) : (
            <div className="space-y-2">
              {kmsKeys.map((key) => (
                <div key={key.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{key.alias}</p>
                      <Badge variant={key.status === "active" ? "success" : "secondary"}>
                        {key.status === "active" ? t.security.kmsStatusActive : t.security.kmsStatusDisabled}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t.security.kmsVersion(key.version)} · {t.security.kmsObjectCount(key.objectCount)}
                      {key.rotatedAt ? ` · ${new Date(key.rotatedAt).toLocaleString()}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled={kmsBusy} onClick={() => void doRotateKey(key)}>
                      <RotateCcw /> {kmsBusy ? t.security.kmsRotating : t.security.kmsRotate}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={kmsBusy} onClick={() => void toggleKeyStatus(key)}>
                      {key.status === "active" ? t.security.kmsDisable : t.security.kmsEnable}
                    </Button>
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">{t.security.kmsRotateHint}</p>
              <p className="text-xs text-muted-foreground">{t.security.kmsDisabledHint}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
