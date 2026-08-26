import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useColorTheme } from "@/components/color-theme-provider";
import { useLocale } from "@/components/locale-provider";
import { CUSTOM_THEME_COLOR_ID, THEME_COLOR_PRESETS, isValidHexColor } from "@/lib/theme-colors";
import { cn } from "@/lib/utils";

export function ThemeColorDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { colorThemeId, customHex, setPreset, setCustomColor } = useColorTheme();
  const { t } = useLocale();
  const [hexDraft, setHexDraft] = useState(customHex ?? "#2f6fed");

  useEffect(() => {
    if (open) setHexDraft(customHex ?? "#2f6fed");
  }, [open, customHex]);

  const draftValid = isValidHexColor(hexDraft);
  const normalizedDraft = draftValid ? (hexDraft.startsWith("#") ? hexDraft : `#${hexDraft}`) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t.themeDialog.title}</DialogTitle>
          <DialogDescription>{t.themeDialog.description}</DialogDescription>
        </DialogHeader>

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
                  "flex flex-col items-center gap-1.5 rounded-lg border p-2 text-xs transition-colors hover:bg-accent",
                  active ? "border-primary bg-accent" : "border-transparent",
                )}
              >
                <span className="flex size-8 items-center justify-center rounded-full border" style={{ backgroundColor: preset.swatch }}>
                  {active ? <Check className="size-4 text-white drop-shadow" aria-hidden="true" /> : null}
                </span>
                <span className="text-muted-foreground">{t.themeDialog.presets[preset.id] ?? preset.label}</span>
              </button>
            );
          })}
        </div>

        <div className="space-y-2 border-t pt-4">
          <Label htmlFor="theme-custom-color">{t.themeDialog.customColorLabel}</Label>
          <div className="flex items-center gap-2">
            <input
              id="theme-custom-color"
              type="color"
              value={normalizedDraft ?? "#2f6fed"}
              onChange={(event) => setHexDraft(event.target.value)}
              className="h-10 w-12 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
              aria-label={t.themeDialog.pickCustomColor}
            />
            <Input
              value={hexDraft}
              onChange={(event) => setHexDraft(event.target.value)}
              maxLength={7}
              className="font-mono uppercase"
              aria-invalid={!draftValid}
              placeholder="#2F6FED"
            />
            <Button
              type="button"
              variant={colorThemeId === CUSTOM_THEME_COLOR_ID ? "default" : "outline"}
              disabled={!normalizedDraft}
              onClick={() => normalizedDraft && setCustomColor(normalizedDraft)}
            >
              {t.themeDialog.use}
            </Button>
          </div>
          {!draftValid ? <p className="text-xs text-destructive">{t.themeDialog.invalidFormat}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t.common.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
