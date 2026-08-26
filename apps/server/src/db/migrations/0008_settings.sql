-- Admin flag: gates access to runtime settings (e.g. Google OAuth client
-- credentials) that must not be editable by every logged-in user.
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- Runtime-editable overrides for boot-time env config. A row present here
-- takes precedence over the corresponding env var; absent means "use env".
-- Sensitive values (e.g. google_client_secret) are stored as an encrypted
-- envelope, never plaintext.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
