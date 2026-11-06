-- Card #271: notes the nightly share would not copy, so each is reported to Scott once.
-- Idempotent; applied by `node scripts/new-brain.mjs migrate`.
CREATE TABLE IF NOT EXISTS brain_admin.share_held (
  source_id     UUID NOT NULL,
  target_schema TEXT NOT NULL,
  reason        TEXT NOT NULL,
  held_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reported_at   TIMESTAMPTZ,
  PRIMARY KEY (source_id, target_schema)
);
