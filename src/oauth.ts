import { Hono } from 'hono';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { store } from './oauth-store.js';
import { ORG_SCHEMA, type BrainContext } from './context.js';

/**
 * Sign-in for the claude.ai connector (card #271, step 2).
 *
 * Everyone at CIESC is in one Claude Team account, and a key typed into a Team
 * connector is shared by all of them — so a key cannot keep the Co-op brain to
 * co-op staff. This is the MCP authorization flow instead (OAuth 2.1, public
 * clients, PKCE S256, dynamic client registration), with the actual sign-in
 * handed to the CIESC portal, which already signs staff in:
 *
 *   Claude ─/oauth/authorize→ brain ─302→ portal /brain-signin/<req>
 *     portal (staff session; signs in first if needed) ─302→ brain /oauth/callback?a=<signed pass>
 *   brain ─302→ Claude's redirect_uri?code=…   Claude ─/oauth/token→ brain → Bearer token
 *
 * The pass is HMAC-SHA256 over {req, email, exp} with BRAIN_SSO_SECRET, which
 * only the portal and this service hold. The email then decides the brain:
 * brain_admin.members → its department brain + the org reference; anyone else
 * reads the org reference only and cannot save.
 */

const BASE = () => (process.env.BRAIN_PUBLIC_URL ?? 'https://brain.srv839124.hstgr.cloud').replace(/\/$/, '');
const PORTAL = () => (process.env.BRAIN_PORTAL_URL ?? 'https://ciescportal.org').replace(/\/$/, '');
const STAFF_DOMAINS = () => (process.env.BRAIN_STAFF_DOMAINS ?? 'ciesc.org,indianaonline.org').split(',').map((d) => d.trim().toLowerCase());

const ACCESS_TTL = 60 * 60;            // 1 hour
const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days

const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const token = (prefix: string) => `${prefix}_${b64url(randomBytes(32))}`;

/** Where Claude may be sent back to: claude.ai / claude.com, or a local Claude Code listener. */
export function allowedRedirect(uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol === 'https:' && ['claude.ai', 'claude.com'].includes(u.hostname) && u.pathname === '/api/mcp/auth_callback' && !u.port) return true;
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname)) return true;
  return false;
}

export function signPass(secret: string, req: string, email: string, ttlSeconds = 120): string {
  const payload = b64url(Buffer.from(JSON.stringify({ req, email, exp: Math.floor(Date.now() / 1000) + ttlSeconds })));
  return `${payload}.${b64url(createHmac('sha256', secret).update(payload).digest())}`;
}

export function verifyPass(secret: string, pass: string): { req: string; email: string } | null {
  const [payload, sig] = pass.split('.');
  if (!payload || !sig) return null;
  const want = createHmac('sha256', secret).update(payload).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { req?: string; email?: string; exp?: number };
    if (!p.req || !p.email || !p.exp || p.exp < Date.now() / 1000) return null;
    return { req: p.req, email: p.email.toLowerCase() };
  } catch {
    return null;
  }
}

function isStaffEmail(email: string): boolean {
  const at = email.lastIndexOf('@');
  return at > 0 && STAFF_DOMAINS().includes(email.slice(at + 1));
}

/** Bearer token → the brain(s) that person may reach. */
export async function resolveBearer(raw: string): Promise<BrainContext | null> {
  if (!raw) return null;
  const t = await store.findToken(sha256(raw), 'access');
  if (!t) return null;
  const schema = await store.memberSchema(t.email);
  const org = await store.orgExists();
  const read = [...(schema ? [schema] : []), ...(org ? [ORG_SCHEMA] : [])];
  return { schema, person: t.email, read };
}

export const oauth = new Hono();

const resourceMetadata = () => ({
  resource: `${BASE()}/mcp`,
  authorization_servers: [BASE()],
  bearer_methods_supported: ['header'],
  resource_name: 'CIESC Brain',
});
// Clients look for it at the root and, per RFC 9728, under the resource path.
oauth.get('/.well-known/oauth-protected-resource', (c) => c.json(resourceMetadata()));
oauth.get('/.well-known/oauth-protected-resource/mcp', (c) => c.json(resourceMetadata()));

oauth.get('/.well-known/oauth-authorization-server', (c) => c.json({
  issuer: BASE(),
  authorization_endpoint: `${BASE()}/oauth/authorize`,
  token_endpoint: `${BASE()}/oauth/token`,
  registration_endpoint: `${BASE()}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
}));

oauth.post('/oauth/register', async (c) => {
  const body = await c.req.json().catch(() => null) as { redirect_uris?: unknown; client_name?: unknown } | null;
  const uris = Array.isArray(body?.redirect_uris) ? body!.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
  if (!uris.length || !uris.every(allowedRedirect)) {
    return c.json({ error: 'invalid_redirect_uri', error_description: 'Only Claude callback addresses are accepted.' }, 400);
  }
  const client = {
    client_id: `brainc_${b64url(randomBytes(16))}`,
    client_name: typeof body?.client_name === 'string' ? body.client_name.slice(0, 100) : null,
    redirect_uris: uris,
  };
  await store.addClient(client);
  return c.json({
    ...client,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    client_id_issued_at: Math.floor(Date.now() / 1000),
  }, 201);
});

oauth.get('/oauth/authorize', async (c) => {
  const q = c.req.query();
  const client = q.client_id ? await store.getClient(q.client_id) : null;
  // Never redirect to an address we have not checked: these errors are shown, not sent back.
  if (!client) return c.text('Unknown client. Remove the connector and add it again.', 400);
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) return c.text('Redirect address not registered for this client.', 400);
  const back = (error: string) => {
    const u = new URL(q.redirect_uri);
    u.searchParams.set('error', error);
    if (q.state) u.searchParams.set('state', q.state);
    return c.redirect(u.toString());
  };
  if (q.response_type !== 'code') return back('unsupported_response_type');
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request');
  const id = b64url(randomBytes(24));
  await store.addRequest({ id, client_id: client.client_id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, state: q.state ?? null });
  return c.redirect(`${PORTAL()}/brain-signin/${id}`);
});

oauth.get('/oauth/callback', async (c) => {
  const secret = process.env.BRAIN_SSO_SECRET;
  if (!secret) return c.text('Sign-in is not configured on this server.', 503);
  const pass = verifyPass(secret, c.req.query('a') ?? '');
  if (!pass) return c.text('This sign-in link is invalid or has expired. Start again from Claude.', 400);
  if (!isStaffEmail(pass.email)) return c.text('Only CIESC staff accounts can use the CIESC Brain.', 403);
  const req = await store.takeRequest(pass.req);
  if (!req) return c.text('This sign-in has expired. Start again from Claude.', 400);
  const code = token('bcode');
  await store.addCode(sha256(code), { client_id: req.client_id, redirect_uri: req.redirect_uri, code_challenge: req.code_challenge, email: pass.email });
  const u = new URL(req.redirect_uri);
  u.searchParams.set('code', code);
  if (req.state) u.searchParams.set('state', req.state);
  u.searchParams.set('iss', BASE());
  return c.redirect(u.toString());
});

async function issue(clientId: string, email: string) {
  const access = token('bat');
  const refresh = token('brt');
  await store.addToken(sha256(access), 'access', clientId, email, ACCESS_TTL);
  await store.addToken(sha256(refresh), 'refresh', clientId, email, REFRESH_TTL);
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token: refresh };
}

oauth.post('/oauth/token', async (c) => {
  const ct = c.req.header('content-type') ?? '';
  const f = (ct.includes('application/json') ? await c.req.json().catch(() => ({})) : await c.req.parseBody()) as Record<string, string>;
  const bad = (error: string, status: 400 | 401 = 400) => c.json({ error }, status);
  c.header('Cache-Control', 'no-store');

  if (f.grant_type === 'authorization_code') {
    if (!f.code || !f.code_verifier || !f.client_id) return bad('invalid_request');
    const row = await store.takeCode(sha256(f.code));
    if (!row || row.client_id !== f.client_id || (f.redirect_uri && f.redirect_uri !== row.redirect_uri)) return bad('invalid_grant');
    const challenge = b64url(createHash('sha256').update(f.code_verifier).digest());
    if (challenge !== row.code_challenge) return bad('invalid_grant');
    return c.json(await issue(row.client_id, row.email));
  }

  if (f.grant_type === 'refresh_token') {
    if (!f.refresh_token) return bad('invalid_request');
    const hash = sha256(f.refresh_token);
    const t = await store.findToken(hash, 'refresh');
    if (!t || (f.client_id && f.client_id !== t.client_id)) return bad('invalid_grant');
    await store.revokeToken(hash); // rotate: a refresh token works once
    return c.json(await issue(t.client_id, t.email));
  }

  return bad('unsupported_grant_type');
});

/** Sent with every 401 so Claude knows where to start signing in. */
export const wwwAuthenticate = () => `Bearer resource_metadata="${BASE()}/.well-known/oauth-protected-resource"`;
