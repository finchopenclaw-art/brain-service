#!/usr/bin/env node
// Nightly share between `brain` and a department brain (card #271). Runs ON THE VPS from /root/brain-service.
//
//   node scripts/share-nightly.mjs run --to coop                 share both ways, then DM Scott anything held back
//   node scripts/share-nightly.mjs pending-open-brain --to coop  JSON: department saves not yet in Open Brain
//   node scripts/share-nightly.mjs mark-open-brain --to coop --ids a,b
//
// Open Brain's key stays on the dev box, so scripts/brain-open-brain-mirror.mjs there uses the last two commands.
import 'dotenv/config';
import pg from 'pg';
import { schemaFor } from './lib/share.mjs';
import { runShare } from './lib/share-run.mjs';

const [, , cmd] = process.argv;
const flag = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const die = (m) => { console.error(m); process.exit(1); };
const dept = flag('to') ?? die('--to <dept> is required');
const schema = schemaFor(dept);
const SCOTT_SLACK = 'UFL0Z7H0S';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

/** Date and reason only: a held note's text is the reason it was held, so it never goes to Slack. */
async function reportHeld() {
  const r = await pool.query(
    `SELECT h.source_id, h.reason, t.created_at FROM brain_admin.share_held h LEFT JOIN brain.thoughts t ON t.id = h.source_id
      WHERE h.target_schema = $1 AND h.reported_at IS NULL ORDER BY t.created_at`, [schema]);
  if (!r.rows.length) return;
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { console.log(`${r.rows.length} held note(s) not reported: SLACK_BOT_TOKEN is not set.`); return; }
  const lines = r.rows.map((h) => `• ${h.created_at ? new Date(h.created_at).toISOString().slice(0, 10) : 'undated'}: ${h.reason} (${h.source_id})`);
  const text = `The nightly Brain share held back ${r.rows.length} note(s) from ${schema}. Nothing was copied. Reword and save again if it should go:\n${lines.join('\n')}`;
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel: SCOTT_SLACK, text, unfurl_links: false }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Slack refused the held-note report: ${body.error}`);
  await pool.query(`UPDATE brain_admin.share_held SET reported_at = NOW() WHERE target_schema = $1 AND reported_at IS NULL`, [schema]);
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await runShare(client, dept);
    await client.query('COMMIT');
    console.log(`[${new Date().toISOString()}] ${schema}: ${r.shared} shared, ${r.held} held back, ${r.inbound} saves copied to Brain.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await reportHeld();
}

async function pendingOpenBrain() {
  const r = await pool.query(
    `SELECT l.source_id AS id, b.content FROM brain_admin.share_ledger l
       JOIN "${schema}".thoughts d ON d.id = l.source_id
       JOIN brain.thoughts b ON b.id = l.target_id
      WHERE l.target_schema = 'brain'
        AND NOT EXISTS (SELECT 1 FROM brain_admin.share_ledger o WHERE o.source_id = l.source_id AND o.target_schema = 'open_brain')
      ORDER BY b.created_at`);
  console.log(JSON.stringify(r.rows));
}

async function markOpenBrain() {
  const ids = (flag('ids') ?? die('--ids is required')).split(',').filter(Boolean);
  // Open Brain does not hand back an id, so the row points at the note it mirrors.
  const r = await pool.query(
    `INSERT INTO brain_admin.share_ledger (source_id, target_schema, target_id, shared_by)
     SELECT id, 'open_brain', id, 'nightly' FROM unnest($1::uuid[]) AS id ON CONFLICT DO NOTHING`, [ids]);
  console.log(`${r.rowCount} marked.`);
}

const cmds = { run, 'pending-open-brain': pendingOpenBrain, 'mark-open-brain': markOpenBrain };
if (!cmds[cmd]) die('usage: share-nightly.mjs run|pending-open-brain|mark-open-brain --to <dept>');
try { await cmds[cmd](); } finally { await pool.end(); }
