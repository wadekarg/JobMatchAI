/**
 * Tests for normalizeUrlForCache (I2 from the audit).
 * The function must collapse "same job, different source" URLs to one key
 * without merging genuinely different jobs.
 */
import { describe, it, expect, beforeAll } from 'vitest';

let normalizeUrlForCache;
beforeAll(async () => {
  await import('../../lib/urlKey.js');
  normalizeUrlForCache = globalThis.JMUrlKey.normalizeUrlForCache;
});

describe('normalizeUrlForCache — collapses noise', () => {
  it('drops UTM and tracking params', () => {
    const a = 'https://acme.com/jobs/123?utm_source=linkedin&utm_medium=email&utm_campaign=spring';
    const b = 'https://acme.com/jobs/123?fbclid=abc&gclid=xyz';
    const c = 'https://acme.com/jobs/123';
    expect(normalizeUrlForCache(a)).toBe(normalizeUrlForCache(c));
    expect(normalizeUrlForCache(b)).toBe(normalizeUrlForCache(c));
  });

  it('drops fragments', () => {
    expect(normalizeUrlForCache('https://acme.com/jobs/123#applied'))
      .toBe(normalizeUrlForCache('https://acme.com/jobs/123'));
  });

  it('lowercases host', () => {
    expect(normalizeUrlForCache('https://ACME.com/jobs/123'))
      .toBe(normalizeUrlForCache('https://acme.com/jobs/123'));
  });

  it('strips trailing slash from non-root paths', () => {
    expect(normalizeUrlForCache('https://acme.com/jobs/123/'))
      .toBe(normalizeUrlForCache('https://acme.com/jobs/123'));
  });

  it('keeps trailing slash on root path', () => {
    expect(normalizeUrlForCache('https://acme.com/'))
      .toBe('https://acme.com/');
  });
});

describe('normalizeUrlForCache — preserves job identifiers', () => {
  it('keeps Greenhouse gh_jid', () => {
    const k1 = normalizeUrlForCache('https://acme.greenhouse.io/?gh_jid=4567&utm_source=li');
    const k2 = normalizeUrlForCache('https://acme.greenhouse.io/?gh_jid=4567');
    expect(k1).toBe(k2);
    expect(k1).toContain('gh_jid=4567');
  });

  it('keeps Indeed vjk', () => {
    const k = normalizeUrlForCache('https://www.indeed.com/viewjob?vjk=abc123&from=serp');
    expect(k).toContain('vjk=abc123');
    expect(k).not.toContain('from=');
  });

  it('keeps LinkedIn currentJobId', () => {
    const k = normalizeUrlForCache('https://www.linkedin.com/jobs/search/?currentJobId=999&utm=x');
    expect(k).toContain('currentJobId=999');
    expect(k).not.toContain('utm=');
  });

  it('two different gh_jid values produce different keys', () => {
    const a = normalizeUrlForCache('https://acme.greenhouse.io/?gh_jid=1');
    const b = normalizeUrlForCache('https://acme.greenhouse.io/?gh_jid=2');
    expect(a).not.toBe(b);
  });

  it('sorts surviving params for stability', () => {
    const a = normalizeUrlForCache('https://x.com/?vjk=1&jobid=2');
    const b = normalizeUrlForCache('https://x.com/?jobid=2&vjk=1');
    expect(a).toBe(b);
  });
});

describe('normalizeUrlForCache — robustness', () => {
  it('returns input unchanged when not a parseable URL', () => {
    expect(normalizeUrlForCache('not a url')).toBe('not a url');
  });

  it('handles empty / null / non-string input without throwing', () => {
    expect(normalizeUrlForCache('')).toBe('');
    expect(normalizeUrlForCache(null)).toBe(null);
    expect(normalizeUrlForCache(undefined)).toBe(undefined);
    expect(normalizeUrlForCache(42)).toBe(42);
  });
});
