import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, Info, TriangleAlert, XCircle } from "lucide-react";
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider as ToastPrimitiveProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import { useLocale } from "@/components/locale-provider";

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. Errors stay longer by default. */
  duration?: number;
}

interface ToastEntry extends ToastOptions {
  id: number;
  variant: ToastVariant;
  open: boolean;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
  /** Convenience wrappers so call sites read as intent, not configuration. */
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  /** Turns a thrown value into an error toast using the caller's headline. */
  fromError: (title: string, cause: unknown) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS: Record<ToastVariant, typeof Info> = {
  success: CheckCircle2,
  error: XCircle,
  warning: TriangleAlert,
  info: Info,
};

// Errors linger, since they usually carry something the user must read.
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 8000,
};

const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    // Keep the entry mounted while Radix plays the close animation, then drop it.
    setEntries((current) => current.map((entry) => (entry.id === id ? { ...entry, open: false } : entry)));
    window.setTimeout(() => {
      setEntries((current) => current.filter((entry) => entry.id !== id));
    }, 300);
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = nextId.current++;
    const variant = options.variant ?? "info";
    setEntries((current) => [
      ...current.slice(-(MAX_VISIBLE - 1)),
      { ...options, id, variant, open: true },
    ]);
  }, []);

  const value = useMemo<ToastContextValue>(() => {
    const withVariant = (variant: ToastVariant) => (title: string, description?: string) =>
      toast({ title, description, variant });
    return {
      toast,
      success: withVariant("success"),
      error: withVariant("error"),
      info: withVariant("info"),
      warning: withVariant("warning"),
      fromError: (title, cause) =>
        toast({
          title,
          description: cause instanceof Error ? cause.message : String(cause),
          variant: "error",
        }),
    };
  }, [toast]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitiveProvider swipeDirection="right">
        {children}
        {entries.map((entry) => {
          const Icon = ICONS[entry.variant];
          return (
            <Toast
              key={entry.id}
              variant={entry.variant}
              open={entry.open}
              duration={entry.duration ?? DEFAULT_DURATION[entry.variant]}
              onOpenChange={(open) => { if (!open) dismiss(entry.id); }}
            >
              <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <ToastTitle>{entry.title}</ToastTitle>
                {entry.description ? (
                  <ToastDescription className="break-words">{entry.description}</ToastDescription>
                ) : null}
              </div>
              <ToastClose aria-label={t.common.close} />
            </Toast>
          );
        })}
        <ToastViewport />
      </ToastPrimitiveProvider>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast must be used inside ToastProvider");
  return value;
}
