-- Migration 0003: multipart lifecycle indexes and metadata.

ALTER TABLE multipart_uploads ADD COLUMN drive_folder_id TEXT;
ALTER TABLE multipart_uploads ADD COLUMN total_parts INTEGER;
ALTER TABLE multipart_uploads ADD COLUMN last_error TEXT;

CREATE INDEX idx_multipart_uploads_expiry
  ON multipart_uploads(status, expires_at);

CREATE INDEX idx_multipart_uploads_user_time
  ON multipart_uploads(user_id, initiated_at);

-- PRIMARY KEY(upload_id, part_number) already gives the required parts index.
