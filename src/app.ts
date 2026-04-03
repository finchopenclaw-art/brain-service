import { Hono } from 'hono';
import { getEmbedding } from './embeddings.js';
import { extractMetadata } from './metadata.js';
import { insertThought, searchThoughts, listThoughts, getStats } from './thoughts.js';

const BRAIN_KEY = process.env.BRAIN_KEY!;

export const app = new Hono();

// Auth middleware — applies to all routes
app.use('*', async (c, next) => {
  const key = c.req.header('x-brain-key');
  if (!key || key !== BRAIN_KEY) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

// REST: POST /api/thoughts
app.post('/api/thoughts', async (c) => {
  const body = await c.req.json() as { content?: string; source?: string };
  if (!body.content) return c.json({ error: 'content is required' }, 400);
  const source = body.source ?? 'platform';
  const [embedding, metadata] = await Promise.all([
    getEmbedding(body.content),
    extractMetadata(body.content),
  ]);
  const id = await insertThought(body.content, embedding, { ...metadata, source }, source);
  return c.json({ id, type: metadata.type, topics: metadata.topics, captured: true }, 201);
});

// REST: GET /api/thoughts/search  (must be before /api/thoughts)
app.get('/api/thoughts/search', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'q is required' }, 400);
  const limit = parseInt(c.req.query('limit') ?? '10');
  const threshold = parseFloat(c.req.query('threshold') ?? '0.5');
  const source = c.req.query('source');
  const embedding = await getEmbedding(q);
  const results = await searchThoughts(embedding, limit, threshold, source);
  return c.json({ results });
});

// REST: GET /api/thoughts/stats  (must be before /api/thoughts)
app.get('/api/thoughts/stats', async (c) => {
  const stats = await getStats();
  return c.json(stats);
});

// REST: GET /api/thoughts
app.get('/api/thoughts', async (c) => {
  const limit = parseInt(c.req.query('limit') ?? '20');
  const source = c.req.query('source');
  const type = c.req.query('type');
  const topic = c.req.query('topic');
  const daysRaw = c.req.query('days');
  const days = daysRaw ? parseInt(daysRaw) : undefined;
  const thoughts = await listThoughts({ limit, source, type, topic, days });
  return c.json({ thoughts, total: thoughts.length });
});
