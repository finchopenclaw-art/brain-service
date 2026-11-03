import { describe, it, expect, vi, beforeEach } from 'vitest';

// Card #271: a department key reaches only its own brain_<dept> schema, REST
// and MCP alike; the original BRAIN_KEY keeps reaching `brain`.

process.env.BRAIN_KEY = 'scott-key';

const keyRows: Record<string, { schema_name: string; person: string }> = {};
let orgExists = false;
vi.mock('../src/db.js', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('to_regclass')) return { rows: [{ ok: orgExists }] };
      if (sql.includes('brain_admin.keys')) {
        const row = keyRows[params[0] as string];
        return { rows: row ? [row] : [] };
      }
      // Any thoughts query: report which table it hit.
      const m = sql.match(/"(brain[a-z0-9_]*)"\.thoughts/);
      if (sql.startsWith('\n    SELECT') || sql.includes('<=>')) {
        const rows = [{ id: 't1', content: `from ${m?.[1]}`, metadata: { type: 'observation' }, source: 'mcp', created_at: '2026-11-03', similarity: 0.9 }];
        if (sql.includes('"brain_org".thoughts')) rows.push({ id: 't2', content: 'Kara reports to Kelly', metadata: { type: 'reference' }, source: 'org', created_at: '2026-11-03', similarity: 0.8 });
        return { rows };
      }
      if (sql.includes('INSERT')) return { rows: [{ id: `new-in-${m?.[1]}` }] };
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 1, oldest: null, newest: null }] };
      return { rows: [{ id: 't1', content: `from ${m?.[1]}`, metadata: { type: 'observation' }, source: 'mcp', created_at: '2026-11-03' }] };
    }),
  },
}));
vi.mock('../src/embeddings.js', () => ({ getEmbedding: vi.fn(async () => [0.1, 0.2]) }));
vi.mock('../src/metadata.js', () => ({
  extractMetadata: vi.fn(async () => ({ type: 'observation', topics: ['coop'], people: [], action_items: [], dates_mentioned: [] })),
}));

const { pool } = await import('../src/db.js');
const { hashKey, clearKeyCache } = await import('../src/keys.js');
const { app } = await import('../src/app.js');
const { mountMcp } = await import('../src/mcp.js');
await mountMcp(app);

keyRows[hashKey('kara-key')] = { schema_name: 'brain_coop', person: 'kara' };
keyRows[hashKey('evil-key')] = { schema_name: 'brain', person: 'evil' };
keyRows[hashKey('org-key')] = { schema_name: 'brain_org', person: 'sneaky' };
keyRows[hashKey('inject-key')] = { schema_name: 'brain_x"; DROP TABLE y; --', person: 'x' };

const sqlCalls = () => vi.mocked(pool.query).mock.calls.map((c) => c[0] as string).filter((s) => s.includes('.thoughts'));

async function mcpCall(key: string, name: string, args: Record<string, unknown>, viaQuery = false, id = 1) {
  const res = await app.request(viaQuery ? `/mcp?key=${key}` : '/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(viaQuery ? {} : { 'x-brain-key': key }),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  return { status: res.status, text: await res.text() };
}

describe('department keys over REST', () => {
  beforeEach(() => { vi.mocked(pool.query).mockClear(); clearKeyCache(); });

  it('the original key reads brain', async () => {
    const res = await app.request('/api/thoughts', { headers: { 'x-brain-key': 'scott-key' } });
    expect(res.status).toBe(200);
    expect(sqlCalls().every((s) => s.includes('"brain".thoughts'))).toBe(true);
    // The original key never consults brain_admin.
    expect(vi.mocked(pool.query).mock.calls.some((c) => String(c[0]).includes('brain_admin'))).toBe(false);
  });

  it('a department key reads only its own schema', async () => {
    const res = await app.request('/api/thoughts', { headers: { 'x-brain-key': 'kara-key' } });
    expect(res.status).toBe(200);
    const calls = sqlCalls();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((s) => s.includes('"brain_coop".thoughts'))).toBe(true);
  });

  it('accepts the key as ?key= for claude.ai connectors', async () => {
    const res = await app.request('/api/thoughts?key=kara-key');
    expect(res.status).toBe(200);
    expect(sqlCalls().every((s) => s.includes('"brain_coop".thoughts'))).toBe(true);
  });

  it('records who captured a thought with a department key', async () => {
    const res = await app.request('/api/thoughts', {
      method: 'POST', headers: { 'x-brain-key': 'kara-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'CDW files are gross of returns' }),
    });
    expect(res.status).toBe(201);
    const insert = vi.mocked(pool.query).mock.calls.find((c) => String(c[0]).includes('INSERT'))!;
    expect(insert[0]).toContain('"brain_coop".thoughts');
    expect(JSON.parse((insert[1] as string[])[2])).toMatchObject({ captured_by: 'kara', source: 'platform' });
  });

  it('a key row pointing at brain itself is refused', async () => {
    const res = await app.request('/api/thoughts', { headers: { 'x-brain-key': 'evil-key' } });
    expect(res.status).toBe(401);
    expect(sqlCalls()).toHaveLength(0);
  });

  it('a key row pointing at the org layer is refused (nobody writes brain_org)', async () => {
    const res = await app.request('/api/thoughts', { headers: { 'x-brain-key': 'org-key' } });
    expect(res.status).toBe(401);
    expect(sqlCalls()).toHaveLength(0);
  });

  it('a malformed schema name is refused', async () => {
    const res = await app.request('/api/thoughts', { headers: { 'x-brain-key': 'inject-key' } });
    expect(res.status).toBe(401);
    expect(sqlCalls()).toHaveLength(0);
  });

  it('an unknown key is refused', async () => {
    const res = await app.request('/api/thoughts?key=nope');
    expect(res.status).toBe(401);
  });
});

describe('department keys over MCP', () => {
  beforeEach(() => { vi.mocked(pool.query).mockClear(); clearKeyCache(); });

  it('search with a department key hits only brain_coop', async () => {
    const r = await mcpCall('kara-key', 'search_thoughts', { query: 'CDW' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('from brain_coop');
    expect(sqlCalls().every((s) => s.includes('"brain_coop".thoughts'))).toBe(true);
  });

  it('search with the original key hits brain', async () => {
    const r = await mcpCall('scott-key', 'search_thoughts', { query: 'CDW' });
    expect(r.text).toContain('from brain"');
  });

  it('capture via connector URL key lands in brain_coop with captured_by', async () => {
    const r = await mcpCall('kara-key', 'capture_thought', { content: 'Edge Public sends one workbook' }, true);
    expect(r.status).toBe(200);
    const insert = vi.mocked(pool.query).mock.calls.find((c) => String(c[0]).includes('INSERT'))!;
    expect(insert[0]).toContain('"brain_coop".thoughts');
    expect(JSON.parse((insert[1] as string[])[2])).toMatchObject({ captured_by: 'kara', source: 'mcp' });
  });

  it('two clients sending the same JSON-RPC id at once each get their own reply', async () => {
    const [a, b] = await Promise.all([
      mcpCall('kara-key', 'list_thoughts', {}, false, 1),
      mcpCall('scott-key', 'list_thoughts', {}, false, 1),
    ]);
    expect(a.text).toContain('from brain_coop');
    expect(b.text).toContain('from brain"');
    expect(b.text).not.toContain('brain_coop');
  });

  it('interleaved requests keep their own brains', async () => {
    const [a, b] = await Promise.all([
      mcpCall('kara-key', 'list_thoughts', {}, false, 101),
      mcpCall('scott-key', 'list_thoughts', {}, false, 102),
    ]);
    expect(a.text).toContain('from brain_coop');
    expect(b.text).not.toContain('brain_coop');
  });
});

describe('MCP handshake (stateless, per request)', () => {
  it('initialize then tools/list both answer, as Claude clients send them', async () => {
    const post = (body: object) => app.request('/mcp?key=kara-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    const init = await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect(init.status).toBe(200);
    expect(await init.text()).toContain('open-brain');
    const notif = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notif.status).toBe(202);
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const text = await list.text();
    for (const t of ['capture_thought', 'search_thoughts', 'list_thoughts', 'thought_stats']) expect(text).toContain(t);
  });
});

describe('the shared org reference (brain_org)', () => {
  beforeEach(() => { vi.mocked(pool.query).mockClear(); clearKeyCache(); orgExists = true; });

  it('a department key reads its own brain and brain_org together', async () => {
    const res = await app.request('/api/thoughts/search?q=org%20chart', { headers: { 'x-brain-key': 'kara-key' } });
    expect(res.status).toBe(200);
    const read = sqlCalls().find((s) => s.includes('<=>'))!;
    expect(read).toContain('"brain_coop".thoughts');
    expect(read).toContain('"brain_org".thoughts');
    expect(read).toContain('UNION ALL');
    expect(read).not.toMatch(/"brain"\.thoughts/);
  });

  it('captures still go only to the department brain', async () => {
    await app.request('/api/thoughts', {
      method: 'POST', headers: { 'x-brain-key': 'kara-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'note' }),
    });
    const insert = vi.mocked(pool.query).mock.calls.find((c) => String(c[0]).includes('INSERT'))!;
    expect(insert[0]).toContain('"brain_coop".thoughts');
    expect(insert[0]).not.toContain('brain_org');
  });

  it('MCP search marks org-reference results as such', async () => {
    const r = await mcpCall('kara-key', 'search_thoughts', { query: 'who does Kara report to' });
    expect(r.text).toContain('From: CIESC org reference');
    expect(r.text.match(/From: CIESC org reference/g)).toHaveLength(1);
  });

  it("Scott's key does not read brain_org", async () => {
    await app.request('/api/thoughts', { headers: { 'x-brain-key': 'scott-key' } });
    expect(sqlCalls().some((s) => s.includes('brain_org'))).toBe(false);
  });

  it('before brain_org exists a department key reads only its own brain', async () => {
    orgExists = false;
    await app.request('/api/thoughts', { headers: { 'x-brain-key': 'kara-key' } });
    expect(sqlCalls().some((s) => s.includes('brain_org'))).toBe(false);
  });
});
