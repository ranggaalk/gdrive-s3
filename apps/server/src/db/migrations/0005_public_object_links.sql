-- Revocable opaque public links. Tokens are never persisted in plaintext.

CREATE TABLE public_object_links (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES objects(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_accessed_at TEXT
);

CREATE INDEX idx_public_object_links_object
  ON public_object_links(object_id, created_at DESC);

CREATE INDEX idx_public_object_links_owner
  ON public_object_links(owner_user_id, created_at DESC);
