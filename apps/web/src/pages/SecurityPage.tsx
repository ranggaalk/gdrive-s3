import { useCallback, useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { Download, KeyRound, RotateCcw, ShieldCheck, ShieldOff, TriangleAlert } from "lucide-react";
import { Alert, Button, Card, Chip, Input, InputOTP, Label, Modal, REGEXP_ONLY_DIGITS } from "@heroui/react";
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
        <Card.Header>
          <Card.Title className="flex items-center gap-2 text-base font-semibold">
            <ShieldCheck className="size-5 text-accent" /> {t.security.cardTitle}
          </Card.Title>
          <Card.Description>{t.security.cardDescription}</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            {status.enabled ? (
              <Chip color="success" variant="soft">{t.security.statusEnabled}</Chip>
            ) : (
              <Chip>{t.security.statusDisabled}</Chip>
            )}
            {status.enabled ? (
              <span className="text-sm text-muted">
                {t.security.recoveryCodesRemaining(status.recoveryCodesRemaining)}
              </span>
            ) : null}
          </div>

          {!status.enabled && !setupInfo ? (
            <Button className="w-fit" onPress={() => void onStartSetup()} isDisabled={settingUp}>
              <ShieldCheck /> {t.security.enableButton}
            </Button>
          ) : null}

          {status.enabled ? (
            <div className="flex flex-wrap gap-2 border-t border-separator pt-5">
              <Button
                variant="outline"
                onPress={() => { setConfirmAction("regenerate"); setConfirmCode(""); setConfirmError(null); }}
              >
                <RotateCcw /> {t.security.regenerateButton}
              </Button>
              <Button
                variant="outline"
                className="text-danger"
                onPress={() => { setConfirmAction("disable"); setConfirmCode(""); setConfirmError(null); }}
              >
                <ShieldOff /> {t.security.disableButton}
              </Button>
            </div>
          ) : null}

          {setupInfo ? (
            <form onSubmit={(event) => void onConfirmSetup(event)} className="space-y-4 border-t border-separator pt-5">
              <div>
                <h3 className="font-medium">{t.security.setupTitle}</h3>
                <p className="mt-1 text-sm text-muted">{t.security.setupDescription}</p>
              </div>
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={t.security.setupTitle}
                  width={220}
                  height={220}
                  className="rounded-xl border bg-white p-2"
                />
              ) : (
                <div className="flex size-[220px] items-center justify-center rounded-xl border">
                  <span className="text-xs text-muted">…</span>
                </div>
              )}
              <div className="space-y-2">
                <Label>{t.security.manualEntryLabel}</Label>
                <CopyableCode value={setupInfo.manualEntryKey} label={t.security.manualEntryCopyLabel} />
              </div>
              {setupError ? <ErrorAlert message={setupError} /> : null}
              <div className="space-y-2">
                <Label htmlFor="security-setup-code">{t.security.confirmCodeLabel}</Label>
                {/* Enabling 2FA is proven with an authenticator code only --
                    recovery codes do not exist yet -- so six digit slots fit. */}
                <InputOTP
                  id="security-setup-code"
                  maxLength={6}
                  pattern={REGEXP_ONLY_DIGITS}
                  value={setupCode}
                  onChange={setSetupCode}
                  autoComplete="one-time-code"
                  isInvalid={Boolean(setupError)}
                >
                  <InputOTP.Group>
                    <InputOTP.Slot index={0} />
                    <InputOTP.Slot index={1} />
                    <InputOTP.Slot index={2} />
                  </InputOTP.Group>
                  <InputOTP.Separator />
                  <InputOTP.Group>
                    <InputOTP.Slot index={3} />
                    <InputOTP.Slot index={4} />
                    <InputOTP.Slot index={5} />
                  </InputOTP.Group>
                </InputOTP>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" isDisabled={!setupCode.trim() || confirming}>
                  {confirming ? t.security.confirming : t.security.confirmButton}
                </Button>
                <Button variant="outline" onPress={onCancelSetup} isDisabled={confirming}>
                  {t.security.cancelSetup}
                </Button>
              </div>
            </form>
          ) : null}
        </Card.Content>
      </Card>

      <Modal.Backdrop
        isOpen={Boolean(confirmAction)}
        onOpenChange={(open) => { if (!open && !confirmBusy) { setConfirmAction(null); setConfirmError(null); } }}
      >
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger aria-label={t.common.close} />
            <form onSubmit={(event) => void onConfirmDialogSubmit(event)} className="flex min-h-0 flex-1 flex-col">
              <Modal.Header>
                <Modal.Heading>
                  {confirmAction === "disable" ? t.security.disableConfirmTitle : t.security.regenerateConfirmTitle}
                </Modal.Heading>
                <p className="text-sm text-muted">
                  {confirmAction === "disable"
                    ? t.security.disableConfirmDescription
                    : t.security.regenerateConfirmDescription}
                </p>
              </Modal.Header>
              <Modal.Body className="space-y-5">
                {confirmError ? <ErrorAlert message={confirmError} /> : null}
                <div className="space-y-2">
                  <Label htmlFor="security-confirm-code">{t.security.confirmCodeInputLabel}</Label>
                  {/* Not InputOTP: a recovery code is accepted here too. */}
                  <Input
                    id="security-confirm-code"
                    fullWidth
                    value={confirmCode}
                    onChange={(event) => setConfirmCode(event.target.value)}
                    autoComplete="one-time-code"
                    autoFocus
                    aria-invalid={Boolean(confirmError)}
                  />
                </div>
              </Modal.Body>
              <Modal.Footer>
                <Button slot="close" variant="tertiary" isDisabled={confirmBusy}>
                  {t.common.cancel}
                </Button>
                <Button
                  type="submit"
                  variant={confirmAction === "disable" ? "danger" : "primary"}
                  isDisabled={!confirmCode.trim() || confirmBusy}
                >
                  {confirmBusy
                    ? t.security.processing
                    : confirmAction === "disable"
                      ? t.security.confirmAndDisable
                      : t.security.confirmAndRegenerate}
                </Button>
              </Modal.Footer>
            </form>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Modal.Backdrop isOpen={Boolean(recoveryCodes)} onOpenChange={(open) => { if (!open) setRecoveryCodes(null); }}>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.CloseTrigger aria-label={t.common.close} />
            <Modal.Header>
              <Modal.Heading>{t.security.recoveryCodesTitle}</Modal.Heading>
              <p className="text-sm text-muted">{t.security.recoveryCodesDescription}</p>
            </Modal.Header>
            <Modal.Body>
              {recoveryCodes ? (
                <div className="min-w-0 space-y-5">
                  <Alert status="warning">
                    <Alert.Indicator>
                      <TriangleAlert />
                    </Alert.Indicator>
                    <Alert.Content>
                      <Alert.Title>{t.security.recoveryCodesTitle}</Alert.Title>
                      <Alert.Description>{t.security.recoveryCodesDescription}</Alert.Description>
                    </Alert.Content>
                  </Alert>
                  <CopyableCode value={recoveryCodes.join("\n")} label={t.security.recoveryCodesCopyLabel} />
                </div>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="outline" onPress={downloadRecoveryCodes}>
                <Download /> {t.security.downloadRecoveryCodes}
              </Button>
              <Button slot="close">{t.security.done}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <Card>
        <Card.Header>
          <Card.Title className="flex items-center gap-2 text-base font-semibold">
            <KeyRound className="size-5 text-accent" /> {t.security.kmsTitle}
          </Card.Title>
          <Card.Description>{t.security.kmsDescription}</Card.Description>
        </Card.Header>
        <Card.Content className="space-y-5">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => void addKmsKey(event)}>
            <div className="min-w-52 flex-1 space-y-2">
              <Label htmlFor="kms-alias">{t.security.kmsAliasLabel}</Label>
              <Input
                id="kms-alias"
                fullWidth
                value={kmsAlias}
                maxLength={128}
                placeholder={t.security.kmsAliasPlaceholder}
                onChange={(event) => setKmsAlias(event.target.value)}
              />
            </div>
            <Button type="submit" isDisabled={!kmsAlias.trim() || kmsBusy}>
              {kmsBusy ? t.security.kmsCreating : t.security.kmsCreate}
            </Button>
          </form>

          {kmsKeys.length === 0 ? (
            <p className="text-sm text-muted">{t.security.kmsEmpty}</p>
          ) : (
            <div className="space-y-2">
              {kmsKeys.map((key) => (
                <div key={key.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{key.alias}</p>
                      {key.status === "active" ? (
                        <Chip size="sm" color="success" variant="soft">{t.security.kmsStatusActive}</Chip>
                      ) : (
                        <Chip size="sm">{t.security.kmsStatusDisabled}</Chip>
                      )}
                    </div>
                    <p className="text-xs text-muted">
                      {t.security.kmsVersion(key.version)} · {t.security.kmsObjectCount(key.objectCount)}
                      {key.rotatedAt ? ` · ${new Date(key.rotatedAt).toLocaleString()}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" isDisabled={kmsBusy} onPress={() => void doRotateKey(key)}>
                      <RotateCcw /> {kmsBusy ? t.security.kmsRotating : t.security.kmsRotate}
                    </Button>
                    <Button size="sm" variant="ghost" isDisabled={kmsBusy} onPress={() => void toggleKeyStatus(key)}>
                      {key.status === "active" ? t.security.kmsDisable : t.security.kmsEnable}
                    </Button>
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted">{t.security.kmsRotateHint}</p>
              <p className="text-xs text-muted">{t.security.kmsDisabledHint}</p>
            </div>
          )}
        </Card.Content>
      </Card>
    </div>
  );
}
