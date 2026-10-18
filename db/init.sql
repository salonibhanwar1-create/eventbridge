CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  node_count INTEGER NOT NULL CHECK (node_count >= 0),
  truncated BOOLEAN NOT NULL,
  tree JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS snapshots_created_at_desc_idx
  ON snapshots (created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_events (
  id UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Received', 'Processing', 'Completed', 'Failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  failure_reason TEXT,
  processing_owner TEXT,
  processing_started_at TIMESTAMPTZ,
  processing_heartbeat_at TIMESTAMPTZ
);

ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processing_owner TEXT;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;
ALTER TABLE webhook_events ADD COLUMN IF NOT EXISTS processing_heartbeat_at TIMESTAMPTZ;
ALTER TABLE webhook_events DROP CONSTRAINT IF EXISTS webhook_events_status_check;
ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status_check
  CHECK (status IN ('Received', 'Processing', 'Completed', 'Failed'));

CREATE INDEX IF NOT EXISTS webhook_events_created_at_desc_idx
  ON webhook_events (created_at DESC);

CREATE INDEX IF NOT EXISTS webhook_events_status_idx
  ON webhook_events (status);

CREATE INDEX IF NOT EXISTS webhook_events_processing_lease_idx
  ON webhook_events (status, processing_heartbeat_at);
