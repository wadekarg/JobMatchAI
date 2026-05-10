/**
 * Tests for the pure helpers behind the H1B-lookup cache. The chrome.storage
 * I/O wrapper lives in background.js; these tests cover the parts that don't
 * need a chrome environment — key derivation, TTL, and LRU eviction.
 */
import { describe, it, expect } from 'vitest';
import {
  h1bCacheKey,
  isExpired,
  evictOldest,
  H1B_CACHE_TTL_MS,
  H1B_CACHE_MAX,
} from '../../lib/h1bCache.mjs';

describe('h1bCacheKey', () => {
  it('lowercases and trims', () => {
    expect(h1bCacheKey('  Google LLC ')).toBe('google llc');
  });

  it('returns empty string for missing input', () => {
    expect(h1bCacheKey('')).toBe('');
    expect(h1bCacheKey(null)).toBe('');
    expect(h1bCacheKey(undefined)).toBe('');
  });

  it('coerces non-strings safely', () => {
    expect(h1bCacheKey(42)).toBe('42');
  });

  it('"Google" and "  google  " hit the same key', () => {
    expect(h1bCacheKey('Google')).toBe(h1bCacheKey('  google  '));
  });
});

describe('isExpired', () => {
  const now = 10_000_000_000;

  it('null / non-object entry is always expired', () => {
    expect(isExpired(null, now)).toBe(true);
    expect(isExpired(undefined, now)).toBe(true);
    expect(isExpired('string', now)).toBe(true);
  });

  it('entry without _t is treated as expired', () => {
    expect(isExpired({}, now)).toBe(true);
  });

  it('entry within TTL is fresh', () => {
    const entry = { _t: now - (H1B_CACHE_TTL_MS - 1) };
    expect(isExpired(entry, now)).toBe(false);
  });

  it('entry exactly at TTL boundary is fresh', () => {
    const entry = { _t: now - H1B_CACHE_TTL_MS };
    expect(isExpired(entry, now)).toBe(false);
  });

  it('entry past TTL is expired', () => {
    const entry = { _t: now - (H1B_CACHE_TTL_MS + 1) };
    expect(isExpired(entry, now)).toBe(true);
  });

  it('custom TTL is honored', () => {
    const entry = { _t: now - 5000 };
    expect(isExpired(entry, now, 6000)).toBe(false);
    expect(isExpired(entry, now, 4000)).toBe(true);
  });
});

describe('evictOldest', () => {
  it('returns a fresh object when under cap (does not mutate input)', () => {
    const cache = { a: 1, b: 2, c: 3 };
    const out = evictOldest(cache, 10);
    expect(out).toEqual(cache);
    expect(out).not.toBe(cache); // different reference
  });

  it('drops the head when over cap (V8 insertion order)', () => {
    const cache = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    const out = evictOldest(cache, 3);
    expect(Object.keys(out)).toEqual(['c', 'd', 'e']);
    expect(out.a).toBeUndefined();
    expect(out.b).toBeUndefined();
  });

  it('drops everything when max is 0', () => {
    expect(evictOldest({ a: 1 }, 0)).toEqual({});
  });

  it('handles null / non-object input', () => {
    expect(evictOldest(null)).toEqual({});
    expect(evictOldest(undefined)).toEqual({});
    expect(evictOldest('not an object')).toEqual({});
  });
});

describe('H1B_CACHE constants', () => {
  it('TTL is 7 days', () => {
    expect(H1B_CACHE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('cap is 200', () => {
    expect(H1B_CACHE_MAX).toBe(200);
  });
});
