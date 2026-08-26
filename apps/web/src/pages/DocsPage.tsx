import { useCallback, useEffect, useState } from "react";
import {
  Bot,
  BookOpen,
  CheckCircle2,
  KeyRound,
  PackageOpen,
  RefreshCw,
  ShieldCheck,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import { CopyableCode } from "@/components/copyable-code";
import { MarkdownCanvas } from "@/components/markdown-canvas";
import { ErrorAlert, LoadingState } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { documentationSetupExample, s3CommandExamples } from "@/lib/s3-cli";
import { getGatewayStatus, type CompatibilityItem, type GatewayStatus } from "../api/client.ts";
import aiAgentSkillTemplate from "../docs/drive-s3-ai-agent-skill.md?raw";

function Step({ number, title, children }: { number: number; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3" aria-labelledby={`documentation-step-${number}`}>
      <div className="flex items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">{number}</span>
        <h2 id={`documentation-step-${number}`} className="text-lg font-semibold">{title}</h2>
      </div>
      <div className="space-y-4 pl-11">{children}</div>
    </section>
  );
}

export function DocsPage({ onOpenBuckets, onOpenCredentials }: { onOpenBuckets: () => void; onOpenCredentials: () => void }) {
  const { t } = useLocale();
  const statusVariant: Record<CompatibilityItem["status"], "success" | "destructive" | "warning"> = {
    supported: "success",
    unsupported: "destructive",
    untested: "warning",
  };
  const statusLabel: Record<CompatibilityItem["status"], string> = {
    supported: t.compat.supported,
    unsupported: t.compat.unsupported,
    untested: t.compat.untested,
  };

  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setGateway(await getGatewayStatus());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) return <LoadingState label={t.docs.loading} />;

  if (!gateway) {
    return (
      <div className="space-y-4">
        <ErrorAlert title={t.docs.unavailableTitle} message={error ?? t.docs.unavailableFallback} />
        <Button variant="outline" onClick={() => void load()}><RefreshCw /> {t.docs.retry}</Button>
      </div>
    );
  }

  const commands = s3CommandExamples(gateway, t.docs.bucketNamePlaceholder);
  const clients = gateway.compatibility.filter((item) => /compatibility smoke/i.test(item.feature));
  const aiAgentSkill = aiAgentSkillTemplate
    .replaceAll("{{S3_ENDPOINT}}", gateway.s3Endpoint)
    .replaceAll("{{S3_REGION}}", gateway.s3Region);

  return (
    <div className="space-y-6">
      <Alert>
        <BookOpen />
        <AlertTitle>{t.docs.guideTitle}</AlertTitle>
        <AlertDescription>{t.docs.guideDescription}</AlertDescription>
      </Alert>

      <Card>
        <CardHeader><CardTitle>{t.docs.gatewayConfigTitle}</CardTitle><CardDescription>{t.docs.gatewayConfigDescription}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 rounded-lg border bg-muted/40 p-4"><p className="text-sm text-muted-foreground">{t.docs.s3Endpoint}</p><p className="mt-1 break-all font-mono text-sm font-medium">{gateway.s3Endpoint}</p></div>
          <div className="rounded-lg border bg-muted/40 p-4"><p className="text-sm text-muted-foreground">{t.docs.signingRegion}</p><p className="mt-1 font-mono text-sm font-medium">{gateway.s3Region}</p></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t.docs.getStartedTitle}</CardTitle><CardDescription>{t.docs.getStartedDescription}</CardDescription></CardHeader>
        <CardContent className="space-y-8">
          <Step number={1} title={t.docs.step1Title}>
            <p className="text-sm text-muted-foreground">{t.docs.step1Text}</p>
            <Button variant="outline" onClick={onOpenBuckets}><PackageOpen /> {t.docs.step1Button}</Button>
          </Step>

          <Step number={2} title={t.docs.step2Title}>
            <p className="text-sm text-muted-foreground">{t.docs.step2Text}</p>
            <Button variant="outline" onClick={onOpenCredentials}><KeyRound /> {t.docs.step2Button}</Button>
          </Step>

          <Step number={3} title={t.docs.step3Title}>
            <p className="text-sm text-muted-foreground">{t.docs.step3Text}</p>
            <CopyableCode
              value={documentationSetupExample(gateway, {
                accessKeyId: t.docs.accessKeyIdPlaceholder,
                secretAccessKey: t.docs.secretAccessKeyPlaceholder,
              })}
              label={t.docs.step3CopyLabel}
            />
          </Step>

          <Step number={4} title={t.docs.step4Title}>
            <p className="text-sm text-muted-foreground">{t.docs.step4Text}</p>
            <CopyableCode value={commands.test} label={t.docs.step4CopyLabel} />
          </Step>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Terminal className="size-5" /> {t.docs.basicCommandsTitle}</CardTitle><CardDescription>{t.docs.basicCommandsDescription}</CardDescription></CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-2">
          <div className="min-w-0 space-y-2"><h2 className="font-medium">{t.docs.uploadObject}</h2><CopyableCode value={commands.upload} label={t.docs.uploadCommandLabel} /></div>
          <div className="min-w-0 space-y-2"><h2 className="font-medium">{t.docs.listObject}</h2><CopyableCode value={commands.list} label={t.docs.listCommandLabel} /></div>
          <div className="min-w-0 space-y-2"><h2 className="font-medium">{t.docs.downloadObject}</h2><CopyableCode value={commands.download} label={t.docs.downloadCommandLabel} /></div>
          <div className="min-w-0 space-y-2"><h2 className="font-medium">{t.docs.deleteObject}</h2><CopyableCode value={commands.remove} label={t.docs.removeCommandLabel} /></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Bot className="size-5" /> {t.docs.aiSkillTitle}</CardTitle>
          <CardDescription>{t.docs.aiSkillDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <MarkdownCanvas
            value={aiAgentSkill}
            fileName="drive-s3-ai-agent-skill.md"
            label={t.docs.aiSkillCopyLabel}
          />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-5" /> {t.docs.credentialSecurityTitle}</CardTitle></CardHeader>
          <CardContent>
            <ul className="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
              {t.docs.credentialSecurityItems.map((item) => <li key={item}>{item}</li>)}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><CheckCircle2 className="size-5" /> {t.docs.compatibilityTitle}</CardTitle><CardDescription>{t.docs.compatibilityDescription}</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {clients.length > 0 ? <div className="space-y-3">{clients.map((item) => <div key={item.feature} className="flex items-start justify-between gap-3"><span className="text-sm">{item.feature}</span><Badge variant={statusVariant[item.status]}>{statusLabel[item.status]}</Badge></div>)}</div> : <p className="text-sm text-muted-foreground">{t.docs.compatibilityFallback}</p>}
            <Alert variant="warning"><TriangleAlert /><AlertTitle>{t.docs.limitationsTitle}</AlertTitle><AlertDescription>{t.docs.limitationsDescription}</AlertDescription></Alert>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
