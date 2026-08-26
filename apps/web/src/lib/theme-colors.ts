export type ColorSet = {
  primary: string;
  primaryForeground: string;
  ring: string;
  accent: string;
  accentForeground: string;
};

export type ThemeColorPreset = {
  id: string;
  label: string;
  swatch: string;
  light: ColorSet;
  dark: ColorSet;
};

export const DEFAULT_THEME_COLOR_ID = "default";
export const CUSTOM_THEME_COLOR_ID = "custom";

export const THEME_CSS_VARS = ["--primary", "--primary-foreground", "--ring", "--accent", "--accent-foreground"] as const;

// Kept identical to the un-themed values in index.css, so picking "Default"
// removes the inline overrides instead of duplicating a value that could drift.
export const THEME_COLOR_PRESETS: ThemeColorPreset[] = [
  {
    id: "default",
    label: "Biru",
    swatch: "#2f6fed",
    light: {
      primary: "217 91% 53%",
      primaryForeground: "210 40% 98%",
      ring: "217 91% 53%",
      accent: "212 100% 94%",
      accentForeground: "217 91% 36%",
    },
    dark: {
      primary: "0 0% 92%",
      primaryForeground: "0 0% 9%",
      ring: "0 0% 72%",
      accent: "0 0% 16%",
      accentForeground: "0 0% 96%",
    },
  },
  {
    id: "green",
    label: "Hijau",
    swatch: "#178a4c",
    light: {
      primary: "152 69% 31%",
      primaryForeground: "150 100% 97%",
      ring: "152 69% 31%",
      accent: "152 60% 94%",
      accentForeground: "152 69% 24%",
    },
    dark: {
      primary: "152 55% 55%",
      primaryForeground: "150 40% 8%",
      ring: "152 55% 55%",
      accent: "152 40% 16%",
      accentForeground: "150 70% 88%",
    },
  },
  {
    id: "violet",
    label: "Ungu",
    swatch: "#7c3aed",
    light: {
      primary: "262 83% 58%",
      primaryForeground: "270 100% 98%",
      ring: "262 83% 58%",
      accent: "262 90% 95%",
      accentForeground: "262 83% 40%",
    },
    dark: {
      primary: "263 85% 70%",
      primaryForeground: "270 40% 9%",
      ring: "263 85% 70%",
      accent: "262 40% 18%",
      accentForeground: "263 90% 88%",
    },
  },
  {
    id: "rose",
    label: "Merah muda",
    swatch: "#e11d55",
    light: {
      primary: "347 77% 50%",
      primaryForeground: "355 100% 97%",
      ring: "347 77% 50%",
      accent: "347 90% 95%",
      accentForeground: "347 77% 36%",
    },
    dark: {
      primary: "347 80% 68%",
      primaryForeground: "347 40% 9%",
      ring: "347 80% 68%",
      accent: "347 40% 18%",
      accentForeground: "347 90% 88%",
    },
  },
  {
    id: "orange",
    label: "Oranye",
    swatch: "#eb7a11",
    light: {
      primary: "24 95% 50%",
      primaryForeground: "24 100% 97%",
      ring: "24 95% 50%",
      accent: "24 95% 94%",
      accentForeground: "24 90% 34%",
    },
    dark: {
      primary: "24 90% 62%",
      primaryForeground: "24 40% 9%",
      ring: "24 90% 62%",
      accent: "24 40% 16%",
      accentForeground: "24 90% 86%",
    },
  },
  {
    id: "slate",
    label: "Netral",
    swatch: "#28344a",
    light: {
      primary: "222 47% 20%",
      primaryForeground: "210 40% 98%",
      ring: "222 47% 20%",
      accent: "214 32% 91%",
      accentForeground: "222 47% 20%",
    },
    dark: {
      primary: "210 20% 90%",
      primaryForeground: "222 47% 11%",
      ring: "210 20% 80%",
      accent: "215 20% 20%",
      accentForeground: "210 20% 94%",
    },
  },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cssHsl(h: number, s: number, l: number): string {
  return `${Math.round(h)} ${Math.round(clamp(s, 0, 100))}% ${Math.round(clamp(l, 0, 100))}%`;
}

export function isValidHexColor(value: string): boolean {
  return /^#?[0-9a-fA-F]{6}$/.test(value.trim());
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  const group = match?.[1];
  if (!group) return null;
  const int = parseInt(group, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
      case gn: h = (bn - rn) / d + 2; break;
      default: h = (rn - gn) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = L - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// WCAG relative luminance - picks readable text more reliably than raw HSL
// lightness, which misjudges blues as "dark" and yellows as "light".
function relativeLuminance(r: number, g: number, b: number): number {
  const toLinear = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function foregroundFor(h: number, s: number, l: number): string {
  const [r, g, b] = hslToRgb(h, s, l);
  return relativeLuminance(r, g, b) > 0.42 ? "222 47% 11%" : "210 40% 98%";
}

export function deriveCustomTheme(hex: string): { light: ColorSet; dark: ColorSet } | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const { h, s, l } = rgbToHsl(...rgb);
  const sat = clamp(s, 45, 90);

  const lightL = clamp(l, 38, 55);
  const lightAccentFg = clamp(lightL - 12, 20, 40);
  const light: ColorSet = {
    primary: cssHsl(h, sat, lightL),
    primaryForeground: foregroundFor(h, sat, lightL),
    ring: cssHsl(h, sat, lightL),
    accent: cssHsl(h, clamp(sat, 40, 70), 94),
    accentForeground: cssHsl(h, sat, lightAccentFg),
  };

  const darkL = clamp(lightL + (100 - lightL) * 0.35, 55, 72);
  const darkAccentFg = clamp(darkL + 15, 80, 92);
  const dark: ColorSet = {
    primary: cssHsl(h, sat, darkL),
    primaryForeground: foregroundFor(h, sat, darkL),
    ring: cssHsl(h, sat, darkL),
    accent: cssHsl(h, clamp(sat, 25, 55), 18),
    accentForeground: cssHsl(h, sat, darkAccentFg),
  };

  return { light, dark };
}

export function applyColorTheme(id: string, customHex: string | null, dark: boolean): void {
  const root = document.documentElement.style;

  if (id === "default") {
    for (const prop of THEME_CSS_VARS) root.removeProperty(prop);
    return;
  }

  const colors =
    id === CUSTOM_THEME_COLOR_ID && customHex
      ? deriveCustomTheme(customHex)?.[dark ? "dark" : "light"]
      : THEME_COLOR_PRESETS.find((preset) => preset.id === id)?.[dark ? "dark" : "light"];

  if (!colors) {
    for (const prop of THEME_CSS_VARS) root.removeProperty(prop);
    return;
  }

  root.setProperty("--primary", colors.primary);
  root.setProperty("--primary-foreground", colors.primaryForeground);
  root.setProperty("--ring", colors.ring);
  root.setProperty("--accent", colors.accent);
  root.setProperty("--accent-foreground", colors.accentForeground);
}
