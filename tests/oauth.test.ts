import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// Card #271 step 2: sign-in through the portal. The whole flow, against an
// in-memory store: register → authorize → portal pass → token → which brain.

process.env.BRAIN_KEY = 'scott-key';
process.env.BRAIN_SSO_SECRET = 'test-sso-secret';
process.env.BRAIN_PUBLIC_URL = 'https://brain.test';
process.env.BRAIN_PORTAL_URL = 'https://portal.test';

const mem = {
  clients: new Map<string, any>(), requests: new Map<string, any>(), codes: new Map<string, any>(),
  tokens: new Map<string, any>(), members: new Map<string, string>([['koneil@ciesc.org', 'brain_coop']]),
};
vi.mock('../src/oauth-store.js', () => ({
  store: {
    addClient: async (c: any) => { mem.clients.set(c.client_id, c); },
    getClient: async (id: string) => mem.clients.get(id) ?? null,
    addRequest: async (p: any) => { mem.requests.set(p.id, { ...p, at: Date.now() }); },
    takeRequest: async (id: string) => { const r = mem.requests.get(id); mem.requests.delete(id); return r ?? null; },
    addCode: async (h: string, c: any) => { mem.codes.set(h, { ...c, used: false }); },
    takeCode: async (h: string) => { const c = mem.codes.get(h); if (!c || c.used) return null; c.used = true; return c; },
    addToken: async (h: string, kind: string, client_id: string, email: string) => { mem.tokens.set(h, { kind, client_id, email, revoked: false }); },
    findToken: async (h: string, kind: string) => { const t = mem.tokens.get(h); return t && t.kind === kind && !t.revoked ? t : null; },
    revokeToken: async (h: string) => { const t = mem.tokens.get(h); if (t) t.revoked = true; },
    memberSchema: async (e: string) => mem.members.get(e) ?? null,
    orgExists: async () => true,
  },
}));
vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      const m = sql.match(/"(brain[a-z0-9_]*)"\.thoughts/g) ?? [];
      if (sql.includes('INSERT')) return { rows: [{ id: 'new' }] };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 1, oldest: null, newest: null }] };
      return { rows: [{ id: 't', content: `read ${m.join('+')}`, metadata: { type: 'reference' }, source: 'org', created_at: '2026-11-04', similarity: 0.9 }] };
    }),
  },
}));
vi.mock('../src/embeddings.js', () => ({ getEmbedding: vi.fn(async () => [0.1]) }));
vi.mock('../src/metadata.js', () => ({ extractMetadata: vi.fn(async () => ({ type: 'observation', topics: [], people: [], action_items: [], dates_mentioned: [] })) }));

const { app } = await import('../src/app.js');
const { mountMcp } = await import('../src/mcp.js');
const { signPass, verifyPass, allowedRedirect } = await import('../src/oauth.js');
await mountMcp(app);

const CB = 'https://claude.ai/api/mcp/auth_callback';
const verifier = 'v'.repeat(50);
const challenge = createHash('sha256').update(verifier).digest('base64url');

async function register(uris = [CB]) {
  const r = await app.request('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: uris, client_name: 'Claude' }) });
  return { status: r.status, body: await r.json() as any };
}

/** Claude's side of the dance, with the portal stood in by signPass. */
async function signIn(email: string, opts: { verifier?: string } = {}) {
  const { body: client } = await register();
  const auth = await app.request(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(CB)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`);
  expect(auth.status).toBe(302);
  const portal = new URL(auth.headers.get('location')!);
  expect(portal.origin + portal.pathname.replace(/[^/]+$/, '')).toBe('https://portal.test/brain-signin/');
  const req = portal.pathname.split('/').pop()!;
  const cb = await app.request(`/oauth/callback?a=${signPass('test-sso-secret', req, email)}`);
  if (cb.status !== 302) return { cb };
  const back = new URL(cb.headers.get('location')!);
  expect(back.origin + back.pathname).toBe(CB);
  expect(back.searchParams.get('state')).toBe('xyz');
  const code = back.searchParams.get('code')!;
  const tok = await app.request('/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: opts.verifier ?? verifier, client_id: client.client_id, redirect_uri: CB }).toString(),
  });
  return { cb, tok, code, client, body: await tok.json() as any };
}

async function mcp(bearer: string, name: string, args: object) {
  const r = await app.request('/mcp', {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  return { status: r.status, text: await r.text() };
}

describe('discovery', () => {
  it('a 401 tells Claude where sign-in starts', async () => {
    const r = await app.request('/mcp', { method: 'POST' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata="https://brain.test/.well-known/oauth-protected-resource"');
  });
  it('publishes resource and server metadata without a key', async () => {
    const pr = await (await app.request('/.well-known/oauth-protected-resource')).json() as any;
    expect(pr.authorization_servers).toEqual(['https://brain.test']);
    const as = await (await app.request('/.well-known/oauth-authorization-server')).json() as any;
    expect(as.code_challenge_methods_supported).toEqual(['S256']);
    expect(as.registration_endpoint).toBe('https://brain.test/oauth/register');
  });
});

describe('registration', () => {
  it('accepts Claude callbacks and local Claude Code', () => {
    expect(allowedRedirect(CB)).toBe(true);
    expect(allowedRedirect('https://claude.com/api/mcp/auth_callback')).toBe(true);
    expect(allowedRedirect('http://localhost:53682/callback')).toBe(true);
  });
  it('refuses any other address', async () => {
    for (const bad of ['https://evil.example/cb', 'https://claude.ai.evil.example/api/mcp/auth_callback', 'http://claude.ai/api/mcp/auth_callback', 'javascript:alert(1)'])
      expect(allowedRedirect(bad)).toBe(false);
    expect((await register(['https://evil.example/cb'])).status).toBe(400);
  });
});

describe('the portal pass', () => {
  it('round-trips and rejects tampering, a wrong secret and expiry', () => {
    const p = signPass('s', 'req1', 'KONEIL@ciesc.org');
    expect(verifyPass('s', p)).toEqual({ req: 'req1', email: 'koneil@ciesc.org' });
    expect(verifyPass('other', p)).toBeNull();
    const [payload, sig] = p.split('.');
    const forged = Buffer.from(JSON.stringify({ req: 'req1', email: 'ktaylor@ciesc.org', exp: 9e9 })).toString('base64url');
    expect(verifyPass('s', `${forged}.${sig}`)).toBeNull();
    expect(verifyPass('s', signPass('s', 'r', 'a@ciesc.org', -5))).toBeNull();
    expect(verifyPass('s', payload)).toBeNull();
  });
});

describe('who reaches what', () => {
  beforeEach(() => mem.codes.clear());

  it('a co-op member reads the Co-op brain and the org reference, and can save', async () => {
    const { body } = await signIn('koneil@ciesc.org');
    expect(body.token_type).toBe('Bearer');
    const s = await mcp(body.access_token, 'list_thoughts', {});
    const read = s.text.match(/read ([^\n\\]*(?:\\"[^\n\\]*)*)/)![0];
    expect(read).toContain('brain_coop');
    expect(read).toContain('brain_org');
    expect(read).not.toMatch(/\\"brain\\"\.thoughts/);
    const save = await mcp(body.access_token, 'capture_thought', { content: 'note' });
    expect(save.text).toContain('Captured');
  });

  it('other staff read the org reference only and cannot save', async () => {
    const { body } = await signIn('pweller@ciesc.org');
    const s = await mcp(body.access_token, 'list_thoughts', {});
    expect(s.text).toContain('brain_org');
    expect(s.text).not.toContain('brain_coop');
    const save = await mcp(body.access_token, 'capture_thought', { content: 'note' });
    expect(save.text).toContain('no department brain');
  });

  it('a non-staff email is refused at the callback', async () => {
    const { cb } = await signIn('someone@gmail.com');
    expect(cb.status).toBe(403);
  });

  it('a wrong PKCE verifier gets no token', async () => {
    const { tok } = await signIn('koneil@ciesc.org', { verifier: 'w'.repeat(50) });
    expect(tok!.status).toBe(400);
  });

  it('a code works once', async () => {
    const { code, client } = await signIn('koneil@ciesc.org');
    const again = await app.request('/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: code!, code_verifier: verifier, client_id: client!.client_id }).toString(),
    });
    expect(again.status).toBe(400);
  });

  it('a pass for an already-used request is refused', async () => {
    const { body: client } = await register();
    const auth = await app.request(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(CB)}&code_challenge=${challenge}&code_challenge_method=S256`);
    const req = new URL(auth.headers.get('location')!).pathname.split('/').pop()!;
    const pass = signPass('test-sso-secret', req, 'koneil@ciesc.org');
    expect((await app.request(`/oauth/callback?a=${pass}`)).status).toBe(302);
    expect((await app.request(`/oauth/callback?a=${pass}`)).status).toBe(400);
  });

  it('authorize never redirects to an unregistered address', async () => {
    const { body: client } = await register();
    const r = await app.request(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=${challenge}&code_challenge_method=S256`);
    expect(r.status).toBe(400);
    expect(r.headers.get('location')).toBeNull();
  });

  it('refresh rotates: the old refresh token stops working', async () => {
    const { body } = await signIn('koneil@ciesc.org');
    const refresh = (rt: string) => app.request('/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt }).toString(),
    });
    const r1 = await refresh(body.refresh_token);
    expect(r1.status).toBe(200);
    expect((await r1.json() as any).access_token).toMatch(/^bat_/);
    expect((await refresh(body.refresh_token)).status).toBe(400);
  });

  it('a made-up bearer token is refused', async () => {
    expect((await mcp('bat_made_up', 'list_thoughts', {})).status).toBe(401);
  });

  it("keys still work alongside sign-in (Scott's key reads brain)", async () => {
    const r = await app.request('/api/thoughts', { headers: { 'x-brain-key': 'scott-key' } });
    expect(r.status).toBe(200);
  });
});
