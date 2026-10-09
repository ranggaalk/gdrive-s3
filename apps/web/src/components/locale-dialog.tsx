import { Check } from "lucide-react";
import { Button, Modal } from "@heroui/react";
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
    <Modal.Backdrop isOpen={open} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label={t.common.close} />
          <Modal.Header>
            <Modal.Heading>{t.localeDialog.title}</Modal.Heading>
            <p className="text-sm text-muted">{t.localeDialog.description}</p>
          </Modal.Header>

          <Modal.Body className="grid grid-cols-2 gap-2">
            {LOCALES.map(({ code, badge }) => {
              const active = locale === code;
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => setLocale(code)}
                  aria-pressed={active}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border p-3 text-left text-sm font-medium transition-colors hover:bg-default",
                    active ? "border-accent bg-accent-soft text-foreground" : "border-border text-muted hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                      active ? "bg-accent text-accent-foreground" : "bg-default text-muted",
                    )}
                  >
                    {badge}
                  </span>
                  <span className="flex-1 truncate">{t.localeDialog[code]}</span>
                  {active ? <Check className="size-4 shrink-0 text-accent" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </Modal.Body>

          <Modal.Footer>
            <Button slot="close" variant="outline">{t.common.close}</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
