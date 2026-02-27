// deterministicMatcher.js — Deterministic matching for demographic/compliance fields
// Imported by background.js. NO AI calls. Pure string matching logic.

// ─── Question topic detection ────────────────────────────────────────

const TOPIC_PATTERNS = {
  gender: [
    /\bgender\b/i, /\bsex\b/i, /\bman\b.*\bwoman\b/i,
    /\bi identify my gender\b/i, /\bmale\b.*\bfemale\b/i
  ],
  gender_identity: [
    /\bgender.?identity\b/i, /\bcisgender\b/i, /\btransgender\b/i,
    /\bi identify as\b/i
  ],
  sexual_orientation: [
    /\bsexual.?orientation\b/i, /\bstraight\b/i, /\bheterosexual\b/i,
    /\bi identify my sexual\b/i
  ],
  race_ethnicity: [
    /\brace\b/i, /\bethnicit/i, /\bethnic\b/i,
    /\bi identify my race\b/i
  ],
  hispanic_latino: [
    /\bhispanic\b/i, /\blatino\b/i, /\blatina\b/i, /\blatinx\b/i
  ],
  veteran: [
    /\bveteran\b/i, /\bmilitary\b/i, /\bserved\b/i
  ],
  disability: [
    /\bdisabilit/i, /\bhandicap\b/i, /\bi have a disability\b/i
  ],
  pronouns: [
    /\bpronoun/i
  ],
  work_auth: [
    /\bauthori[zs]/i, /\bwork.*(?:us|united states|u\.s)/i,
    /\blegal.*work\b/i, /\beligib.*work\b/i, /\bemploy.*eligib/i
  ],
  sponsorship: [
    /\bsponsor/i, /\bvisa\b/i, /\bh[-\s]?1b\b/i
  ]
};

// Map topics to Q&A question keywords for lookup
const TOPIC_TO_QA_KEYWORDS = {
  gender: ['gender'],
  gender_identity: ['gender identity'],
  sexual_orientation: ['sexual orientation'],
  race_ethnicity: ['race', 'ethnicity'],
  hispanic_latino: ['hispanic', 'latino'],
  veteran: ['veteran'],
  disability: ['disability'],
  pronouns: ['pronoun'],
  work_auth: ['authorized to work', 'work authorization', 'legally authorized', 'eligible to work'],
  sponsorship: ['sponsorship', 'visa', 'sponsor']
};

// ─── Synonym maps for deterministic matching ─────────────────────────

const ANSWER_SYNONYMS = {
  // Gender
  'male': ['man', 'male', 'masculine', 'm'],
  'man': ['man', 'male', 'masculine', 'm'],
  'female': ['woman', 'female', 'feminine', 'f'],
  'woman': ['woman', 'female', 'feminine', 'f'],

  // Gender identity
  'cisgender': ['cisgender', 'cis'],
  'transgender': ['transgender', 'trans'],

  // Sexual orientation
  'heterosexual': ['heterosexual', 'straight', 'straight/heterosexual'],
  'straight': ['heterosexual', 'straight', 'straight/heterosexual'],
  'straight/heterosexual': ['heterosexual', 'straight', 'straight/heterosexual'],
  'gay': ['gay'],
  'lesbian': ['lesbian'],
  'bisexual': ['bisexual', 'bi'],

  // Yes/No
  'yes': ['yes', 'true', '1'],
  'no': ['no', 'false', '0'],

  // Race — map user's short answer to keywords in long option text
  'south asian': ['south asian'],
  'indian': ['south asian', 'india'],
  'east asian': ['east asian'],
  'chinese': ['east asian', 'chinese'],
  'japanese': ['east asian', 'japanese'],
  'korean': ['east asian', 'korean'],
  'southeast asian': ['southeast asian'],
  'filipino': ['southeast asian', 'filipino', 'philippine'],
  'vietnamese': ['southeast asian', 'vietnamese'],
  'black': ['black', 'african american'],
  'african american': ['black', 'african american'],
  'white': ['white', 'caucasian', 'european'],
  'caucasian': ['white', 'caucasian'],
  'hispanic': ['hispanic', 'latino', 'latina', 'latinx'],
  'latino': ['hispanic', 'latino'],
  'native american': ['american indian', 'alaska native', 'native american', 'indigenous'],
  'pacific islander': ['pacific islander', 'native hawaiian'],
  'middle eastern': ['middle eastern', 'north african'],
  'arab': ['middle eastern', 'north african'],
  'central asian': ['central asian'],
  'asian': ['asian'],
  'two or more': ['two or more', 'multiracial', 'mixed'],
};

// ─── Core: detect topic from question text ──────────────────────────

function detectTopic(questionText) {
  const text = questionText.toLowerCase();
  for (const [topic, patterns] of Object.entries(TOPIC_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(text)) return topic;
    }
  }
  return null;
}

// ─── Core: find matching Q&A answer for a topic ─────────────────────

function findQAAnswer(topic, qaList) {
  if (!qaList || !qaList.length) return null;

  const keywords = TOPIC_TO_QA_KEYWORDS[topic];
  if (!keywords) return null;

  for (const qa of qaList) {
    if (!qa.answer || !qa.answer.trim()) continue;
    const qLower = qa.question.toLowerCase();
    for (const kw of keywords) {
      if (qLower.includes(kw)) return qa.answer.trim();
    }
  }
  return null;
}

// ─── Core: find matching Q&A answer from profile data ───────────────

function findProfileAnswer(topic, profile) {
  if (!profile) return null;

  if (topic === 'work_auth') {
    // Check profile for work auth fields
    if (profile.workAuthorization) return profile.workAuthorization;
  }

  return null;
}

// ─── Normalize string for comparison ────────────────────────────────

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Match a saved answer to an available option ────────────────────

function matchAnswerToOption(savedAnswer, options, topic) {
  if (!savedAnswer || !options || options.length === 0) return null;

  const answerLower = savedAnswer.toLowerCase().trim();
  const answerNorm = normalize(savedAnswer);

  // ── 1. Exact match (case-insensitive) ──
  for (const opt of options) {
    if (opt.toLowerCase().trim() === answerLower) return opt;
  }

  // ── 2. Normalized exact match ──
  for (const opt of options) {
    if (normalize(opt) === answerNorm) return opt;
  }

  // ── 3. Synonym-based matching ──
  const synonyms = ANSWER_SYNONYMS[answerLower] || [];
  if (synonyms.length > 0) {
    for (const opt of options) {
      const optLower = opt.toLowerCase();
      for (const syn of synonyms) {
        // Check if the option text CONTAINS any synonym
        if (optLower === syn || optLower.includes(syn)) return opt;
      }
    }
  }

  // ── 4. Contains match (answer in option, or option in answer) ──
  for (const opt of options) {
    const optLower = opt.toLowerCase().trim();
    if (optLower.includes(answerLower) || answerLower.includes(optLower)) return opt;
  }

  // ── 5. Word-level matching for long options (e.g., race/ethnicity) ──
  // "Indian" should match "South Asian (inclusive of ... India ...)"
  if (topic === 'race_ethnicity') {
    for (const opt of options) {
      const optLower = opt.toLowerCase();
      // Check if the answer word appears in the option's parenthetical details
      if (optLower.includes(answerLower)) return opt;
      // Check synonyms against full option text
      for (const syn of synonyms) {
        if (optLower.includes(syn)) return opt;
      }
    }
  }

  // ── 6. Yes/No matching for veteran/disability/compliance ──
  if (['veteran', 'disability', 'hispanic_latino', 'work_auth', 'sponsorship'].includes(topic)) {
    const isYes = /^(yes|true|1|i am|i do|i have)$/i.test(answerLower);
    const isNo = /^(no|false|0|i am not|i do not|i don't|i have not)$/i.test(answerLower);
    if (isYes || isNo) {
      for (const opt of options) {
        const optLower = opt.toLowerCase();
        if (isYes && (optLower.startsWith('yes') || optLower.includes('i am a ') || optLower.includes('i have a ') || optLower.includes('i do'))) return opt;
        if (isNo && (optLower.startsWith('no') || optLower.includes('i am not') || optLower.includes('not a ') || optLower.includes('i do not') || optLower.includes("i don't"))) return opt;
      }
    }
  }

  return null;
}

// ─── Find "decline" fallback option ─────────────────────────────────

function findDeclineOption(options) {
  const declinePatterns = [
    'prefer not to say', 'decline to self-identify', 'decline to answer',
    'prefer not to answer', 'choose not to disclose', 'i prefer not',
    'decline', 'not to say', 'not to disclose'
  ];
  for (const opt of options) {
    const optLower = opt.toLowerCase();
    for (const pattern of declinePatterns) {
      if (optLower.includes(pattern)) return opt;
    }
  }
  return null;
}

// ─── Main entry point ───────────────────────────────────────────────

/**
 * Deterministically match a dropdown/radio question to the best option.
 *
 * @param {string} questionText - The form question label
 * @param {string[]} options - Available dropdown/radio options
 * @param {Array} qaList - User's saved Q&A list [{question, answer}, ...]
 * @param {Object} profile - User's resume profile
 * @returns {{ matched: boolean, option: string|null, topic: string|null }}
 */
function deterministicFieldMatcher(questionText, options, qaList, profile) {
  // Step 1: Detect topic
  const topic = detectTopic(questionText);
  if (!topic) {
    return { matched: false, option: null, topic: null };
  }

  // Step 2: Find saved answer for this topic
  let savedAnswer = findQAAnswer(topic, qaList);
  if (!savedAnswer) {
    savedAnswer = findProfileAnswer(topic, profile);
  }

  // Step 3: If user has a saved answer, match it to an option
  if (savedAnswer) {
    const match = matchAnswerToOption(savedAnswer, options, topic);
    if (match) {
      return { matched: true, option: match, topic };
    }
  }

  // Step 4: No saved answer or no match — try "decline" for demographics
  const demographicTopics = ['gender', 'gender_identity', 'sexual_orientation', 'race_ethnicity', 'veteran', 'disability', 'hispanic_latino', 'pronouns'];
  if (demographicTopics.includes(topic)) {
    const decline = findDeclineOption(options);
    if (decline && !savedAnswer) {
      // Only use decline if user has NO answer saved — if they saved one but it didn't match, fall through to AI
      return { matched: true, option: decline, topic };
    }
  }

  // Step 5: Couldn't match deterministically — return topic so caller knows it's a known type
  return { matched: false, option: null, topic };
}

export { deterministicFieldMatcher, detectTopic, normalize };
