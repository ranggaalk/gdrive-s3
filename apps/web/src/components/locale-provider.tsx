import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { id } from "@/lib/i18n/id";
import { en } from "@/lib/i18n/en";
import type { Dictionary, Locale } from "@/lib/i18n/types";

const STORAGE_KEY = "drives3-locale";
const DICTIONARIES: Record<Locale, Dictionary> = { id, en };

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Dictionary;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function getStoredLocale(): Locale {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "id" || stored === "en" ? stored : "id";
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getStoredLocale);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      t: DICTIONARIES[locale],
      setLocale: (next) => {
        window.localStorage.setItem(STORAGE_KEY, next);
        setLocaleState(next);
      },
    }),
    [locale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  const value = useContext(LocaleContext);
  if (!value) throw new Error("useLocale must be used inside LocaleProvider");
  return value;
}
