// Same-origin guard for browser control-plane mutations (AGENTS.md §20).
// Missing Origin remains allowed because non-browser clients (curl/admin
// scripts) are already protected by the session cookie + CSRF token. When a
// browser sends Origin, it must exactly match APP_ORIGIN.

import type { AppConfig } from "../config.ts";
import { requiresCsrf } from "./csrf.ts";

export function hasAllowedOrigin(req: Request, config: AppConfig): boolean {
  if (!requiresCsrf(req.method)) return true;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  return normalizeOrigin(origin) === normalizeOrigin(config.appOrigin);
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}
