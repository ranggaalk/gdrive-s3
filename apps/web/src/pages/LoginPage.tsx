import { HardDrive, Moon, ShieldCheck, Sun, Terminal } from "lucide-react";
import { Button, buttonVariants } from "@heroui/react";
import { ErrorAlert } from "@/components/feedback";
import { useLocale } from "@/components/locale-provider";
import { useTheme } from "@/components/theme-provider";
import type { Locale } from "@/lib/i18n/types";
import { cn } from "@/lib/utils";

const LOCALES: Array<{ id: Locale; short: string; full: string }> = [
  { id: "id", short: "ID", full: "Bahasa Indonesia" },
  { id: "en", short: "EN", full: "English" },
];

// Google's brand mark keeps its own colors, so it is drawn inline rather than
// pulled from lucide (which renders monochrome via currentColor).
function GoogleMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      // Inline size beats the button's own svg sizing rule without
      // depending on which class lands later in the generated stylesheet.
      style={{ width: "1.125rem", height: "1.125rem" }}
    >
      <path fill="#4285F4" d="M23.52 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3h3.87c2.26-2.09 3.58-5.17 3.58-8.87Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.94-2.91l-3.88-3c-1.08.72-2.45 1.16-4.06 1.16-3.13 0-5.78-2.11-6.73-4.96h-4v3.09A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29a7.2 7.2 0 0 1 0-4.58v-3.1h-4a12 12 0 0 0 0 10.78l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61l4 3.1C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  );
}

export function LoginPage() {
  const { t, locale, setLocale } = useLocale();
  const { resolvedTheme, setTheme } = useTheme();
  const loginError = new URLSearchParams(window.location.search).get("login_error");

  const features = [
    { icon: HardDrive, text: t.login.featureStorage },
    { icon: ShieldCheck, text: t.login.featureSecurity },
    { icon: Terminal, text: t.login.featureCompat },
  ];

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10">
      {/* Ambient wash: a soft accent bloom over a faint grid, kept well below
          the content so it reads as depth rather than decoration. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 size-[36rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/20 blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.04] dark:opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(currentColor 1px, transparent 1px), linear-gradient(90deg, currentColor 1px, transparent 1px)",
            backgroundSize: "56px 56px",
            maskImage: "radial-gradient(ellipse 60% 50% at 50% 40%, #000 40%, transparent 100%)",
            WebkitMaskImage: "radial-gradient(ellipse 60% 50% at 50% 40%, #000 40%, transparent 100%)",
          }}
        />
      </div>

      <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-full bg-default p-1">
          {LOCALES.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setLocale(option.id)}
              aria-label={t.login.switchLanguage(option.full)}
              aria-pressed={locale === option.id}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                locale === option.id
                  ? "bg-surface text-foreground shadow-xs"
                  : "text-muted hover:text-foreground",
              )}
            >
              {option.short}
            </button>
          ))}
        </div>
        <Button
          isIconOnly
          variant="ghost"
          className="rounded-full"
          aria-label={resolvedTheme === "dark" ? t.nav.lightMode : t.nav.darkMode}
          onPress={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        >
          {resolvedTheme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </div>

      <section className="relative w-full max-w-md">
        <div className="rounded-3xl bg-surface/80 p-8 shadow-overlay backdrop-blur-sm sm:p-10">
          <div className="flex flex-col items-center text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-linear-to-br from-accent to-accent/80 text-accent-foreground shadow-lg shadow-accent/25">
              <HardDrive className="size-7" aria-hidden="true" />
            </span>
            <h1 className="mt-5 text-2xl font-bold tracking-tight">{t.nav.appName}</h1>
            <p className="mt-1.5 text-sm font-medium text-accent">{t.login.tagline}</p>
            <p className="mt-3 text-sm leading-relaxed text-muted">{t.login.description}</p>
          </div>

          <ul className="mt-7 grid gap-3 border-y border-separator py-6">
            {features.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-sm">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-foreground">
                  <Icon className="size-3.5" aria-hidden="true" />
                </span>
                <span className="text-muted">{text}</span>
              </li>
            ))}
          </ul>

          <div className="mt-7 space-y-4">
            {loginError ? (
              <ErrorAlert title={t.login.loginFailedTitle} message={t.login.loginFailedMessage} />
            ) : null}
            <a
              href="/auth/google/start"
              className={buttonVariants({
                variant: "outline",
                size: "lg",
                fullWidth: true,
                className: "h-12 gap-3 bg-surface text-base font-semibold hover:bg-default",
              })}
            >
              <GoogleMark />
              {t.login.loginButton}
            </a>
            <p className="text-center text-xs leading-relaxed text-muted">
              {t.login.accessNote}
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
