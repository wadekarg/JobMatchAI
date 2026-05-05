/**
 * ES-module version of normalizeUrlForCache for the MV3 service worker
 * (background.js loads as a module). The classic-script copy at
 * lib/urlKey.js is the same logic for content scripts.
 *
 * If you change one, change the other — the parity test at
 * tests/unit/urlKey-parity.test.js verifies they produce identical output.
 */

const JOB_ID_PARAMS = new Set([
  'gh_jid',         // Greenhouse
  'jobId',          // Workday, generic
  'jobid',          // case variant
  'currentJobId',   // LinkedIn /jobs/search variant
  'jl',             // Glassdoor job listing
  'vjk',            // Indeed view-job-key
  'jk',             // Indeed alternate
]);

export function normalizeUrlForCache(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  let u;
  try { u = new URL(rawUrl); } catch (_) { return rawUrl; }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = '';

  const keepParams = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (JOB_ID_PARAMS.has(k)) keepParams.push([k, v]);
  }
  keepParams.sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of keepParams) u.searchParams.append(k, v);

  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }

  return u.toString();
}
