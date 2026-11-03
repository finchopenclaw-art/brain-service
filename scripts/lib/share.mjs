// Pure helpers for scripts/share-brain.mjs and new-brain.mjs (card #271).
// Kept free of pg/dotenv so tests can import them.

/** brain_<dept>: a lowercase slug, 2–31 chars, letters then letters/digits. */
export function schemaFor(dept) {
  if (!/^[a-z][a-z0-9]{1,30}$/.test(dept ?? '')) {
    throw new Error(`Department slug must be lowercase letters/digits, starting with a letter: ${dept}`);
  }
  return `brain_${dept}`;
}

/**
 * Never offered for sharing, whatever the search finds. Scott still reviews
 * every candidate; this only keeps the obvious no's off his list.
 *  - other projects' tagged thoughts (their data must not cross projects)
 *  - student data / FERPA, Greenwood (FERPA vertical), Indiana Online students
 *  - personnel and pay
 *  - anything that looks like a credential
 */
const EXCLUDE = [
  [/\[(adgs[a-z-]*|indiana-online|io|assessment-analytics)\]/i, 'other project'],
  [/\b(student|students|ferpa|greenwood|i-?ready|ilearn|genius|canvas|attendance)\b/i, 'student data'],
  [/\b(salary|salaries|payroll|personnel|disciplin\w*|performance review|hr matter|termination|fired)\b/i, 'personnel'],
  [/\b(password|passwd|api[ _-]?key|secret|token|private key|ssh key|bearer)\b/i, 'credential'],
  [/\b(stripe|card-testing|credit card)\b/i, 'payments'],
];

/** null when a thought may be offered; otherwise the reason it is held back. */
export function exclusionReason(content) {
  for (const [re, why] of EXCLUDE) if (re.test(content)) return why;
  return null;
}

/**
 * The review file Scott edits: one line per candidate,
 *   - [x] <uuid> · 2026-08-14 · first 220 chars…
 * Leave [x] to share, change it to [ ] (or delete the line) to hold back.
 */
export function renderReview(dept, candidates) {
  const lines = [
    `# Share to brain_${dept} — review`,
    '',
    `${candidates.length} candidate(s). Every line marked [x] is copied; change to [ ] or delete the line to hold it back.`,
    'Then: node scripts/share-brain.mjs copy --to ' + dept + ' --file <this file>',
    '',
  ];
  for (const c of candidates) {
    const date = new Date(c.created_at).toISOString().slice(0, 10);
    const text = c.content.replace(/\s+/g, ' ').trim();
    lines.push(`- [x] ${c.id} · ${date} · ${text.length > 220 ? text.slice(0, 219) + '…' : text}`);
  }
  return lines.join('\n') + '\n';
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The ids still ticked [x] in a review file. */
export function approvedIds(text) {
  const ids = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s*\[[xX]\]\s*(\S+)/);
    if (m && UUID.test(m[1])) ids.push(m[1].toLowerCase());
  }
  return [...new Set(ids)];
}
