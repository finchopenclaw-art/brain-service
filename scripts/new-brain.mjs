#!/usr/bin/env node
// Department brains (card #271). Runs ON THE VPS from /root/brain-service, using
// its .env DATABASE_URL.
//
//   node scripts/new-brain.mjs create <dept>                  schema brain_<dept> (idempotent)
//   node scripts/new-brain.mjs key <dept> --person <name>     new key for one person; printed ONCE
//   node scripts/new-brain.mjs revoke <dept> --person <name>  revoke that person's key(s)
//   node scripts/new-brain.mjs list                           departments, people, counts
//   node scripts/new-brain.mjs member <dept> --email <addr>   sign-in access: this email reaches brain_<dept>
//   node scripts/new-brain.mjs unmember --email <addr>        back to the org reference only (signs them out)
//   node scripts/new-brain.mjs migrate                        apply migrations/ (idempotent)
//
// The key is shown once and only its sha256 is stored. Revocation takes effect
// within a minute (the service caches lookups for 60 s).
import 'dotenv/config';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { schemaFor } from './lib/share.mjs';

const PUBLIC_URL = process.env.BRAIN_PUBLIC_URL ?? 'https://brain.srv839124.hstgr.cloud';
const [, , cmd, dept] = process.argv;
const flag = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const die = (m) => { console.error(m); process.exit(1); };

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function ensureAdmin(client) {
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(readFileSync(dir + f, 'utf8'));
  }
}

async function migrate(client) {
  await ensureAdmin(client);
  console.log('Migrations applied.');
}

async function member(client) {
  const schema = schemaFor(dept);
  const email = (flag('email') ?? die('--email is required')).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) die(`Bad --email: ${email}`);
  await ensureAdmin(client);
  if (!(await schemaExists(client, schema))) die(`${schema} does not exist — run: create ${dept}`);
  await client.query(
    `INSERT INTO brain_admin.members (email, schema_name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET schema_name = EXCLUDED.schema_name, added_at = NOW()`, [email, schema]);
  console.log(`${email} → ${schema} (+ the org reference) when they sign in.`);
}

async function unmember(client) {
  const email = (flag('email') ?? die('--email is required')).toLowerCase();
  await ensureAdmin(client);
  const r = await client.query(`DELETE FROM brain_admin.members WHERE email = $1`, [email]);
  const t = await client.query(`UPDATE brain_admin.oauth_tokens SET revoked_at = NOW() WHERE email = $1 AND revoked_at IS NULL`, [email]);
  console.log(`${email}: ${r.rowCount ? 'removed from its department brain' : 'was not a member'}; ${t.rowCount} sign-in token(s) revoked.`);
}

async function schemaExists(client, schema) {
  const r = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'thoughts'`, [schema]);
  return r.rowCount > 0;
}

async function create(client) {
  const schema = schemaFor(dept);
  await ensureAdmin(client);
  if (await schemaExists(client, schema)) { console.log(`${schema} already exists — nothing to do.`); return; }
  // Same table as Scott's brain (columns, defaults, vector + GIN + date indexes).
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`CREATE TABLE "${schema}".thoughts (LIKE brain.thoughts INCLUDING ALL)`);
  console.log(`Created ${schema}.thoughts. Next: node scripts/new-brain.mjs key ${dept} --person <name>`);
}

async function key(client) {
  const schema = schemaFor(dept);
  const person = (flag('person') ?? die('--person is required')).toLowerCase();
  if (!/^[a-z][a-z0-9._-]{1,40}$/.test(person)) die(`Bad --person: ${person}`);
  await ensureAdmin(client);
  if (!(await schemaExists(client, schema))) die(`${schema} does not exist — run: create ${dept}`);
  const k = `bk_${dept}_${randomBytes(24).toString('base64url')}`;
  await client.query(
    `INSERT INTO brain_admin.keys (key_hash, schema_name, person) VALUES ($1, $2, $3)`,
    [createHash('sha256').update(k).digest('hex'), schema, person],
  );
  console.log(`Key for ${person} → ${schema} (shown once; only its hash is stored):\n`);
  console.log(`  Connector URL (claude.ai → Settings → Connectors → Add custom connector):`);
  console.log(`  ${PUBLIC_URL}/mcp?key=${k}\n`);
  console.log(`  Claude Code: claude mcp add --transport http brain-${dept} ${PUBLIC_URL}/mcp --header "x-brain-key: ${k}"`);
}

async function revoke(client) {
  const schema = schemaFor(dept);
  const person = (flag('person') ?? die('--person is required')).toLowerCase();
  const r = await client.query(
    `UPDATE brain_admin.keys SET revoked_at = NOW() WHERE schema_name = $1 AND person = $2 AND revoked_at IS NULL`,
    [schema, person],
  );
  console.log(`Revoked ${r.rowCount} key(s) for ${person} on ${schema} (live within 60 s).`);
}

async function list(client) {
  await ensureAdmin(client);
  const schemas = await client.query(
    `SELECT table_schema FROM information_schema.tables WHERE table_name = 'thoughts' AND table_schema LIKE 'brain\\_%' ORDER BY 1`,
  );
  for (const { table_schema: s } of schemas.rows) {
    const n = await client.query(`SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE source = 'shared')::int AS shared FROM "${s}".thoughts`);
    const people = await client.query(
      `SELECT person, created_at, revoked_at FROM brain_admin.keys WHERE schema_name = $1 ORDER BY created_at`, [s],
    );
    console.log(`${s}: ${n.rows[0].n} thoughts (${n.rows[0].shared} shared from brain)`);
    for (const p of people.rows) {
      console.log(`  key ${p.person}  issued ${p.created_at.toISOString().slice(0, 10)}${p.revoked_at ? `  REVOKED ${p.revoked_at.toISOString().slice(0, 10)}` : ''}`);
    }
    const members = await client.query(`SELECT email FROM brain_admin.members WHERE schema_name = $1 ORDER BY email`, [s]);
    for (const m of members.rows) console.log(`  sign-in ${m.email}`);
  }
}

const cmds = { create, key, revoke, list, member, unmember, migrate };
if (!cmds[cmd]) die('usage: new-brain.mjs create|key|revoke|member <dept> [--person name | --email addr] | unmember --email addr | list | migrate');
const client = await pool.connect();
try { await cmds[cmd](client); } finally { client.release(); await pool.end(); }
