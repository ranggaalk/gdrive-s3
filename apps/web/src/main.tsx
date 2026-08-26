import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import { ThemeProvider } from "@/components/theme-provider";
import { ColorThemeProvider } from "@/components/color-theme-provider";
import { LocaleProvider } from "@/components/locale-provider";
import { App } from "./App.tsx";
import "./index.css";

// Keep the current React 18 bootstrap stable during the design-system migration.
const container = document.getElementById("root");
if (!container) throw new Error("Root element #root not found");

createRoot(container).render(
  <ThemeProvider>
    <ColorThemeProvider>
      <LocaleProvider>
        <App />
      </LocaleProvider>
    </ColorThemeProvider>
  </ThemeProvider>,
);
