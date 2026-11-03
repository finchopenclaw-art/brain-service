-- Card #271, step 2: sign-in for the claude.ai connector. Idempotent; applied by
-- `node scripts/new-brain.mjs migrate` (and by every new-brain.mjs command).
--
-- Everyone at CIESC is in ONE Claude Team account, so a key typed into a Team
-- connector is shared by every staff member. Sign-in makes access per person:
-- the connector sends the person to the portal (ciescportal.org/brain-signin),
-- the portal vouches for a CIESC staff email, and brain_admin.members decides
-- which department brain that email reaches. Staff who are not members read
-- the org reference only and cannot save.

CREATE SCHEMA IF NOT EXISTS brain_admin;

-- Which department brain an email reaches. One department per person.
CREATE TABLE IF NOT EXISTS brain_admin.members (
  email        TEXT PRIMARY KEY CHECK (email = lower(email)),
  schema_name  TEXT NOT NULL CHECK (schema_name ~ '^brain_[a-z][a-z0-9]{1,30}$' AND schema_name <> 'brain_org'),
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Clients registered by Claude (RFC 7591 dynamic registration). Public clients, PKCE only.
CREATE TABLE IF NOT EXISTS brain_admin.oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT,
  redirect_uris JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An /authorize waiting for the portal to vouch for the person (10 minutes).
CREATE TABLE IF NOT EXISTS brain_admin.oauth_requests (
  id             TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One-time authorization codes (2 minutes) and the tokens they become. Only hashes are stored.
CREATE TABLE IF NOT EXISTS brain_admin.oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  email          TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  used_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS brain_admin.oauth_tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id   TEXT NOT NULL,
  email       TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS oauth_tokens_email_idx ON brain_admin.oauth_tokens (email);
