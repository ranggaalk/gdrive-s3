-- TOTP-based 2FA. The secret is stored unconfirmed until the user proves
-- they scanned it correctly, so `users.totp_enabled` — the actual gate
-- checked at login — only flips on once verified.
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;

-- A session starts "pending" the instant Google OAuth succeeds for a user
-- with 2FA enabled; every other route treats a pending session as
-- unauthenticated until the code is verified and this flips to 0.
ALTER TABLE sessions ADD COLUMN mfa_pending INTEGER NOT NULL DEFAULT 0;

CREATE TABLE totp_secrets (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  encrypted_secret TEXT NOT NULL,
  confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE totp_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_totp_recovery_codes_user ON totp_recovery_codes(user_id, used_at);
