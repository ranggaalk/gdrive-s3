// CSRF protection for the control plane (AGENTS.md §20).
// Double-submit style: the session holds a csrf_secret; state-changing /api
// requests must send it in the X-CSRF-Token header. Compared constant-time.

import { constantTimeEqual } from "./encryption.ts";

export const CSRF_HEADER = "x-csrf-token";

export function verifyCsrf(sessionSecret: string, headerValue: string | null): boolean {
  if (!headerValue) return false;
  return constantTimeEqual(sessionSecret, headerValue);
}

/** Whether a method mutates state and therefore requires a CSRF token. */
export function requiresCsrf(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}
