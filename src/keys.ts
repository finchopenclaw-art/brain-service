import { createHash, timingSafeEqual } from 'node:crypto';
import { pool } from './db.js';
import { SCHEMA_RE, type BrainContext } from './context.js';

/**
 * Key → brain. The original BRAIN_KEY (env) is Scott's brain and Finch's, and
 * never touches the database. Department keys (card #271) live hashed in
 * brain_admin.keys, one row per person, so one person can be revoked without
 * rotating the rest. Lookups are cached for a minute; a revoke takes effect
 * within that window.
 */

const CACHE_MS = 60_000;
const cache = new Map<string, { ctx: BrainContext | null; at: number }>();

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function sameKey(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function resolveKey(key: string | undefined | null): Promise<BrainContext | null> {
  if (!key) return null;
  const legacy = process.env.BRAIN_KEY;
  if (legacy && sameKey(key, legacy)) return { schema: 'brain', person: null };

  const hash = hashKey(key);
  const hit = cache.get(hash);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ctx;

  let ctx: BrainContext | null = null;
  try {
    const res = await pool.query(
      `SELECT schema_name, person FROM brain_admin.keys
        WHERE key_hash = $1 AND revoked_at IS NULL`,
      [hash],
    );
    const row = res.rows[0] as { schema_name: string; person: string } | undefined;
    // Never let a key row point at Scott's own brain, whatever the table says.
    if (row && SCHEMA_RE.test(row.schema_name) && row.schema_name !== 'brain') {
      ctx = { schema: row.schema_name, person: row.person };
    }
  } catch (err) {
    // brain_admin not created yet: only the original key works.
    if ((err as { code?: string }).code !== '42P01' && (err as { code?: string }).code !== '3F000') throw err;
  }
  // Wrong keys are cached too, so a flood of guesses is bounded.
  if (cache.size > 1000) cache.clear();
  cache.set(hash, { ctx, at: Date.now() });
  return ctx;
}

export function clearKeyCache(): void {
  cache.clear();
}
