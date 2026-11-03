import { Hono } from 'hono';
import { getEmbedding } from './embeddings.js';
import { extractMetadata } from './metadata.js';
import { insertThought, searchThoughts, listThoughts, getStats } from './thoughts.js';
import { resolveKey } from './keys.js';
import { runWithBrain, currentBrain, captureMetadata } from './context.js';

if (!process.env.BRAIN_KEY) throw new Error('BRAIN_KEY environment variable is required');

export const app = new Hono();

// Auth middleware — applies to all routes. The key picks the brain (card #271):
// the original BRAIN_KEY is `brain`, a department key is its own `brain_<dept>`.
// `?key=` is accepted as well as the header because claude.ai custom connectors
// can only carry a key in the URL (the way Open Brain's connector works).
app.use('*', async (c, next) => {
  const key = c.req.header('x-brain-key') ?? c.req.query('key');
  const ctx = await resolveKey(key);
  if (!ctx) return c.json({ error: 'Unauthorized' }, 401);
  await runWithBrain(ctx, () => next());
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
  const [embedding, metadata] = await Promise.all([
    getEmbedding(body.content),
    extractMetadata(body.content),
  ]);
  const id = await insertThought(currentBrain().schema, body.content, embedding, captureMetadata(metadata, source), source);
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
  const results = await searchThoughts(currentBrain().read, embedding, limit, threshold, source);
  return c.json({ results });
});

// REST: GET /api/thoughts/stats  (must be before /api/thoughts)
app.get('/api/thoughts/stats', async (c) => {
  const stats = await getStats(currentBrain().read);
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
  const thoughts = await listThoughts(currentBrain().read, { limit, source, type, topic, days });
  return c.json({ thoughts, total: thoughts.length });
});
