/**
 * ES-module mirror of lib/visaPhrases.js. The classic-script copy is for
 * content scripts; this copy is for tests and any future service-worker
 * use. A parity test asserts both produce the same output for the same
 * inputs — change one, change both.
 */

const NO_SPONSOR_PATTERNS = [
  'no sponsorship',
  'no visa sponsorship',
  'will not sponsor',
  'do not sponsor',
  'does not sponsor',
  'does not currently sponsor',
  'does not provide sponsorship',
  'will not consider sponsoring',
  'do not consider sponsoring',
  'will not consider sponsorship',
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
  'not eligible for visa sponsorship',
  'not eligible for sponsorship',
  'without sponsorship now or in the future',
  'do not offer visa sponsorship',
  'does not offer visa sponsorship',
  'not offer visa sponsorship',
  'not offering visa sponsorship',
  'currently unable to sponsor',
  'are not able to sponsor',
  'unable to provide sponsorship',
  'opt not eligible',
  'us person status',

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

  'consider sponsoring',
  'consider sponsorship',
  'will consider sponsorship',
  'may consider sponsoring',
  'may sponsor',
  'may provide sponsorship',
  'able to sponsor',
  'eligible for visa sponsorship',
  'eligible for sponsorship',
  'sponsor employment authorization',
  'sponsors h1b',
  'sponsor h1b',
  'we sponsor work visas',
  'sponsorship is offered',
  'sponsorship offered',
];

function normalize(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[“”"']/g, '')
    .toLowerCase();
}

export function detectVisaSignal(jdText) {
  const text = normalize(jdText);
  if (!text) return { kind: 'unknown', match: null };
  for (const p of NO_SPONSOR_PATTERNS) {
    if (text.includes(p)) return { kind: 'no-sponsor', match: p };
  }
  for (const p of SPONSOR_PATTERNS) {
    if (text.includes(p)) return { kind: 'sponsor', match: p };
  }
  return { kind: 'unknown', match: null };
}

export { NO_SPONSOR_PATTERNS, SPONSOR_PATTERNS };
