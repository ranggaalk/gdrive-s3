import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import { cn } from "@/lib/utils";

export function MarkdownCanvas({
  value,
  fileName,
  label,
  className,
}: {
  value: string;
  fileName: string;
  label: string;
  className?: string;
}) {
  const { t } = useLocale();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 2000);
    } catch {
      setCopyStatus("error");
    }
  };

  const download = () => {
    const blob = new Blob([value], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2">
        <span className="truncate font-mono text-xs text-muted-foreground">{fileName}</span>
        <div className="flex shrink-0 gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void copy()} aria-label={t.copy.copyLabel(label)}>
            {copyStatus === "copied" ? <Check /> : <Copy />}
            {copyStatus === "copied" ? t.copy.copied : t.copy.copy}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={download} aria-label={t.copy.downloadLabel(label)}>
            <Download /> {t.copy.downloadMd}
          </Button>
        </div>
      </div>
      <pre className="max-h-[32rem] min-w-0 overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-6">
        <code>{value}</code>
      </pre>
      <span className="sr-only" aria-live="polite">
        {copyStatus === "copied" ? t.copy.copiedNotice(label) : copyStatus === "error" ? t.copy.errorNotice(label) : ""}
      </span>
    </div>
  );
}
