import type { LucideIcon } from "lucide-react";
import { Alert, Spinner as HeroSpinner } from "@heroui/react";
import { useLocale } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

export function ErrorAlert({ message, title }: { message: string; title?: string }) {
  const { t } = useLocale();
  return (
    <Alert status="danger">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{title ?? t.feedback.errorTitle}</Alert.Title>
        <Alert.Description>{message}</Alert.Description>
      </Alert.Content>
    </Alert>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-64 flex-col items-center justify-center rounded-3xl border border-dashed bg-surface px-6 py-12 text-center", className)}>
      <div className="mb-4 rounded-full bg-accent-soft p-3 text-accent-soft-foreground">
        <Icon className="size-6" aria-hidden="true" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 max-w-md text-sm text-muted">{description}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  const { t } = useLocale();
  return (
    <span role="status" className={cn("inline-flex items-center justify-center", className)}>
      <HeroSpinner size="sm" color="current" aria-hidden="true" />
      <span className="sr-only">{label ?? t.feedback.loading}</span>
    </span>
  );
}

export function LoadingState({ label }: { label?: string }) {
  const { t } = useLocale();
  return (
    <div className="flex min-h-64 items-center justify-center rounded-3xl bg-surface shadow-surface">
      <Spinner className="text-accent" label={label ?? t.feedback.loadingData} />
    </div>
  );
}
