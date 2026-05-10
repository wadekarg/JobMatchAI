/**
 * Tests for the visa-phrase detector.
 *
 * Covers: positive (sponsor) signals, negative (no-sponsor) signals, no-signal
 * benign JDs, false-positive guards (mentions of "visa" that aren't about
 * sponsorship), and parity between lib/visaPhrases.js and lib/visaPhrases.mjs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { detectVisaSignal as mjsDetect } from '../../lib/visaPhrases.mjs';

let jsDetect;
beforeAll(async () => {
  await import('../../lib/visaPhrases.js');
  jsDetect = globalThis.JMVisaPhrases.detectVisaSignal;
});

const noSponsorJDs = [
  'Applicants must be authorized to work in the United States without sponsorship.',
  'We do not sponsor work visas at this time.',
  'Will not sponsor visas for this position.',
  'Candidates must have work authorization in the U.S. without need for sponsorship now or in the future.',
  'Sponsorship is not available for this role.',
  'No H-1B visa sponsorship offered.',
  'U.S. Citizens only — this position requires an active security clearance.',
  'Must be a US Citizen due to ITAR restrictions.',
  'OPT/CPT not eligible for this role.',
];

const sponsorJDs = [
  'We are willing to sponsor visas for the right candidate.',
  'H1B sponsorship is available for this position.',
  'Visa sponsorship available for qualified applicants.',
  'We will sponsor international candidates.',
  'Open to sponsoring exceptional engineers.',
];

const noSignalJDs = [
  'We are looking for a Senior Software Engineer with 5+ years of Python experience.',
  'Build scalable distributed systems handling 1M+ requests/second.',
  'Competitive salary, great benefits, hybrid work environment.',
  'Visa Inc. is hiring a backend engineer.',  // false-positive guard
  'Must be authorized to work in the United States.',  // ambiguous — just authorization, no sponsorship language
  'Travel up to 25% required.',
  '',
  null,
  undefined,
];

describe('detectVisaSignal — no-sponsor signals', () => {
  it.each(noSponsorJDs)('flags: %s', (jd) => {
    expect(jsDetect(jd).kind).toBe('no-sponsor');
  });
});

describe('detectVisaSignal — sponsor signals', () => {
  it.each(sponsorJDs)('flags: %s', (jd) => {
    expect(jsDetect(jd).kind).toBe('sponsor');
  });
});

describe('detectVisaSignal — no signal', () => {
  it.each(noSignalJDs)('does not flag: %s', (jd) => {
    expect(jsDetect(jd).kind).toBe('unknown');
  });
});

describe('detectVisaSignal — precedence', () => {
  it('negative wins when both signals appear in the same JD', () => {
    const jd = 'We sponsor visas for many roles, but for this position applicants must be authorized to work in the United States without sponsorship.';
    expect(jsDetect(jd).kind).toBe('no-sponsor');
  });

  it('returns the matched phrase so the chip can show it', () => {
    const r = jsDetect('No visa sponsorship offered.');
    expect(r.kind).toBe('no-sponsor');
    expect(r.match).toBe('no visa sponsorship');
  });
});

describe('detectVisaSignal — robustness', () => {
  it('is case-insensitive', () => {
    expect(jsDetect('NO VISA SPONSORSHIP').kind).toBe('no-sponsor');
    expect(jsDetect('Willing to Sponsor').kind).toBe('sponsor');
  });

  it('is forgiving of curly quotes and extra whitespace', () => {
    const jd = 'We “will not sponsor” candidates  for this  role.';
    expect(jsDetect(jd).kind).toBe('no-sponsor');
  });

  it('returns unknown on non-string input', () => {
    expect(jsDetect(null).kind).toBe('unknown');
    expect(jsDetect(undefined).kind).toBe('unknown');
    expect(jsDetect(42).kind).toBe('unknown');
  });
});

describe('lib/visaPhrases.js ↔ lib/visaPhrases.mjs parity', () => {
  const cases = [...noSponsorJDs, ...sponsorJDs, 'plain JD with nothing visa-related', ''];
  it.each(cases)('produces the same kind for: %s', (jd) => {
    expect(jsDetect(jd).kind).toBe(mjsDetect(jd).kind);
  });
});
