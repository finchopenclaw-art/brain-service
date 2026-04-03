import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.BRAIN_KEY = 'test-brain-key';

vi.mock('../src/embeddings.js', () => ({ getEmbedding: vi.fn() }));
vi.mock('../src/metadata.js', () => ({ extractMetadata: vi.fn() }));
vi.mock('../src/thoughts.js', () => ({
  insertThought: vi.fn(),
  searchThoughts: vi.fn(),
  listThoughts: vi.fn(),
  getStats: vi.fn(),
}));

const { getEmbedding } = await import('../src/embeddings.js');
const { extractMetadata } = await import('../src/metadata.js');
const { insertThought, searchThoughts, listThoughts, getStats } = await import('../src/thoughts.js');
const { app } = await import('../src/app.js');

const AUTH = { 'x-brain-key': 'test-brain-key', 'Content-Type': 'application/json' };

describe('auth middleware', () => {
  it('returns 401 with no key', async () => {
    const res = await app.request('/api/thoughts');
    expect(res.status).toBe(401);
  });

  it('returns 401 with wrong key', async () => {
    const res = await app.request('/api/thoughts', { headers: { 'x-brain-key': 'wrong' } });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/thoughts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('captures a thought and returns 201 with metadata', async () => {
    vi.mocked(getEmbedding).mockResolvedValueOnce([0.1, 0.2]);
    vi.mocked(extractMetadata).mockResolvedValueOnce({
      type: 'observation', topics: ['test'], people: [], action_items: [], dates_mentioned: [],
    });
    vi.mocked(insertThought).mockResolvedValueOnce('uuid-123');

    const res = await app.request('/api/thoughts', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ content: 'test thought', source: 'finch' }),
    });

    expect(res.status).toBe(201);
    const json = await res.json() as Record<string, unknown>;
    expect(json.id).toBe('uuid-123');
    expect(json.captured).toBe(true);
    expect(json.topics).toEqual(['test']);
  });

  it('returns 400 when content is missing', async () => {
    const res = await app.request('/api/thoughts', {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/thoughts/search', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns semantic search results', async () => {
    vi.mocked(getEmbedding).mockResolvedValueOnce([0.1, 0.2]);
    vi.mocked(searchThoughts).mockResolvedValueOnce([{
      id: 'abc', content: 'relevant thought',
      metadata: { type: 'observation', topics: ['CIESC'] },
      source: 'mcp', created_at: '2026-04-03', similarity: 0.9,
    }]);

    const res = await app.request('/api/thoughts/search?q=CIESC+platform', {
      headers: { 'x-brain-key': 'test-brain-key' },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { results: Array<{ similarity: number }> };
    expect(json.results).toHaveLength(1);
    expect(json.results[0].similarity).toBe(0.9);
  });

  it('returns 400 without q param', async () => {
    const res = await app.request('/api/thoughts/search', {
      headers: { 'x-brain-key': 'test-brain-key' },
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/thoughts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists thoughts with total count', async () => {
    vi.mocked(listThoughts).mockResolvedValueOnce([{
      id: 'a', content: 'test', metadata: {}, source: 'mcp', created_at: '2026-04-03',
    }]);
    const res = await app.request('/api/thoughts', {
      headers: { 'x-brain-key': 'test-brain-key' },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { thoughts: unknown[]; total: number };
    expect(json.thoughts).toHaveLength(1);
    expect(json.total).toBe(1);
  });
});

describe('GET /api/thoughts/stats', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns aggregated stats', async () => {
    vi.mocked(getStats).mockResolvedValueOnce({
      total: 50, oldest: '2026-03-01', newest: '2026-04-03',
      types: { observation: 30 }, topics: { CIESC: 20 }, people: {},
    });
    const res = await app.request('/api/thoughts/stats', {
      headers: { 'x-brain-key': 'test-brain-key' },
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { total: number };
    expect(json.total).toBe(50);
  });
});
