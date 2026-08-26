import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTheme } from "@/components/theme-provider";
import { applyColorTheme, CUSTOM_THEME_COLOR_ID, DEFAULT_THEME_COLOR_ID } from "@/lib/theme-colors";

const STORAGE_KEY = "drives3-theme-color";
const CUSTOM_STORAGE_KEY = "drives3-theme-color-custom";

type ColorThemeContextValue = {
  colorThemeId: string;
  customHex: string | null;
  setPreset: (id: string) => void;
  setCustomColor: (hex: string) => void;
};

const ColorThemeContext = createContext<ColorThemeContextValue | null>(null);

export function ColorThemeProvider({ children }: { children: ReactNode }) {
  const { resolvedTheme } = useTheme();
  const [colorThemeId, setColorThemeId] = useState(
    () => window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_THEME_COLOR_ID,
  );
  const [customHex, setCustomHex] = useState<string | null>(
    () => window.localStorage.getItem(CUSTOM_STORAGE_KEY),
  );

  useEffect(() => {
    applyColorTheme(colorThemeId, customHex, resolvedTheme === "dark");
  }, [colorThemeId, customHex, resolvedTheme]);

  const value = useMemo<ColorThemeContextValue>(
    () => ({
      colorThemeId,
      customHex,
      setPreset: (id) => {
        window.localStorage.setItem(STORAGE_KEY, id);
        setColorThemeId(id);
      },
      setCustomColor: (hex) => {
        window.localStorage.setItem(STORAGE_KEY, CUSTOM_THEME_COLOR_ID);
        window.localStorage.setItem(CUSTOM_STORAGE_KEY, hex);
        setColorThemeId(CUSTOM_THEME_COLOR_ID);
        setCustomHex(hex);
      },
    }),
    [colorThemeId, customHex],
  );

  return <ColorThemeContext.Provider value={value}>{children}</ColorThemeContext.Provider>;
}

export function useColorTheme() {
  const value = useContext(ColorThemeContext);
  if (!value) throw new Error("useColorTheme must be used inside ColorThemeProvider");
  return value;
}
