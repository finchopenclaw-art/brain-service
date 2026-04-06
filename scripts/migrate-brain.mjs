import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const SUPABASE_URL = 'https://ycklbmfqxndqrgwyrrch.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SUPABASE_SERVICE_ROLE_KEY || !OPENROUTER_API_KEY || !DATABASE_URL) {
  console.error('Required env vars: SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY, DATABASE_URL');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function getEmbedding(text) {
  const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: text }),
  });
  if (!res.ok) throw new Error(`Embedding API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.data[0].embedding;
}

const INCLUDE_TOPICS = [
  'CIESC Platform', 'CIESC Dashboard', 'Dashboard',
  'Data Modernization', 'Data Management', 'Open Brain',
];
const INCLUDE_KEYWORDS = [
  'SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP6', 'SP7', 'SP8', 'SP9',
  'Finch', 'ingestion', 'SvelteKit', 'ciesc-platform',
];
const INCLUDE_AFTER = new Date('2026-03-30');

console.log('Fetching thoughts from Supabase...');
const { data: allThoughts, error } = await supabase
  .from('thoughts')
  .select('id, content, metadata, created_at')
  .order('created_at', { ascending: true });

if (error) { console.error('Supabase query failed:', error.message); process.exit(1); }
console.log(`Total thoughts in Supabase: ${allThoughts.length}`);

const relevant = allThoughts.filter(t => {
  const m = t.metadata ?? {};
  const topics = Array.isArray(m.topics) ? m.topics : [];
  const afterDate = new Date(t.created_at) >= INCLUDE_AFTER;
  const topicMatch = topics.some(topic =>
    INCLUDE_TOPICS.some(inc => String(topic).includes(inc))
  );
  const keywordMatch = INCLUDE_KEYWORDS.some(kw => t.content.includes(kw));
  return afterDate || topicMatch || keywordMatch;
});

console.log(`Migrating ${relevant.length} of ${allThoughts.length} relevant thoughts...\n`);

let migrated = 0;
let skipped = 0;
let failed = 0;

for (const thought of relevant) {
  try {
    // Check if already migrated (by content match)
    const exists = await pool.query(
      'SELECT id FROM brain.thoughts WHERE content = $1 LIMIT 1',
      [thought.content]
    );
    if (exists.rows.length > 0) { skipped++; continue; }

    // Re-embed via OpenRouter
    const embedding = await getEmbedding(thought.content);
    const vec = `[${embedding.join(',')}]`;

    // Insert preserving original timestamps
    await pool.query(
      `INSERT INTO brain.thoughts (content, embedding, metadata, source, created_at)
       VALUES ($1, $2::vector, $3, 'migration', $4)`,
      [
        thought.content,
        vec,
        JSON.stringify({ ...thought.metadata, source: 'migration' }),
        thought.created_at,
      ]
    );

    migrated++;
    if (migrated % 10 === 0) console.log(`  ${migrated}/${relevant.length} migrated...`);

    // 150ms pause — stays within OpenRouter rate limits
    await new Promise(r => setTimeout(r, 150));
  } catch (err) {
    console.error(`  FAILED thought from ${thought.created_at}: ${err.message}`);
    failed++;
  }
}

console.log(`\nMigration complete:`);
console.log(`  Migrated: ${migrated}`);
console.log(`  Skipped (already exists): ${skipped}`);
console.log(`  Failed: ${failed}`);

await pool.end();
