import { describe, it, expect } from 'vitest';
import { sensitiveDetail, refusalFor } from '../src/capture-guard.js';

describe('sensitiveDetail', () => {
  it.each([
    'Total ADM grew because more members joined, not more students per district.',
    'Savings per student rose at Greenwood after the KI Furniture order.',
    'CDW fee column is gross of returns; Kelly confirmed $20,095.28 net on 2026-11-04.',
    'The contract termination date for CMP moved to June.',
    'Districts can pay Amazon by credit card or purchase order.',
    'Canvas bags and attendance rosters came through School Specialty.',
    'Invoice AJ2X53Y for $50,000 is on the master tab only.',
    'Kelly reports to Dr. Melin. Staff schedules are not part of the co-op.',
    'FY25-26 member spend was $113,408,769 across 38 organizations.',
    'Card #48 covers the US Foods project; card #259 is the bus rebuild.',
    'Glossary: "IEP" means Individualized Education Program.',
  ])('lets a normal note through: %s', (text) => expect(sensitiveDetail(text)).toBeNull());

  it.each([
    ['Student ID 4471823 was on the file', 'a student ID'],
    ['Her date of birth is on row 12', 'a date of birth'],
    ['He has an IEP at Avon', 'a student record'],
    ['The student name column was blank', 'student details'],
    ['Her salary went up in July', 'pay details'],
    ['He was disciplined for the late report', 'a personnel matter'],
    ['The portal password is Blue42', 'a password'],
    ['api key: abc123', 'a credential'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', 'a credential'],
    ['Our vendor account number with US Foods is 88123', 'an account number'],
    ['Credit card number on file ends 4411', 'an account number'],
    ['SSN 123-45-6789', 'a Social Security number'],
    ['Paid with 4111 1111 1111 1111', 'a card number'],
  ])('stops %s', (text, what) => expect(sensitiveDetail(text)).toBe(what));
});

describe('refusalFor', () => {
  it('leaves Scott\'s own brain alone', () => expect(refusalFor('brain', 'password is x')).toBeNull());
  it('explains itself in a department brain', () =>
    expect(refusalFor('brain_coop', 'password is x')).toMatch(/^Not saved: .*a password/));
});
