ALTER TABLE sync_outbox ADD COLUMN lease_expires_at TEXT;
ALTER TABLE sync_outbox ADD COLUMN last_error_code TEXT;
CREATE INDEX sync_outbox_lease ON sync_outbox(status, lease_expires_at);
