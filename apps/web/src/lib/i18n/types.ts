import type { id } from "./id.ts";

// The Indonesian dictionary is the source of truth for shape; every other
// locale (en.ts) must satisfy this exact type, so a missing/renamed key is
// a compile error instead of a silent runtime fallback.
export type Dictionary = typeof id;

export type Locale = "id" | "en";
