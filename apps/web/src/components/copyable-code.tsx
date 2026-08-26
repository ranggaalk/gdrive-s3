import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

export function CopyableCode({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  const { t } = useLocale();
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus("copied");
      window.setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("error");
    }
  };

  return (
    <div className={cn("relative w-full min-w-0 overflow-hidden rounded-md border bg-neutral-950 text-neutral-50", className)}>
      <pre className="min-w-0 whitespace-pre-wrap break-all p-4 pr-14 text-xs leading-6">
        <code>{value}</code>
      </pre>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute right-2 top-2 text-neutral-300 hover:bg-white/10 hover:text-white"
        aria-label={status === "copied" ? t.copy.copiedLabel(label) : t.copy.copyLabel(label)}
        onClick={copy}
      >
        {status === "copied" ? <Check /> : <Copy />}
      </Button>
      <span className="sr-only" aria-live="polite">
        {status === "copied" ? t.copy.copiedNotice(label) : status === "error" ? t.copy.errorNotice(label) : ""}
      </span>
    </div>
  );
}
