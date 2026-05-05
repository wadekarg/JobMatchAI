/**
 * Field-name allowlist for the autofill pipeline (C3b).
 *
 * Two threats this defends against:
 *  1. A page (or AI prompt-injection) coaxes the autofill loop into writing
 *     into a CSRF / token / tracking field, leaking session data or
 *     stamping the form with attacker-chosen identifiers.
 *  2. A page exposes a field whose name suggests it stores something
 *     sensitive (honeypot, _internal, etc.) — we don't want to send it
 *     to the AI either, which means it never appears as a candidate.
 *
 * Loaded as a content script before content.js — hangs the API on
 * globalThis so content scripts in the same isolated world can use it,
 * and tests can `import './lib/fieldFilter.js'` and read globalThis.
 *
 * Mirrored at lib/fieldFilter.mjs for the service worker / tests; a
 * parity test keeps the two copies in sync.
 */
(function () {
  'use strict';

  // Substrings that disqualify a field (case-insensitive). Matched against
  // the field's id, name, and any data-testid.
  const SENSITIVE_PATTERNS = [
    'csrf', 'xsrf', 'nonce', 'antiforgery', 'authenticity',
    '_token', 'csrftoken', 'csrfmiddlewaretoken', 'authtoken',
    'session_id', 'sessionid', 'sessiontoken',
    'tracking', 'utm_', 'gclid', 'fbclid',
    'honeypot', 'leave_blank', 'do_not_fill',
    'recaptcha', 'g-recaptcha', 'h-captcha', 'hcaptcha', 'turnstile',
  ];

  // Exact name/id matches that disqualify a field. Some frameworks use
  // these for internal bookkeeping (e.g. Django/Rails CSRF token name).
  const SENSITIVE_EXACT = new Set([
    '_csrf', '__csrf', '__rvt', '__viewstate', '__eventvalidation',
    'authenticity_token', 'csrf_token', 'csrftoken',
    'utf8', '_method',
  ]);

  /**
   * @param {string} name - The field's id, name, or data-testid.
   * @returns {boolean} true if this field should never be autofilled.
   */
  function isSensitiveFieldName(name) {
    if (!name || typeof name !== 'string') return false;
    const lower = name.toLowerCase();
    if (SENSITIVE_EXACT.has(lower)) return true;
    // Names beginning with one or more underscores are usually internal.
    if (/^_+[a-z]/.test(lower)) return true;
    return SENSITIVE_PATTERNS.some(p => lower.includes(p));
  }

  /**
   * Returns true if the field is safe to consider for autofill. Currently a
   * thin wrapper over isSensitiveFieldName but kept separate so callers
   * read naturally and we have one place to add future heuristics.
   *
   * @param {Element} el - DOM element (input, textarea, select).
   * @returns {boolean}
   */
  function isFieldEligible(el) {
    if (!el) return false;
    const probes = [el.id, el.name, el.getAttribute && el.getAttribute('data-testid')];
    for (const probe of probes) {
      if (isSensitiveFieldName(probe)) return false;
    }
    return true;
  }

  const api = { isSensitiveFieldName, isFieldEligible, SENSITIVE_PATTERNS, SENSITIVE_EXACT };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.JMFieldFilter = api;
  }
})();
