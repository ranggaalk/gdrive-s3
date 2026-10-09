import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { Button, buttonVariants, Card, Input, Label } from "@heroui/react";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { getMfaLoginStatus, verifyMfaLogin } from "../api/client.ts";

export function MfaVerifyPage({ onVerified }: { onVerified: () => void }) {
  const { t } = useLocale();
  const [loading, setLoading] = useState(true);
  const [expired, setExpired] = useState(false);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getMfaLoginStatus()
      .then((status) => {
        if (cancelled) return;
        if (!status.pending) setExpired(true);
      })
      .catch(() => {
        if (!cancelled) setExpired(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (!value || verifying) return;
    setVerifying(true);
    setError(null);
    try {
      await verifyMfaLogin(value);
      onVerified();
    } catch {
      setError(t.mfa.invalidCode);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-linear-to-b from-accent/10 via-background to-background p-4">
      <Card className="w-full max-w-md gap-6 p-6 shadow-overlay sm:p-8">
        <Card.Header className="items-center text-center">
          <div className="mb-3 rounded-2xl bg-accent p-3 text-accent-foreground shadow-lg shadow-accent/20">
            <ShieldCheck className="size-8" aria-hidden="true" />
          </div>
          <Card.Title className="text-2xl font-semibold">{t.mfa.pageTitle}</Card.Title>
          <Card.Description className="max-w-sm">{t.mfa.description}</Card.Description>
        </Card.Header>
        <Card.Content>
          {loading ? (
            <LoadingState label={t.mfa.loadingSession} />
          ) : expired ? (
            <div className="space-y-4">
              <ErrorAlert title={t.mfa.sessionExpiredTitle} message={t.mfa.sessionExpiredDescription} />
              <a href="/auth/google/start" className={buttonVariants({ fullWidth: true })}>
                {t.mfa.backToLogin}
              </a>
            </div>
          ) : (
            <form onSubmit={(event) => void onSubmit(event)} className="space-y-4">
              {error ? <ErrorAlert message={error} /> : null}
              <div className="space-y-2">
                <Label htmlFor="mfa-code">{t.mfa.codeLabel}</Label>
                {/* Not InputOTP: this field also takes a recovery code, which is
                    neither six characters nor digits only. */}
                <Input
                  id="mfa-code"
                  fullWidth
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder={t.mfa.codePlaceholder}
                  inputMode="text"
                  autoComplete="one-time-code"
                  autoFocus
                  aria-invalid={Boolean(error)}
                />
              </div>
              <Button type="submit" size="lg" fullWidth isDisabled={!code.trim() || verifying}>
                {verifying ? t.mfa.verifying : t.mfa.verifyButton}
              </Button>
            </form>
          )}
        </Card.Content>
      </Card>
    </main>
  );
}
