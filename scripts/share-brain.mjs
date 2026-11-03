#!/usr/bin/env node
// Share thoughts from Scott's brain into a department brain (card #271).
// Runs ON THE VPS from /root/brain-service (needs `npm run build` for dist/).
// One-way, append-only, and nothing is copied without a reviewed file.
//
//   node scripts/share-brain.mjs candidates --to coop [--new] [--out review.md]
//       Searches `brain` with departments/<dept>.json (semantic queries + topics)
//       plus anything tagged [share:<dept>]; drops what is already shared and what
//       the exclusion rules hold back; writes a review file with every line [x].
//       --new: only thoughts captured since the last share to that department.
//   node scripts/share-brain.mjs copy --to coop --file review.md [--by scott]
//       Copies every line still marked [x]: same content, embedding and original
//       date, metadata.shared_from = {id, shared_at, shared_by}, source 'shared'.
//       Ledgered, so a second run copies nothing twice.
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { schemaFor, exclusionReason, renderReview, approvedIds } from './lib/share.mjs';

const [, , cmd] = process.argv;
const flag = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const has = (n) => process.argv.includes(`--${n}`);
const die = (m) => { console.error(m); process.exit(1); };

const dept = flag('to') ?? die('--to <dept> is required');
const schema = schemaFor(dept);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function candidates() {
  const cfg = JSON.parse(readFileSync(fileURLToPath(new URL(`../departments/${dept}.json`, import.meta.url)), 'utf8'));
  const { getEmbedding } = await import('../dist/embeddings.js');

  let since = null;
  if (has('new')) {
    const r = await pool.query(
      `SELECT MAX(t.created_at) AS since FROM brain_admin.share_ledger l JOIN brain.thoughts t ON t.id = l.source_id
        WHERE l.target_schema = $1`, [schema]);
    since = r.rows[0].since;
  }
  const sinceSql = (p) => (since ? ` AND t.created_at > $${p}` : '');
  const found = new Map();
  const add = (rows) => { for (const r of rows) if (!found.has(r.id)) found.set(r.id, r); };
  const notShared = `NOT EXISTS (SELECT 1 FROM brain_admin.share_ledger l WHERE l.source_id = t.id AND l.target_schema = '${schema}')`;

  for (const q of cfg.queries) {
    const vec = `[${(await getEmbedding(q)).join(',')}]`;
    const params = [vec, cfg.threshold ?? 0.45, cfg.per_query ?? 40];
    if (since) params.push(since);
    const r = await pool.query(
      `SELECT t.id, t.content, t.created_at FROM brain.thoughts t
        WHERE 1 - (t.embedding <=> $1::vector) >= $2 AND ${notShared}${sinceSql(4)}
        ORDER BY t.embedding <=> $1::vector LIMIT $3`, params);
    add(r.rows);
  }
  {
    const params = [cfg.topics ?? [], `%[share:${dept}]%`];
    if (since) params.push(since);
    const r = await pool.query(
      `SELECT t.id, t.content, t.created_at FROM brain.thoughts t
        WHERE (COALESCE(t.metadata->'topics', '[]'::jsonb) ?| $1::text[] OR t.content ILIKE $2)
          AND ${notShared}${sinceSql(3)}`, params);
    add(r.rows);
  }

  const held = {};
  const keep = [];
  for (const c of found.values()) {
    // A [share:<dept>] tag is Scott's explicit pick; it still passes the exclusions.
    const why = exclusionReason(c.content);
    if (why) held[why] = (held[why] ?? 0) + 1;
    else keep.push(c);
  }
  keep.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const out = flag('out') ?? `share-${dept}-${new Date().toISOString().slice(0, 10)}.md`;
  writeFileSync(out, renderReview(dept, keep));
  console.log(`${keep.length} candidate(s) → ${out}${since ? ` (captured after ${new Date(since).toISOString().slice(0, 10)})` : ''}`);
  const heldList = Object.entries(held).map(([k, v]) => `${k} ${v}`).join(', ');
  if (heldList) console.log(`Held back by the exclusion rules: ${heldList}`);
}

async function copy() {
  const file = flag('file') ?? die('--file <review.md> is required');
  const by = flag('by') ?? 'scott';
  const ids = approvedIds(readFileSync(file, 'utf8'));
  if (!ids.length) die('No [x] lines in the review file — nothing to copy.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const exists = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'thoughts'`, [schema]);
    if (!exists.rowCount) throw new Error(`${schema} does not exist — run new-brain.mjs create ${dept}`);
    const r = await client.query(
      `WITH src AS (
         SELECT t.* FROM brain.thoughts t
          WHERE t.id = ANY($1::uuid[])
            AND NOT EXISTS (SELECT 1 FROM brain_admin.share_ledger l WHERE l.source_id = t.id AND l.target_schema = $2)
       ), ins AS (
         INSERT INTO "${schema}".thoughts (content, embedding, metadata, source, created_at)
         SELECT content, embedding,
                metadata || jsonb_build_object('shared_from', jsonb_build_object('id', id, 'shared_at', NOW(), 'shared_by', $3::text)),
                'shared', created_at
           FROM src
         RETURNING id, (metadata->'shared_from'->>'id')::uuid AS source_id
       )
       INSERT INTO brain_admin.share_ledger (source_id, target_schema, target_id, shared_by)
       SELECT source_id, $2, id, $3 FROM ins
       RETURNING source_id`,
      [ids, schema, by]);
    await client.query('COMMIT');
    console.log(`Copied ${r.rowCount} of ${ids.length} approved thought(s) into ${schema}` +
      (r.rowCount < ids.length ? ` (${ids.length - r.rowCount} already shared or not found)` : '') + '.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

const cmds = { candidates, copy };
if (!cmds[cmd]) die('usage: share-brain.mjs candidates|copy --to <dept> …');
try { await cmds[cmd](); } finally { await pool.end(); }
