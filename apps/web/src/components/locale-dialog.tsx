import { Check } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/components/locale-provider";
import type { Locale } from "@/lib/i18n/types";
import { cn } from "@/lib/utils";

const LOCALES: Array<{ code: Locale; badge: string }> = [
  { code: "id", badge: "ID" },
  { code: "en", badge: "EN" },
];

export function LocaleDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { locale, setLocale, t } = useLocale();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.localeDialog.title}</DialogTitle>
          <DialogDescription>{t.localeDialog.description}</DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          {LOCALES.map(({ code, badge }) => {
            const active = locale === code;
            return (
              <button
                key={code}
                type="button"
                onClick={() => setLocale(code)}
                aria-pressed={active}
                className={cn(
                  "flex items-center gap-3 rounded-lg border p-3 text-left text-sm font-medium transition-colors hover:bg-accent",
                  active ? "border-primary bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                    active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                  )}
                >
                  {badge}
                </span>
                <span className="flex-1 truncate">{t.localeDialog[code]}</span>
                {active ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t.common.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
