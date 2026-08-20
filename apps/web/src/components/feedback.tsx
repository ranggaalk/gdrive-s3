import type { LucideIcon } from "lucide-react";
import { LoaderCircle, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export function ErrorAlert({ message, title = "Kesalahan" }: { message: string; title?: string }) {
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
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
    <div className={cn("flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed bg-card px-6 py-12 text-center", className)}>
      <div className="mb-4 rounded-full bg-primary/10 p-3 text-primary">
        <Icon className="size-6" aria-hidden="true" />
      </div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

export function Spinner({ className, label = "Memuat" }: { className?: string; label?: string }) {
  return (
    <span role="status" className={cn("inline-flex items-center justify-center", className)}>
      <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function LoadingState({ label = "Memuat data" }: { label?: string }) {
  return (
    <div className="flex min-h-64 items-center justify-center rounded-lg border bg-card">
      <Spinner className="text-primary" label={label} />
    </div>
  );
}
