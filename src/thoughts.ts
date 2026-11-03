import { pool } from './db.js';
import { assertSchema } from './context.js';

/** Every function takes the brain's schema first; it is validated, then quoted. */
const T = (schema: string) => `"${assertSchema(schema)}".thoughts`;

export interface ThoughtRow {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  source: string;
  created_at: string;
}

export interface SearchResult extends ThoughtRow {
  similarity: number;
}

export interface ListFilters {
  limit?: number;
  type?: string;
  topic?: string;
  person?: string;
  days?: number;
  source?: string;
}

export interface Stats {
  total: number;
  oldest: string | null;
  newest: string | null;
  types: Record<string, number>;
  topics: Record<string, number>;
  people: Record<string, number>;
}

export async function insertThought(
  schema: string,
  content: string,
  embedding: number[],
  metadata: Record<string, unknown>,
  source: string
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO ${T(schema)} (content, embedding, metadata, source)
     VALUES ($1, $2::vector, $3, $4)
     RETURNING id`,
    [content, `[${embedding.join(',')}]`, JSON.stringify(metadata), source]
  );
  return result.rows[0].id as string;
}

export async function searchThoughts(
  schema: string,
  queryEmbedding: number[],
  limit = 10,
  threshold = 0.5,
  source?: string
): Promise<SearchResult[]> {
  const vec = `[${queryEmbedding.join(',')}]`;
  const params: unknown[] = [vec, limit, threshold];
  let sql = `
    SELECT id, content, metadata, source, created_at,
           1 - (embedding <=> $1::vector) AS similarity
    FROM ${T(schema)}
    WHERE 1 - (embedding <=> $1::vector) >= $3`;
  if (source) {
    params.push(source);
    sql += ` AND source = $${params.length}`;
  }
  sql += ` ORDER BY embedding <=> $1::vector LIMIT $2`;
  const result = await pool.query(sql, params);
  return result.rows as SearchResult[];
}

export async function listThoughts(schema: string, filters: ListFilters): Promise<ThoughtRow[]> {
  const { limit = 20, type, topic, person, days, source } = filters;
  const params: unknown[] = [limit];
  let sql = `SELECT id, content, metadata, source, created_at FROM ${T(schema)} WHERE 1=1`;
  if (type) {
    params.push(JSON.stringify({ type }));
    sql += ` AND metadata @> $${params.length}::jsonb`;
  }
  if (topic) {
    params.push(JSON.stringify({ topics: [topic] }));
    sql += ` AND metadata @> $${params.length}::jsonb`;
  }
  if (person) {
    params.push(JSON.stringify({ people: [person] }));
    sql += ` AND metadata @> $${params.length}::jsonb`;
  }
  if (days) {
    params.push(days);
    sql += ` AND created_at >= NOW() - ($${params.length} || ' days')::interval`;
  }
  if (source) {
    params.push(source);
    sql += ` AND source = $${params.length}`;
  }
  sql += ` ORDER BY created_at DESC LIMIT $1`;
  const result = await pool.query(sql, params);
  return result.rows as ThoughtRow[];
}

export async function getStats(schema: string): Promise<Stats> {
  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total, MIN(created_at) AS oldest, MAX(created_at) AS newest FROM ${T(schema)}`
  );
  const metaRes = await pool.query(`SELECT metadata FROM ${T(schema)}`);
  const types: Record<string, number> = {};
  const topics: Record<string, number> = {};
  const people: Record<string, number> = {};
  for (const row of metaRes.rows) {
    const m = row.metadata as Record<string, unknown>;
    if (m.type) types[m.type as string] = (types[m.type as string] || 0) + 1;
    if (Array.isArray(m.topics))
      for (const t of m.topics as string[]) topics[t] = (topics[t] || 0) + 1;
    if (Array.isArray(m.people))
      for (const p of m.people as string[]) people[p] = (people[p] || 0) + 1;
  }
  return { ...countRes.rows[0], types, topics, people };
}
