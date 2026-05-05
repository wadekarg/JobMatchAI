/**
 * Tests for the autofill field allowlist (C3b from the audit).
 *
 * Catches: CSRF tokens, tracking IDs, honeypots, framework internals.
 * Allows: ordinary application form field names (name, email, phone, etc.).
 */
import { describe, it, expect, beforeAll } from 'vitest';

let isSensitiveFieldName, isFieldEligible;
beforeAll(async () => {
  await import('../../lib/fieldFilter.js');
  ({ isSensitiveFieldName, isFieldEligible } = globalThis.JMFieldFilter);
});

describe('isSensitiveFieldName — blocks dangerous names', () => {
  const blocked = [
    'csrf_token', '_csrf', '__csrf', 'csrfmiddlewaretoken',
    'authenticity_token', 'authToken', 'XSRF-TOKEN',
    'session_id', 'sessionid', 'sessionToken',
    '__viewstate', '__eventvalidation', '__rvt',
    'utm_source', 'tracking_id', 'gclid', 'fbclid',
    'g-recaptcha-response', 'h-captcha-response',
    'honeypot_field', 'leave_blank', 'do_not_fill',
    '_internal', '_meta', '__hidden',
  ];

  it.each(blocked)('blocks %s', (name) => {
    expect(isSensitiveFieldName(name)).toBe(true);
  });
});

describe('isSensitiveFieldName — allows ordinary application fields', () => {
  const allowed = [
    'first_name', 'last_name', 'email', 'phone', 'phone_number',
    'address1', 'city', 'state', 'zip', 'postal_code',
    'work_authorization', 'visa_status', 'salary_expectation',
    'why_us', 'cover_letter', 'years_of_experience',
    'gender', 'race', 'veteran_status', 'disability_status',
    'how_did_you_hear', 'referrer_name', 'desired_start_date',
  ];

  it.each(allowed)('allows %s', (name) => {
    expect(isSensitiveFieldName(name)).toBe(false);
  });
});

describe('isSensitiveFieldName — robustness', () => {
  it('returns false for empty/null/non-string input', () => {
    expect(isSensitiveFieldName('')).toBe(false);
    expect(isSensitiveFieldName(null)).toBe(false);
    expect(isSensitiveFieldName(undefined)).toBe(false);
    expect(isSensitiveFieldName(42)).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(isSensitiveFieldName('CSRF_TOKEN')).toBe(true);
    expect(isSensitiveFieldName('Tracking_Id')).toBe(true);
  });
});

describe('isFieldEligible', () => {
  it('returns false when the input id matches a blocked pattern', () => {
    const el = { id: 'csrf_token', name: '', getAttribute: () => null };
    expect(isFieldEligible(el)).toBe(false);
  });

  it('returns false when the data-testid matches a blocked pattern', () => {
    const el = { id: 'innocent', name: '', getAttribute: (a) => a === 'data-testid' ? 'csrf_input' : null };
    expect(isFieldEligible(el)).toBe(false);
  });

  it('returns true when nothing flags', () => {
    const el = { id: 'first_name', name: 'first_name', getAttribute: () => null };
    expect(isFieldEligible(el)).toBe(true);
  });

  it('returns false for null element', () => {
    expect(isFieldEligible(null)).toBe(false);
  });
});
