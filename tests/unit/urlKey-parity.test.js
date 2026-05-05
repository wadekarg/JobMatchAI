/**
 * Parity test: lib/urlKey.js (content-script IIFE) and lib/urlKey.mjs
 * (service-worker ES module) hold the same logic. If the two ever
 * diverge, this test will catch it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { normalizeUrlForCache as mjsNormalize } from '../../lib/urlKey.mjs';

let jsNormalize;
beforeAll(async () => {
  await import('../../lib/urlKey.js');
  jsNormalize = globalThis.JMUrlKey.normalizeUrlForCache;
});

const cases = [
  'https://acme.com/jobs/123?utm_source=li&fbclid=x',
  'https://acme.com/jobs/123/',
  'https://ACME.com/jobs/123',
  'https://acme.greenhouse.io/?gh_jid=4567&utm_source=li',
  'https://www.indeed.com/viewjob?vjk=abc123&from=serp',
  'https://www.linkedin.com/jobs/search/?currentJobId=999',
  'https://x.com/?vjk=1&jobid=2',
  'https://x.com/?jobid=2&vjk=1',
  'https://acme.com/jobs/123#anchor',
  'not a url',
  '',
];

describe('urlKey.js ↔ urlKey.mjs parity', () => {
  it.each(cases)('produces identical output for %s', (input) => {
    expect(jsNormalize(input)).toBe(mjsNormalize(input));
  });
});
