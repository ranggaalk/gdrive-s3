import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button, Input, Label, Modal } from "@heroui/react";
import { useColorTheme } from "@/components/color-theme-provider";
import { useLocale } from "@/components/locale-provider";
import { CUSTOM_THEME_COLOR_ID, THEME_COLOR_PRESETS, isValidHexColor } from "@/lib/theme-colors";
import { cn } from "@/lib/utils";

export function ThemeColorDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { colorThemeId, customHex, setPreset, setCustomColor } = useColorTheme();
  const { t } = useLocale();
  const [hexDraft, setHexDraft] = useState(customHex ?? "#0485f7");

  useEffect(() => {
    if (open) setHexDraft(customHex ?? "#0485f7");
  }, [open, customHex]);

  const draftValid = isValidHexColor(hexDraft);
  const normalizedDraft = draftValid ? (hexDraft.startsWith("#") ? hexDraft : `#${hexDraft}`) : null;

  return (
    <Modal.Backdrop isOpen={open} onOpenChange={onOpenChange}>
      <Modal.Container>
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label={t.common.close} />
          <Modal.Header>
            <Modal.Heading>{t.themeDialog.title}</Modal.Heading>
            <p className="text-sm text-muted">{t.themeDialog.description}</p>
          </Modal.Header>

          <Modal.Body className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {THEME_COLOR_PRESETS.map((preset) => {
                const active = colorThemeId === preset.id;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setPreset(preset.id)}
                    aria-pressed={active}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-xl border p-2 text-xs transition-colors hover:bg-default",
                      active ? "border-accent bg-accent-soft" : "border-transparent",
                    )}
                  >
                    <span className="flex size-8 items-center justify-center rounded-full border" style={{ backgroundColor: preset.swatch }}>
                      {active ? <Check className="size-4 text-white drop-shadow-sm" aria-hidden="true" /> : null}
                    </span>
                    <span className="text-muted">{t.themeDialog.presets[preset.id] ?? preset.label}</span>
                  </button>
                );
              })}
            </div>

            <div className="space-y-2 border-t border-separator pt-4">
              <Label htmlFor="theme-custom-color">{t.themeDialog.customColorLabel}</Label>
              <div className="flex items-center gap-2">
                <input
                  id="theme-custom-color"
                  type="color"
                  value={normalizedDraft ?? "#0485f7"}
                  onChange={(event) => setHexDraft(event.target.value)}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-field border border-field-border bg-field p-1"
                  aria-label={t.themeDialog.pickCustomColor}
                />
                <Input
                  value={hexDraft}
                  onChange={(event) => setHexDraft(event.target.value)}
                  maxLength={7}
                  className="min-w-0 flex-1 font-mono uppercase"
                  aria-invalid={!draftValid}
                  aria-label={t.themeDialog.customColorLabel}
                  placeholder="#0485F7"
                />
                <Button
                  variant={colorThemeId === CUSTOM_THEME_COLOR_ID ? "primary" : "outline"}
                  isDisabled={!normalizedDraft}
                  onPress={() => normalizedDraft && setCustomColor(normalizedDraft)}
                >
                  {t.themeDialog.use}
                </Button>
              </div>
              {!draftValid ? <p className="text-xs text-danger">{t.themeDialog.invalidFormat}</p> : null}
            </div>
          </Modal.Body>

          <Modal.Footer>
            <Button slot="close" variant="outline">{t.common.close}</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
