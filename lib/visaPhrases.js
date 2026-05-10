/**
 * Visa-phrase detection for job descriptions.
 *
 * Scans the JD for explicit sponsorship signals so the panel can warn the
 * user *before* they spend an Analyze call on a posting that says
 * "no sponsorship" or "U.S. citizens only".
 *
 * Returns one of three signals:
 *   - { kind: 'no-sponsor', match: '<phrase>' }   // posting explicitly excludes
 *   - { kind: 'sponsor',    match: '<phrase>' }   // posting explicitly offers
 *   - { kind: 'unknown',    match: null      }   // no signal either way
 *
 * Negative wins over positive on tie — if a JD says both "we sponsor"
 * (boilerplate) and "must be authorized without sponsorship" (specific
 * to this role), the specific exclusion wins.
 *
 * Loaded as a content script before content.js — hangs the API on
 * globalThis. Mirrored at lib/visaPhrases.mjs for tests / future
 * service-worker use; a parity test keeps the two copies in sync.
 */
(function () {
  'use strict';

  // Tag each pattern with the canonical phrase shown in the chip's tooltip.
  // Patterns are matched as substrings against a normalized lowercased JD,
  // so they're forgiving of punctuation/spacing variation in the source.
  const NO_SPONSOR_PATTERNS = [
    // Direct refusals
    'no sponsorship',
    'no visa sponsorship',
    'will not sponsor',
    'do not sponsor',
    'unable to sponsor',
    'cannot sponsor',
    'not sponsor visas',
    'not provide sponsorship',
    'not offering sponsorship',
    'not offer sponsorship',
    'sponsorship is not available',
    'sponsorship not available',
    'sponsorship is not offered',
    'sponsorship is not provided',

    // "Must be authorized…" formulations
    'authorized to work in the united states without',
    'authorized to work in the u.s. without',
    'authorized to work in the us without',
    'must be authorized to work without',
    'eligible to work in the united states without',
    'work authorization without sponsorship',
    'must have work authorization',
    'without need for sponsorship',
    'without needing sponsorship',
    'without requiring sponsorship',
    'no h-1b',
    'no h1b',
    'opt and cpt are not eligible',
    'opt/cpt not eligible',
    'opt is not eligible',

    // Citizenship-only / clearance-driven roles
    'u.s. citizens only',
    'us citizens only',
    'united states citizens only',
    'must be a u.s. citizen',
    'must be a us citizen',
    'must be a united states citizen',
    'permanent resident only',
    'green card holders only',
    'active security clearance',
    'active secret clearance',
    'active top secret',
    'itar restricted',
    'itar compliant',
  ];

  const SPONSOR_PATTERNS = [
    'willing to sponsor',
    'we sponsor visas',
    'we will sponsor',
    'visa sponsorship is available',
    'visa sponsorship available',
    'sponsorship is available',
    'sponsorship available for',
    'h1b sponsorship',
    'h-1b sponsorship',
    'open to sponsoring',
    'will sponsor visas',
    'we offer visa sponsorship',
    'we provide visa sponsorship',
  ];

  function normalize(text) {
    return String(text || '')
      // collapse all whitespace
      .replace(/\s+/g, ' ')
      // common punctuation that doesn't change meaning
      .replace(/[“”"']/g, '')
      .toLowerCase();
  }

  /**
   * Scan a job description for explicit visa/sponsorship signals.
   * @param {string} jdText
   * @returns {{ kind: 'no-sponsor' | 'sponsor' | 'unknown', match: string|null }}
   */
  function detectVisaSignal(jdText) {
    const text = normalize(jdText);
    if (!text) return { kind: 'unknown', match: null };

    // Negative signals first — a single explicit refusal trumps any
    // boilerplate "we sponsor" language elsewhere in the JD.
    for (const p of NO_SPONSOR_PATTERNS) {
      if (text.includes(p)) return { kind: 'no-sponsor', match: p };
    }
    for (const p of SPONSOR_PATTERNS) {
      if (text.includes(p)) return { kind: 'sponsor', match: p };
    }
    return { kind: 'unknown', match: null };
  }

  const api = { detectVisaSignal, NO_SPONSOR_PATTERNS, SPONSOR_PATTERNS };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.JMVisaPhrases = api;
  }
})();
