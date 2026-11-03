import { pool } from './db.js';

// Storage for sign-in (card #271). Kept apart from the routes so tests can swap
// it for an in-memory fake. Secrets (codes, tokens) arrive here already hashed.

export interface OAuthClient { client_id: string; client_name: string | null; redirect_uris: string[] }
export interface PendingRequest { id: string; client_id: string; redirect_uri: string; code_challenge: string; state: string | null }
export interface CodeRow { client_id: string; redirect_uri: string; code_challenge: string; email: string }

export const store = {
  async addClient(c: OAuthClient): Promise<void> {
    await pool.query(
      `INSERT INTO brain_admin.oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)`,
      [c.client_id, c.client_name, JSON.stringify(c.redirect_uris)],
    );
  },
  async getClient(id: string): Promise<OAuthClient | null> {
    const r = await pool.query(`SELECT client_id, client_name, redirect_uris FROM brain_admin.oauth_clients WHERE client_id = $1`, [id]);
    return (r.rows[0] as OAuthClient) ?? null;
  },
  async addRequest(p: PendingRequest): Promise<void> {
    await pool.query(`DELETE FROM brain_admin.oauth_requests WHERE created_at < NOW() - interval '1 day'`);
    await pool.query(
      `INSERT INTO brain_admin.oauth_requests (id, client_id, redirect_uri, code_challenge, state) VALUES ($1, $2, $3, $4, $5)`,
      [p.id, p.client_id, p.redirect_uri, p.code_challenge, p.state],
    );
  },
  /** The request, if under 10 minutes old; it is consumed either way. */
  async takeRequest(id: string): Promise<PendingRequest | null> {
    const r = await pool.query(
      `DELETE FROM brain_admin.oauth_requests WHERE id = $1
       RETURNING id, client_id, redirect_uri, code_challenge, state, created_at > NOW() - interval '10 minutes' AS fresh`,
      [id],
    );
    const row = r.rows[0] as (PendingRequest & { fresh: boolean }) | undefined;
    return row?.fresh ? row : null;
  },
  async addCode(hash: string, c: CodeRow): Promise<void> {
    await pool.query(
      `INSERT INTO brain_admin.oauth_codes (code_hash, client_id, redirect_uri, code_challenge, email, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + interval '2 minutes')`,
      [hash, c.client_id, c.redirect_uri, c.code_challenge, c.email],
    );
  },
  /** A code works once, for two minutes. */
  async takeCode(hash: string): Promise<CodeRow | null> {
    const r = await pool.query(
      `UPDATE brain_admin.oauth_codes SET used_at = NOW()
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING client_id, redirect_uri, code_challenge, email`,
      [hash],
    );
    return (r.rows[0] as CodeRow) ?? null;
  },
  async addToken(hash: string, kind: 'access' | 'refresh', clientId: string, email: string, ttlSeconds: number): Promise<void> {
    await pool.query(
      `INSERT INTO brain_admin.oauth_tokens (token_hash, kind, client_id, email, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)`,
      [hash, kind, clientId, email, String(ttlSeconds)],
    );
  },
  async findToken(hash: string, kind: 'access' | 'refresh'): Promise<{ email: string; client_id: string } | null> {
    const r = await pool.query(
      `SELECT email, client_id FROM brain_admin.oauth_tokens
        WHERE token_hash = $1 AND kind = $2 AND revoked_at IS NULL AND expires_at > NOW()`,
      [hash, kind],
    );
    return (r.rows[0] as { email: string; client_id: string }) ?? null;
  },
  async revokeToken(hash: string): Promise<void> {
    await pool.query(`UPDATE brain_admin.oauth_tokens SET revoked_at = NOW() WHERE token_hash = $1`, [hash]);
  },
  async memberSchema(email: string): Promise<string | null> {
    const r = await pool.query(`SELECT schema_name FROM brain_admin.members WHERE email = $1`, [email]);
    return (r.rows[0]?.schema_name as string) ?? null;
  },
  async orgExists(): Promise<boolean> {
    const r = await pool.query(`SELECT to_regclass('brain_org.thoughts') IS NOT NULL AS ok`);
    return !!r.rows[0]?.ok;
  },
};
