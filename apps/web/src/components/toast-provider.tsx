import type { ReactNode } from "react";
import { Toast, toast as heroToast } from "@heroui/react";
import { errorText } from "../api/client.ts";

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  title: string;
  description?: string;
  variant?: ToastVariant;
  /** Milliseconds before auto-dismiss. Errors stay longer by default. */
  duration?: number;
}

interface ToastApi {
  toast: (options: ToastOptions) => void;
  /** Convenience wrappers so call sites read as intent, not configuration. */
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  /** Turns a thrown value into an error toast using the caller's headline. */
  fromError: (title: string, cause: unknown) => void;
}

const HERO_VARIANT = {
  success: "success",
  error: "danger",
  warning: "warning",
  info: "default",
} as const satisfies Record<ToastVariant, string>;

// Errors linger, since they usually carry something the user must read.
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 8000,
};

function show({ title, description, variant = "info", duration }: ToastOptions) {
  heroToast(title, {
    description,
    variant: HERO_VARIANT[variant],
    timeout: duration ?? DEFAULT_DURATION[variant],
  });
}

const withVariant = (variant: ToastVariant) => (title: string, description?: string) =>
  show({ title, description, variant });

// HeroUI keeps its toast queue outside React, so the API needs no context: it
// is the same object for every caller and safe to use in effects' deps.
const api: ToastApi = {
  toast: show,
  success: withVariant("success"),
  error: withVariant("error"),
  info: withVariant("info"),
  warning: withVariant("warning"),
  fromError: (title, cause) =>
    show({
      title,
      description: errorText(cause),
      variant: "error",
    }),
};

/** Mounts the region HeroUI renders queued toasts into. */
export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toast.Provider placement="bottom end" maxVisibleToasts={3} />
    </>
  );
}

export function useToast(): ToastApi {
  return api;
}
