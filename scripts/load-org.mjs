#!/usr/bin/env node
// Load the shared CIESC org reference into brain_org (card #271). Runs ON THE
// VPS from /root/brain-service (needs `npm run build` for dist/).
//
//   node scripts/load-org.mjs <org.json> [--dry-run]
//
// <org.json> is generated in ciesc-platform by scripts/brain-org-export.ts from
// the platform's own data (org chart, live glossary, service categories, fiscal
// year, member list): [{ "key": "...", "content": "...", "topics": [...], "people": [...] }].
//
// brain_org is GENERATED, not a memory: a load REPLACES its contents in one
// transaction, so a staff change never leaves an old copy behind. Every
// department key reads it; no key can write to it.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const [, , file] = process.argv;
const dry = process.argv.includes('--dry-run');
if (!file) { console.error('usage: load-org.mjs <org.json> [--dry-run]'); process.exit(1); }

const items = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(items) || !items.length) throw new Error('org.json must be a non-empty array');
const keys = new Set();
for (const it of items) {
  if (!it.key || !it.content || typeof it.content !== 'string') throw new Error(`Bad item: ${JSON.stringify(it).slice(0, 120)}`);
  if (keys.has(it.key)) throw new Error(`Duplicate key: ${it.key}`);
  keys.add(it.key);
}
console.log(`${items.length} org reference thought(s) in ${file}`);
if (dry) { for (const it of items) console.log(`- ${it.key}: ${it.content.slice(0, 100).replace(/\s+/g, ' ')}…`); process.exit(0); }

const { getEmbedding } = await import('../dist/embeddings.js');
// Embed everything BEFORE touching the table, so a provider failure leaves the old layer intact.
const embedded = [];
for (const it of items) embedded.push({ ...it, vec: `[${(await getEmbedding(it.content)).join(',')}]` });

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
const loadedAt = new Date().toISOString();
try {
  await client.query('BEGIN');
  await client.query('CREATE SCHEMA IF NOT EXISTS brain_org');
  await client.query('CREATE TABLE IF NOT EXISTS brain_org.thoughts (LIKE brain.thoughts INCLUDING ALL)');
  const before = await client.query('DELETE FROM brain_org.thoughts');
  for (const it of embedded) {
    const metadata = {
      type: 'reference', topics: it.topics ?? [], people: it.people ?? [], action_items: [], dates_mentioned: [],
      source: 'org', org_key: it.key, loaded_at: loadedAt,
    };
    await client.query(
      `INSERT INTO brain_org.thoughts (content, embedding, metadata, source) VALUES ($1, $2::vector, $3, 'org')`,
      [it.content, it.vec, JSON.stringify(metadata)],
    );
  }
  await client.query('COMMIT');
  console.log(`brain_org refreshed: ${before.rowCount} replaced with ${embedded.length}.`);
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  client.release();
  await pool.end();
}
