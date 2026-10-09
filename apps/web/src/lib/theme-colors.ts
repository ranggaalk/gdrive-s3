/** HSL triples ("217 91% 53%"), written into HeroUI's --accent pair. */
export type ColorSet = {
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

// HeroUI derives everything else from these two -- --focus defaults to
// var(--accent), and the hover/soft shades are color-mix()es of it -- so a
// preset only has to set the brand colour and the text drawn on it.
export const THEME_CSS_VARS = ["--accent", "--accent-foreground"] as const;

// "Default" is HeroUI's own accent: picking it removes the inline overrides
// rather than restating a value that could drift from @heroui/styles.
export const THEME_COLOR_PRESETS: ThemeColorPreset[] = [
  {
    id: "default",
    label: "Biru",
    swatch: "#0485f7",
    // Never applied -- "default" clears the overrides -- but kept equal to
    // HeroUI's accent (the same in both modes) so the preset list reads true.
    light: {
      accent: "208 97% 49%",
      accentForeground: "0 0% 99%",
    },
    dark: {
      accent: "208 97% 49%",
      accentForeground: "0 0% 99%",
    },
  },
  {
    id: "green",
    label: "Hijau",
    swatch: "#178a4c",
    light: {
      accent: "152 69% 31%",
      accentForeground: "150 100% 97%",
    },
    dark: {
      accent: "152 55% 55%",
      accentForeground: "150 40% 8%",
    },
  },
  {
    id: "violet",
    label: "Ungu",
    swatch: "#7c3aed",
    light: {
      accent: "262 83% 58%",
      accentForeground: "270 100% 98%",
    },
    dark: {
      accent: "263 85% 70%",
      accentForeground: "270 40% 9%",
    },
  },
  {
    id: "rose",
    label: "Merah muda",
    swatch: "#e11d55",
    light: {
      accent: "347 77% 50%",
      accentForeground: "355 100% 97%",
    },
    dark: {
      accent: "347 80% 68%",
      accentForeground: "347 40% 9%",
    },
  },
  {
    id: "orange",
    label: "Oranye",
    swatch: "#eb7a11",
    light: {
      accent: "24 95% 50%",
      accentForeground: "24 100% 97%",
    },
    dark: {
      accent: "24 90% 62%",
      accentForeground: "24 40% 9%",
    },
  },
  {
    id: "slate",
    label: "Netral",
    swatch: "#28344a",
    light: {
      accent: "222 47% 20%",
      accentForeground: "210 40% 98%",
    },
    dark: {
      accent: "210 20% 90%",
      accentForeground: "222 47% 11%",
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
  const light: ColorSet = {
    accent: cssHsl(h, sat, lightL),
    accentForeground: foregroundFor(h, sat, lightL),
  };

  const darkL = clamp(lightL + (100 - lightL) * 0.35, 55, 72);
  const dark: ColorSet = {
    accent: cssHsl(h, sat, darkL),
    accentForeground: foregroundFor(h, sat, darkL),
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

  root.setProperty("--accent", `hsl(${colors.accent})`);
  root.setProperty("--accent-foreground", `hsl(${colors.accentForeground})`);
}
