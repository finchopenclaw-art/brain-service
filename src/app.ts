import { Hono } from 'hono';
import { getEmbedding } from './embeddings.js';
import { extractMetadata } from './metadata.js';
import { insertThought, searchThoughts, listThoughts, getStats } from './thoughts.js';

const BRAIN_KEY = process.env.BRAIN_KEY;
if (!BRAIN_KEY) throw new Error('BRAIN_KEY environment variable is required');

export const app = new Hono();

// Auth middleware — applies to all routes
app.use('*', async (c, next) => {
  const key = c.req.header('x-brain-key');
  if (!key || key !== BRAIN_KEY) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

// REST: POST /api/thoughts
app.post('/api/thoughts', async (c) => {
  const raw = await c.req.json();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }
  const body = raw as { content?: string; source?: string };
  if (!body.content) return c.json({ error: 'content is required' }, 400);
  const source = body.source ?? 'platform';
  console.log('[POST /api/thoughts] Starting embedding + metadata...');
  const [embedding, metadata] = await Promise.all([
    getEmbedding(body.content).then(r => { console.log('[POST] embedding done'); return r; }),
    extractMetadata(body.content).then(r => { console.log('[POST] metadata done'); return r; }),
  ]);
  console.log('[POST] Inserting thought...');
  const id = await insertThought(body.content, embedding, { ...metadata, source }, source);
  console.log('[POST] Done, id:', id);
  return c.json({ id, type: metadata.type, topics: metadata.topics, captured: true }, 201);
});

// REST: GET /api/thoughts/search  (must be before /api/thoughts)
app.get('/api/thoughts/search', async (c) => {
  const q = c.req.query('q');
  if (!q) return c.json({ error: 'q is required' }, 400);
  const limit = parseInt(c.req.query('limit') ?? '10');
  if (isNaN(limit) || limit < 1) return c.json({ error: 'limit must be a positive integer' }, 400);
  const threshold = parseFloat(c.req.query('threshold') ?? '0.5');
  if (isNaN(threshold) || threshold < 0 || threshold > 1) return c.json({ error: 'threshold must be between 0 and 1' }, 400);
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
  if (isNaN(limit) || limit < 1) return c.json({ error: 'limit must be a positive integer' }, 400);
  const source = c.req.query('source');
  const type = c.req.query('type');
  const topic = c.req.query('topic');
  const daysRaw = c.req.query('days');
  const daysNum = daysRaw ? parseInt(daysRaw) : undefined;
  if (daysNum !== undefined && (isNaN(daysNum) || daysNum < 1)) return c.json({ error: 'days must be a positive integer' }, 400);
  const days = daysNum;
  const thoughts = await listThoughts({ limit, source, type, topic, days });
  return c.json({ thoughts, total: thoughts.length });
});
