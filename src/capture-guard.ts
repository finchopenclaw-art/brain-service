/**
 * The check on what lands in a shared department brain (card #271).
 *
 * Department staff save without a review step, and everyone in the department
 * reads what is saved, so this catches the details that must never be there.
 * It looks for the detail itself, not for a topic: co-op notes talk about
 * students, tokens and contract terminations all the time. The word lists in
 * scripts/lib/share.mjs are far broader on purpose; those only sort candidates
 * for Scott's review, and would refuse everyday notes here.
 *
 * Scott's own brain is not checked (see refusalFor).
 */
const RULES: [RegExp, string][] = [
  // Student records
  [/\b(student|pupil)[ -]?(id|number|test number)\b|\bSTN\b/i, 'a student ID'],
  [/\b(date of birth|DOB|birth ?date)\b/i, 'a date of birth'],
  [/\b(has|have|had|on|with) an? (IEP|504 plan)\b|\bspecial education record|\bfree (and|or) reduced (lunch )?(status|eligib\w+)/i, 'a student record'],
  [/\b(student|pupil)('s)? (name|grade|grades|address|record|records|email)\b/i, 'student details'],
  // Personnel
  [/\b(salary|salaries|payroll|hourly wage)\b/i, 'pay details'],
  [/\b(performance review|performance improvement plan|disciplinary|disciplined|written up|HR (complaint|matter|issue|investigation)|was fired|got fired|medical leave|FMLA)\b/i, 'a personnel matter'],
  // Credentials
  [/\b(password|passcode|passwd|pwd)\b\s*(is|was|=|:)/i, 'a password'],
  [/\b(api[ _-]?key|secret key|access token|private key|client secret)\b\s*(is|was|=|:)/i, 'a credential'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bBearer [A-Za-z0-9._-]{20,}/, 'a credential'],
  // Account numbers
  // "card #48" is a work card, so a card has to be named as a payment card.
  [/\b(account|acct|routing) ?(number|no\.|#)|\b(credit|debit|payment) card ?(number|no\.|#)/i, 'an account number'],
  [/\b\d{3}-\d{2}-\d{4}\b/, 'a Social Security number'],
  [/\b(?:\d[ -]?){15}\d\b/, 'a card number'],
];

/** null when the note may be saved; otherwise what was found. */
export function sensitiveDetail(content: string): string | null {
  for (const [re, what] of RULES) if (re.test(content)) return what;
  return null;
}

/** A refusal to show the person, or null. Only department brains are checked. */
export function refusalFor(schema: string, content: string): string | null {
  if (schema === 'brain') return null;
  const what = sensitiveDetail(content);
  if (!what) return null;
  return `Not saved: this note looks like it contains ${what}, and everyone in the department can read the Brain. Nothing was saved. Take that detail out and save again. If it is a false alarm, reword that part.`;
}
