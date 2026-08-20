// Structured JSON logging with mandatory redaction (AGENTS.md §19).
// Never log Authorization, Cookie, tokens, secret keys, presigned signatures,
// or encryption keys. Object keys may be sensitive: log a truncated form only.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const REDACT_KEYS = new Set(
  [
    "authorization",
    "cookie",
    "set-cookie",
    "refresh_token",
    "refreshtoken",
    "access_token",
    "accesstoken",
    "secret_access_key",
    "secretaccesskey",
    "secret",
    "encrypted_refresh_token",
    "encrypted_secret_key",
    "encryption_key",
    "master_encryption_key",
    "session_secret",
    "signature",
    "x-amz-signature",
    "x-amz-security-token",
    "password",
  ].map((k) => k.toLowerCase()),
);

const REDACTED = "[REDACTED]";

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEYS.has(k.toLowerCase())) {
      out[k] = REDACTED;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

/** Truncate an object key for logs; full keys only belong in the audit DB. */
export function truncateKey(key: string): string {
  if (key.length <= 24) return key;
  return `${key.slice(0, 21)}...`;
}

export interface LogFields {
  requestId?: string;
  route?: string;
  userId?: string;
  bucket?: string;
  status?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export class Logger {
  constructor(private readonly minLevel: LogLevel) {}

  private emit(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const record = {
      level,
      time: new Date().toISOString(),
      msg: message,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(record);
    if (level === "error" || level === "warn") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.emit("debug", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.emit("info", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.emit("warn", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.emit("error", message, fields);
  }

  /** Child logger that always includes the given base fields. */
  child(base: LogFields): Logger {
    const parent = this;
    const child = Object.create(parent) as Logger;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (child as any).emit = (level: LogLevel, message: string, fields?: LogFields) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (parent as any).emit(level, message, { ...base, ...fields });
    };
    return child;
  }
}

/** Generate a request id, e.g. req_01H.... */
export function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function createLogger(minLevel: LogLevel): Logger {
  return new Logger(minLevel);
}
