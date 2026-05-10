/**
 * Pure helpers for the H1B-lookup cache that lives in chrome.storage.local
 * under `jm_h1bCache`. The actual storage I/O lives in background.js
 * (handleH1bLookup); these helpers exist so the key-derivation, TTL, and
 * LRU-eviction logic can be unit-tested without mocking chrome APIs.
 *
 * Cache shape:
 *   { [normalizedCompanyKey]: { ...endpointResponse, _t: <epoch ms> } }
 */

export const H1B_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const H1B_CACHE_MAX    = 200;

/**
 * Stable cache key for a raw company-name input. Lowercased + trimmed so
 * "Google " and "google" hit the same entry. Server normalizes further on
 * lookup, but we don't need to mirror that — local cache is a hot-path hit.
 */
export function h1bCacheKey(company) {
  return String(company || '').trim().toLowerCase();
}

/**
 * @param {object|null} entry  — value pulled from cache for a key
 * @param {number} now         — Date.now() at read time
 * @param {number} ttl         — TTL in ms (defaults to 7 days)
 * @returns {boolean} true if the entry is missing or expired
 */
export function isExpired(entry, now, ttl = H1B_CACHE_TTL_MS) {
  if (!entry || typeof entry !== 'object') return true;
  const t = entry._t || 0;
  return (now - t) > ttl;
}

/**
 * Returns a new cache object trimmed to at most `max` entries by dropping
 * the oldest insertion-order keys (V8 preserves insertion order, so the
 * head of Object.keys is the oldest). Pure — does not mutate the input.
 *
 * @param {object} cache
 * @param {number} max
 * @returns {object}
 */
export function evictOldest(cache, max = H1B_CACHE_MAX) {
  if (!cache || typeof cache !== 'object') return {};
  const keys = Object.keys(cache);
  if (keys.length <= max) return { ...cache };
  const toDrop = keys.length - max;
  const out = {};
  for (let i = toDrop; i < keys.length; i++) {
    out[keys[i]] = cache[keys[i]];
  }
  return out;
}
