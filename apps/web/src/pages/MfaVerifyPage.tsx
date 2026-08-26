import { useEffect, useState, type FormEvent } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-primary/10 via-background to-background p-4">
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader className="items-center text-center">
          <div className="mb-3 rounded-2xl bg-primary p-3 text-primary-foreground shadow-lg shadow-primary/20">
            <ShieldCheck className="size-8" aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl">{t.mfa.pageTitle}</CardTitle>
          <CardDescription className="max-w-sm">{t.mfa.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <LoadingState label={t.mfa.loadingSession} />
          ) : expired ? (
            <div className="space-y-4">
              <ErrorAlert title={t.mfa.sessionExpiredTitle} message={t.mfa.sessionExpiredDescription} />
              <Button asChild className="w-full">
                <a href="/auth/google/start">{t.mfa.backToLogin}</a>
              </Button>
            </div>
          ) : (
            <form onSubmit={(event) => void onSubmit(event)} className="space-y-4">
              {error ? <ErrorAlert message={error} /> : null}
              <div className="space-y-2">
                <Label htmlFor="mfa-code">{t.mfa.codeLabel}</Label>
                <Input
                  id="mfa-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder={t.mfa.codePlaceholder}
                  inputMode="text"
                  autoComplete="one-time-code"
                  autoFocus
                  aria-invalid={Boolean(error)}
                />
              </div>
              <Button type="submit" size="lg" className="w-full" disabled={!code.trim() || verifying}>
                {verifying ? t.mfa.verifying : t.mfa.verifyButton}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
