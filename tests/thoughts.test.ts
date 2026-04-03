import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/db.js', () => ({
  pool: { query: vi.fn() },
}));

const { pool } = await import('../src/db.js');
const mockQuery = vi.mocked(pool.query);

const { insertThought, searchThoughts, listThoughts, getStats } = await import('../src/thoughts.js');

describe('insertThought', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts a thought and returns its id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'abc-123' }] } as never);
    const id = await insertThought('test content', [0.1, 0.2], { type: 'observation', topics: ['test'] }, 'mcp');
    expect(id).toBe('abc-123');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO brain.thoughts');
  });

  it('formats the embedding as a Postgres vector literal', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'x' }] } as never);
    await insertThought('c', [0.1, 0.2, 0.3], {}, 'mcp');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe('[0.1,0.2,0.3]');
  });
});

describe('searchThoughts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns results with similarity scores', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'abc', content: 'test', metadata: {}, source: 'mcp', created_at: '2026-04-03', similarity: 0.85 }],
    } as never);
    const results = await searchThoughts([0.1, 0.2], 5, 0.5);
    expect(results).toHaveLength(1);
    expect(results[0].similarity).toBe(0.85);
  });

  it('adds source filter to SQL when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await searchThoughts([0.1], 10, 0.5, 'finch');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('source = $');
  });
});

describe('listThoughts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('orders by created_at DESC', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await listThoughts({});
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY created_at DESC');
  });

  it('adds JSONB type filter when type provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await listThoughts({ type: 'task' });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('metadata @>');
  });

  it('adds days filter as interval when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never);
    await listThoughts({ days: 7 });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('created_at >=');
  });
});

describe('getStats', () => {
  beforeEach(() => vi.clearAllMocks());

  it('aggregates type, topic, and people counts from metadata', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: 2, oldest: '2026-03-01', newest: '2026-04-03' }] } as never)
      .mockResolvedValueOnce({
        rows: [
          { metadata: { type: 'observation', topics: ['CIESC'], people: [] } },
          { metadata: { type: 'task', topics: ['CIESC', 'SP8'], people: ['Scott'] } },
        ],
      } as never);
    const stats = await getStats();
    expect(stats.total).toBe(2);
    expect(stats.types.observation).toBe(1);
    expect(stats.types.task).toBe(1);
    expect(stats.topics['CIESC']).toBe(2);
    expect(stats.topics['SP8']).toBe(1);
    expect(stats.people['Scott']).toBe(1);
  });
});
