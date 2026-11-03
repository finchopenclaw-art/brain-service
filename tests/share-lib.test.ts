import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs helper
import { schemaFor, exclusionReason, renderReview, approvedIds } from '../scripts/lib/share.mjs';

describe('schemaFor', () => {
  it('builds brain_<dept>', () => expect(schemaFor('coop')).toBe('brain_coop'));
  it('reserves org for the shared org reference', () => expect(() => schemaFor('org')).toThrow(/reserved/));
  it('refuses anything that is not a plain slug', () => {
    for (const bad of ['', 'Coop', 'co-op', 'x', 'coop"; drop', '1coop', undefined]) expect(() => schemaFor(bad)).toThrow();
  });
});

describe('exclusionReason', () => {
  it('lets ordinary co-op knowledge through', () => {
    expect(exclusionReason('[ciesc-platform] CDW fee is gross of returns; check min invoice date after every load')).toBeNull();
  });
  it.each([
    ['[adgs-quotes] Supabase paused', 'other project'],
    ['[assessment-analytics] cohort table', 'other project'],
    ['Greenwood i-Ready drop landed', 'student data'],
    ['42 students missing attendance', 'student data'],
    ['salary schedule for the business office', 'personnel'],
    ['rotated the API key for the VPS', 'credential'],
    ['Stripe card-testing again', 'payments'],
  ])('holds back %s', (text, why) => expect(exclusionReason(text)).toBe(why));
});

describe('review file round trip', () => {
  const c = [
    { id: '11111111-1111-1111-1111-111111111111', created_at: '2026-08-14T12:00:00Z', content: 'Edge Public sends one workbook' },
    { id: '22222222-2222-2222-2222-222222222222', created_at: '2026-09-01T12:00:00Z', content: 'x'.repeat(400) },
  ];
  it('renders every candidate ticked, long text cut', () => {
    const md = renderReview('coop', c);
    expect(md).toContain('- [x] 11111111-1111-1111-1111-111111111111 · 2026-08-14 · Edge Public sends one workbook');
    expect(md).toContain('…');
  });
  it('reads back only the lines still ticked', () => {
    const md = renderReview('coop', c).replace('- [x] 2222', '- [ ] 2222');
    expect(approvedIds(md)).toEqual(['11111111-1111-1111-1111-111111111111']);
  });
  it('ignores junk lines', () => expect(approvedIds('- [x] not-a-uuid\n# heading')).toEqual([]));
});
