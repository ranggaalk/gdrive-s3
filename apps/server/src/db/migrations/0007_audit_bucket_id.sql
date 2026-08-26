-- bucket_name alone is only unique per-owner (UNIQUE(user_id, name) on
-- buckets), so it cannot safely key a cross-user traffic aggregation.
-- bucket_id lets per-bucket queries scope to the exact bucket.
ALTER TABLE audit_logs ADD COLUMN bucket_id TEXT REFERENCES buckets(id) ON DELETE SET NULL;

CREATE INDEX idx_audit_logs_bucket_time ON audit_logs(bucket_id, created_at DESC);
