// The nightly share between Scott's brain and a department brain (card #271, rule agreed 2026-11-05).
// Takes a pg client so the caller owns the transaction: scripts/share-nightly.mjs commits it, a test rolls it back.
//
//   out: a note in `brain` opened by [share:<dept>], through the exclusion rules, into the department brain.
//   in:  what a department member saved (not Scott, not seeded notes), into `brain`, labeled with who saved it.
import { schemaFor, exclusionReason, taggedBody, departmentNote } from './share.mjs';

/** Scott saves into the department brain too; his own notes already live with him. */
const OWNER = 'scox@ciesc.org';

export async function runShare(client, dept, { owner = OWNER, by = 'nightly' } = {}) {
  const schema = schemaFor(dept);
  const result = { shared: 0, held: 0, inbound: 0 };

  const tagged = await client.query(
    `SELECT t.id, t.content FROM brain.thoughts t
      WHERE t.content ~* $1
        AND NOT EXISTS (SELECT 1 FROM brain_admin.share_ledger l WHERE l.source_id = t.id AND l.target_schema = $2)
        AND NOT EXISTS (SELECT 1 FROM brain_admin.share_held h WHERE h.source_id = t.id AND h.target_schema = $2)`,
    [`^\\s*\\[share:${dept}\\]`, schema]);
  for (const t of tagged.rows) {
    const body = taggedBody(t.content, dept);
    if (!body) continue;
    const why = exclusionReason(body);
    if (why) {
      await client.query(`INSERT INTO brain_admin.share_held (source_id, target_schema, reason) VALUES ($1, $2, $3)`, [t.id, schema, why]);
      result.held++;
      continue;
    }
    const ins = await client.query(
      `INSERT INTO "${schema}".thoughts (content, embedding, metadata, source, created_at)
       SELECT $1, embedding, metadata || jsonb_build_object('shared_from', jsonb_build_object('id', id, 'shared_at', NOW(), 'shared_by', $2::text)), 'shared', created_at
         FROM brain.thoughts WHERE id = $3 RETURNING id`, [body, by, t.id]);
    await client.query(`INSERT INTO brain_admin.share_ledger (source_id, target_schema, target_id, shared_by) VALUES ($1, $2, $3, $4)`, [t.id, schema, ins.rows[0].id, by]);
    result.shared++;
  }

  const saved = await client.query(
    `SELECT t.id, t.content, t.created_at, t.metadata->>'captured_by' AS who FROM "${schema}".thoughts t
      WHERE t.source = 'mcp' AND t.metadata->>'captured_by' IS NOT NULL AND t.metadata->>'captured_by' <> $1
        AND NOT EXISTS (SELECT 1 FROM brain_admin.share_ledger l WHERE l.source_id = t.id AND l.target_schema = 'brain')
      ORDER BY t.created_at`, [owner]);
  for (const t of saved.rows) {
    const ins = await client.query(
      `INSERT INTO brain.thoughts (content, embedding, metadata, source, created_at)
       SELECT $1, embedding, metadata || jsonb_build_object('department', $2::text, 'shared_from', jsonb_build_object('id', id, 'shared_at', NOW(), 'shared_by', $3::text)), 'department', created_at
         FROM "${schema}".thoughts WHERE id = $4 RETURNING id`,
      [departmentNote(t.content, t.who, t.created_at, dept), dept, by, t.id]);
    await client.query(`INSERT INTO brain_admin.share_ledger (source_id, target_schema, target_id, shared_by) VALUES ($1, 'brain', $2, $3)`, [t.id, ins.rows[0].id, by]);
    result.inbound++;
  }
  return result;
}
