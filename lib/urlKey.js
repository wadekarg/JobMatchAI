/**
 * URL normalization for cache keys.
 *
 * Two visits to the same job posting from different sources should hit the
 * same cache entry. UTM params, click IDs, and analytics noise must not
 * defeat the cache or duplicate applied-jobs entries (I2 in the audit).
 *
 * Loaded as a content script before content.js — it hangs the API on
 * globalThis so other content scripts in the same isolated world can use it,
 * and tests can `import './lib/urlKey.js'` and read globalThis.JMUrlKey.
 */
(function () {
  'use strict';

  // Query params that genuinely identify a job posting on a given site.
  // Anything not on this list is dropped during normalization.
  const JOB_ID_PARAMS = new Set([
    'gh_jid',         // Greenhouse
    'jobId',          // Workday, generic
    'jobid',          // case variant
    'currentJobId',   // LinkedIn /jobs/search variant
    'jl',             // Glassdoor job listing
    'vjk',            // Indeed view-job-key
    'jk',             // Indeed alternate
    'lever-source',   // never (it's a tracking source) — listed here so it's
  ]);
  // Actually drop lever-source; it's tracking. Not adding it to the set above.
  JOB_ID_PARAMS.delete('lever-source');

  /**
   * Normalize a URL into a stable cache key.
   *
   * - Drops URL fragment (#…)
   * - Lowercases scheme + host
   * - Strips trailing slash from path (except root)
   * - Drops every query param not on JOB_ID_PARAMS allowlist
   * - Sorts surviving params alphabetically for stability
   *
   * If the input is not a parseable URL, returns it unchanged so callers can
   * still use it as a key (defensive — never throws).
   *
   * @param {string} rawUrl
   * @returns {string} a normalized URL safe to use as a cache/dedupe key
   */
  function normalizeUrlForCache(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
    let u;
    try { u = new URL(rawUrl); } catch (_) { return rawUrl; }

    // Lowercase scheme + host (path is case-sensitive on most servers)
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();

    // Drop fragment
    u.hash = '';

    // Filter query params: keep only allowlisted job-id params.
    const keepParams = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (JOB_ID_PARAMS.has(k)) keepParams.push([k, v]);
    }
    keepParams.sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [k, v] of keepParams) u.searchParams.append(k, v);

    // Drop trailing slash from path (except for the root "/")
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }

    return u.toString();
  }

  const api = { normalizeUrlForCache };

  // CommonJS / vitest
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // Content script / browser
  if (typeof globalThis !== 'undefined') {
    globalThis.JMUrlKey = api;
  }
})();
