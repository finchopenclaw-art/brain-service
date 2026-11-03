-- Card #271: department brains. Idempotent; scripts/new-brain.mjs applies it
-- before provisioning, so it never needs running by hand.
--
-- brain_admin.keys      one row per PERSON (hashed key → their department's
--                       schema), so one person is revoked without rotating
--                       the rest. Scott's original BRAIN_KEY is NOT here: it
--                       lives in .env and always means `brain`.
-- brain_admin.share_ledger  every thought copied from `brain` into a
--                       department brain, so nothing is sent twice and every
--                       copy can be traced back to its source.

CREATE SCHEMA IF NOT EXISTS brain_admin;

CREATE TABLE IF NOT EXISTS brain_admin.keys (
  key_hash     TEXT PRIMARY KEY,            -- sha256 hex of the key; the key itself is never stored
  schema_name  TEXT NOT NULL CHECK (schema_name ~ '^brain_[a-z][a-z0-9]{1,30}$'),
  person       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS keys_schema_person_idx ON brain_admin.keys (schema_name, person);

CREATE TABLE IF NOT EXISTS brain_admin.share_ledger (
  source_id     UUID NOT NULL,              -- brain.thoughts.id
  target_schema TEXT NOT NULL,
  target_id     UUID NOT NULL,
  shared_by     TEXT NOT NULL,
  shared_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, target_schema)
);
