/**
 * @file background.js
 * @description Service worker for the JobMatchAI Chrome extension.
 *
 * ROLE IN EXTENSION ARCHITECTURE
 * --------------------------------
 * This file is the central nervous system of the extension. It runs as a
 * Manifest V3 service worker — a persistent-free background context that is
 * spun up on demand and torn down when idle. Because it has no DOM access and
 * no direct connection to any tab, ALL communication with popup pages, the
 * profile page, and content scripts flows through the Chrome runtime messaging
 * API. This file owns the single `onMessage` listener that receives every
 * inter-component message and dispatches it to the correct handler.
 *
 * KEY RESPONSIBILITIES
 * ---------------------
 * 1. Settings / storage helpers  — thin wrappers around chrome.storage.local
 *    that provide typed defaults so callers never receive undefined.
 *
 * 2. AI operation handlers       — each handler loads the user's settings and
 *    profile from storage, builds the appropriate prompt via aiService.js, fires
 *    the AI call through callAI(), and returns a structured result. Handlers are
 *    intentionally kept thin: prompt construction lives in aiService.js and
 *    deterministic logic lives in deterministicMatcher.js.
 *
 * 3. Saved-jobs & applied-jobs CRUD — persist job records to chrome.storage.local
 *    with deduplication, capping, and timestamping.
 *
 * 4. Message router (handleMessage) — a single async switch that maps every
 *    message.type string to a handler function and wraps the result in a
 *    uniform `{ success, data }` / `{ success, error }` envelope.
 *
 * 5. Tab forwarding               — relays certain popup-originated messages
 *    (e.g. TOGGLE_PANEL, TRIGGER_AUTOFILL) straight through to the active tab's
 *    content script, since the popup cannot address content scripts directly.
 *
 * 6. Extension install bootstrap  — seeds chrome.storage.local with safe
 *    defaults on first install so every other component can assume the keys exist.
 *
 * DEPENDENCIES
 * ------------
 * - ./aiService.js            : prompt builders, callAI(), provider list, defaults
 * - ./deterministicMatcher.js : rule-based dropdown matcher (avoids AI calls for
 *                               common field patterns like yes/no, gender, etc.)
 */

// ─── Imports ────────────────────────────────────────────────────────────────

import JSZip from './libs/jszip.esm.js';
import {
  callAI,           // Core function that sends a message array to the chosen AI provider
  PROVIDERS,        // Array of supported provider descriptors (id, name, models, …)
  parseJSONResponse, // Strips markdown fences and JSON.parses an AI text response
  buildResumeParsePrompt,   // Builds the prompt that extracts structured data from raw resume text
  buildJobAnalysisPrompt,   // Builds the prompt that scores/analyses a JD against the user's profile
  buildAutofillPrompt,      // Builds the prompt that maps form fields to profile data
  buildDropdownMatchPrompt, // Builds the prompt that selects the best option from a dropdown list
  buildCoverLetterPrompt,   // Builds the prompt that writes a tailored cover letter
  buildBulletRewritePrompt, // Builds the prompt that rewrites resume bullets to target a specific JD
  buildSingleBulletRewritePrompt, // Builds the prompt to regenerate a single bullet
  buildCustomBulletPrompt, // Builds the prompt to create a new bullet from a description
  buildTestPrompt,          // Builds a minimal "ping" prompt used to validate AI connectivity
  DEFAULT_MODEL,        // Fallback model identifier when the user has not configured one
  DEFAULT_TEMPERATURE,  // Fallback temperature value (typically 0 or 0.7)
  DEFAULT_PROVIDER      // Fallback provider id (e.g. 'openai')
} from './aiService.js';

// Rule-based matcher that resolves common dropdown questions without an AI call
import { deterministicFieldMatcher } from './deterministicMatcher.js';


// ─── Settings helpers ────────────────────────────────────────────────────────
//
// These four functions are thin read-only wrappers around chrome.storage.local.
// They always return a safe default so callers never have to guard against
// undefined / missing keys.  Write paths go directly through the message router
// (SAVE_PROFILE, SAVE_SETTINGS, etc.) to keep mutations explicit.

/**
 * Retrieves the user's AI provider settings from local storage.
 *
 * Returns a fully-populated settings object even when nothing has been saved
 * yet, using the defaults exported by aiService.js.  This prevents downstream
 * AI handlers from having to handle partial objects.
 *
 * @async
 * @returns {Promise<{provider: string, apiKey: string, model: string, temperature: number}>}
 *   The stored aiSettings object, or a default object if none exists.
 */
async function getSettings() {
  // Destructure just the 'aiSettings' key from storage to avoid loading the
  // entire storage object into memory.
  const result = await chrome.storage.local.get('aiSettings');
  return result.aiSettings || {
    provider: DEFAULT_PROVIDER,
    apiKey: '',
    model: DEFAULT_MODEL,
    temperature: DEFAULT_TEMPERATURE
  };
}

/**
 * Retrieves the user's parsed resume profile from local storage.
 *
 * The profile is a structured object produced by handleParseResume() and stored
 * under the 'profile' key.  Returns null when no resume has been uploaded yet,
 * which lets callers throw a user-friendly error instead of crashing.
 *
 * @async
 * @returns {Promise<Object|null>} The stored profile object, or null if absent.
 */
async function getProfile() {
  const result = await chrome.storage.local.get('profile');
  return result.profile || null;
}

/**
 * Retrieves the user's custom Q&A list from local storage.
 *
 * The Q&A list is an array of { question, answer } pairs that the user has
 * manually added to improve autofill accuracy for fields the AI would otherwise
 * have to guess from the resume alone.
 *
 * @async
 * @returns {Promise<Array<{question: string, answer: string}>>}
 *   The stored qaList array, or an empty array if none exists.
 */
async function getQAList() {
  const result = await chrome.storage.local.get('qaList');
  return result.qaList || [];
}

/**
 * Retrieves the list of jobs the user has bookmarked / saved for later.
 *
 * Saved jobs are capped at 100 entries (enforced in handleSaveJob).  Each entry
 * contains metadata such as title, company, score, and the full analysis object
 * returned by handleAnalyzeJob.
 *
 * @async
 * @returns {Promise<Array<Object>>} The stored savedJobs array, or [] if absent.
 */
async function getSavedJobs() {
  const result = await chrome.storage.local.get('savedJobs');
  return result.savedJobs || [];
}


// ─── AI operation handlers ───────────────────────────────────────────────────
//
// Each handler follows the same pattern:
//   1. Load settings (and optionally profile / qaList) from storage.
//   2. Guard: throw a user-readable error if a prerequisite is missing.
//   3. Build the prompt via the appropriate helper from aiService.js.
//   4. Fire callAI() with the configured provider, key, and options.
//   5. Parse / validate the response and return plain data to the router.
//
// Handlers are async and never call sendResponse themselves — the router wraps
// their return values in the standard { success, data } envelope.

/**
 * Fires a minimal "hello" request to the configured AI provider to confirm that
 * the API key is valid and the network is reachable.
 *
 * Uses temperature 0 and a small token budget because the response content is
 * not displayed to the user — only success / failure matters.
 *
 * @async
 * @throws {Error} If no API key is configured in settings.
 * @returns {Promise<Object>} Parsed JSON response from the AI (typically { ok: true }).
 */
async function handleTestConnection() {
  const settings = await getSettings();
  // An empty API key would result in a 401 from the provider; surface this
  // immediately with a clear message rather than letting the HTTP call fail.
  if (!settings.apiKey) throw new Error('No API key configured');

  const messages = buildTestPrompt(); // Returns a minimal [{ role, content }] array
  const result = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0,     // Deterministic — we only care about structural validity
    maxTokens: 100      // Tiny budget: the test prompt expects a one-liner JSON reply
  });
  return parseJSONResponse(result);
}

/**
 * Parses raw resume text into a structured profile object using the AI.
 *
 * The resulting profile is used by virtually every other AI handler (job
 * analysis, autofill, cover letter, bullet rewrite) so it must be comprehensive.
 * A higher maxTokens ceiling (4096) is used to avoid truncating profiles for
 * candidates with extensive work histories.
 *
 * @async
 * @param {string} rawText - Plain-text content extracted from the uploaded resume file.
 * @throws {Error} If no API key is configured.
 * @returns {Promise<Object>} Structured profile (name, contact, experience[], skills[], etc.).
 */
async function handleParseResume(rawText) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No API key configured. Go to Profile → AI Settings.');

  const messages = buildResumeParsePrompt(rawText);
  const result = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0.1, // Very low temperature: we want factual extraction, not creativity
    maxTokens: 4096   // Large ceiling to accommodate verbose resumes
  });
  return parseJSONResponse(result);
}

/**
 * Analyses a job description against the user's resume profile to produce a
 * match score, skill gap report, and tailored recommendations.
 *
 * Long job descriptions are truncated to 8 000 characters before being sent to
 * the AI to stay within context limits.  A `jdTruncated` flag is added to the
 * parsed result so the UI can display a warning when truncation occurred.
 *
 * @async
 * @param {string} jobDescription - Raw text of the job posting.
 * @param {string} jobTitle       - Job title extracted from the posting.
 * @param {string} company        - Company name extracted from the posting.
 * @throws {Error} If no API key is configured or no profile has been uploaded.
 * @returns {Promise<Object>} Analysis object including score, gaps, highlights, etc.
 */
async function handleAnalyzeJob(jobDescription, jobTitle, company) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No API key configured. Go to Profile → AI Settings.');

  const profile = await getProfile();
  if (!profile) throw new Error('No resume profile found. Upload your resume first.');

  // Truncate long job descriptions to avoid exceeding model context windows.
  // 8 000 chars is a conservative limit that leaves room for the system prompt
  // and the profile data that are also injected into the same request.
  const maxLen = 8000;
  const truncatedJD = jobDescription.length > maxLen
    ? jobDescription.substring(0, maxLen) + '\n...[truncated]'
    : jobDescription;

  const messages = buildJobAnalysisPrompt(profile, truncatedJD, jobTitle, company);
  const result = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0 // Analysis should be fully deterministic — no creative variation
  });
  const parsed = parseJSONResponse(result);
  // Annotate the result so the UI can inform the user that analysis was partial
  if (jobDescription.length > maxLen) parsed.jdTruncated = true;
  if (jobDescription.length > maxLen) parsed.truncated = true;
  return parsed;
}

/**
 * Generates autofill answers for a set of detected form fields using the AI.
 *
 * The Q&A list supplements the profile: it provides explicit user-supplied
 * answers for questions the AI might otherwise answer incorrectly (e.g. salary
 * expectations, visa sponsorship, relocation willingness).
 *
 * @async
 * @param {Array<Object>} formFields - Array of form field descriptors detected
 *   by the content script (label, type, name, options, etc.).
 * @throws {Error} If no API key is configured or no profile has been uploaded.
 * @returns {Promise<Object>} Map of field identifiers to suggested fill values.
 */
async function handleGenerateAutofill(formFields) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No API key configured. Go to Profile → AI Settings.');

  const profile = await getProfile();
  if (!profile) throw new Error('No resume profile found. Upload your resume first.');

  // Q&A list provides explicit overrides that improve accuracy for personal /
  // preference fields that cannot be inferred from the resume alone.
  const qaList = await getQAList();
  const messages = buildAutofillPrompt(profile, qaList, formFields);
  const result = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0,     // Deterministic — we want consistent field mappings
    maxTokens: 4096     // Forms can have many fields; allow a large response
  });
  return parseJSONResponse(result);
}

/**
 * Selects the best matching option from a dropdown list for a given question.
 *
 * Uses a two-stage strategy to minimise unnecessary AI calls:
 *   Stage 1 — Deterministic matching via deterministicFieldMatcher().  Handles
 *              well-known field patterns (yes/no, gender, pronouns, work auth,
 *              etc.) using rule-based logic.  Zero AI tokens consumed on a hit.
 *   Stage 2 — AI fallback if the deterministic stage fails.  The AI response is
 *              then validated against the actual option list (exact match first,
 *              then partial) to prevent the AI from hallucinating an invalid value.
 *
 * @async
 * @param {string}   questionText - The label or question text of the dropdown.
 * @param {string[]} options      - The list of available option strings.
 * @throws {Error} If Stage 2 is reached and no API key is configured.
 * @returns {Promise<string|null>}
 *   The matched option string, or null if neither stage produced a valid match.
 */
async function handleMatchDropdown(questionText, options) {
  const profile = await getProfile();
  const qaList = await getQAList();

  // ── Stage 1: Try deterministic matching FIRST (no AI call) ──────────────
  // deterministicFieldMatcher returns { matched: bool, option: string|null }.
  // A hit here saves an API round-trip and avoids latency on common fields.
  const deterMatch = deterministicFieldMatcher(questionText, options, qaList, profile);
  if (deterMatch.matched && deterMatch.option) {
    return deterMatch.option;
  }

  // ── Stage 2: Fall back to AI only if deterministic matching failed ───────
  // Settings are loaded lazily here to avoid the async storage read when the
  // deterministic path succeeds (the common case for well-known fields).
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No API key configured.');

  const messages = buildDropdownMatchPrompt(profile, qaList, questionText, options);
  const result = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0,   // Must be deterministic — selecting a wrong option is worse than null
    maxTokens: 200    // The AI only needs to echo one option back; keep the budget small
  });
  // Strip surrounding quotes that some models include (e.g. "Yes" → Yes)
  const aiChoice = result.trim().replace(/^["']|["']$/g, '');

  // ── Stage 3: Validate AI's choice exists in the actual options ───────────
  // Prevent the AI from returning a hallucinated / rephrased value that would
  // break the form fill.  Try exact case-insensitive match first.
  const choiceLower = aiChoice.toLowerCase().trim();
  for (const opt of options) {
    if (opt.toLowerCase().trim() === choiceLower) return opt;
  }
  // Partial match as a secondary fallback: catches minor wording differences
  // (e.g. "United States" vs "United States of America").
  for (const opt of options) {
    const optLower = opt.toLowerCase().trim();
    if (optLower.includes(choiceLower) || choiceLower.includes(optLower)) return opt;
  }

  // AI returned something that doesn't match any option — leave field unfilled
  // rather than submitting a wrong value.
  return null;
}

/**
 * Saves a job posting to the user's saved-jobs list in local storage.
 *
 * A unique numeric ID is generated from Date.now() to guarantee uniqueness
 * within the session.  New jobs are prepended (unshift) so the list is
 * chronologically descending.  The list is hard-capped at 100 entries by
 * truncating the array in place after insertion.
 *
 * @async
 * @param {Object} jobData - Raw job data from the content script / popup.
 * @param {string} [jobData.title]    - Job title.
 * @param {string} [jobData.company]  - Company name.
 * @param {string} [jobData.location] - Job location.
 * @param {string} [jobData.salary]   - Salary range or description.
 * @param {number} [jobData.score]    - Match score (0–100).
 * @param {string} [jobData.url]      - URL of the job posting.
 * @param {Object} [jobData.analysis] - Full analysis object from handleAnalyzeJob.
 * @returns {Promise<Object>} The normalised job record that was persisted.
 */
async function handleSaveJob(jobData) {
  const jobs = await getSavedJobs();
  const job = {
    id: Date.now().toString(), // String ID derived from epoch ms — unique enough for local storage
    title: jobData.title || 'Unknown Position',
    company: jobData.company || 'Unknown Company',
    location: jobData.location || '',
    salary: jobData.salary || '',
    score: jobData.score || 0,
    url: jobData.url || '',
    date: new Date().toISOString().split('T')[0], // Store date only (YYYY-MM-DD), not time
    analysis: jobData.analysis || null             // Full analysis blob; may be null for quick-saves
  };
  // Prepend so the UI shows the most recently saved job at the top
  jobs.unshift(job);
  // Keep max 100 jobs — truncate the array in place to avoid unnecessary copies
  if (jobs.length > 100) jobs.length = 100;
  // Persist the updated array back to storage
  await chrome.storage.local.set({ savedJobs: jobs });
  return job;
}

/**
 * Removes a saved job from the saved-jobs list by its ID.
 *
 * @async
 * @param {string} jobId - The `id` field of the job record to remove.
 * @returns {Promise<{success: true}>} Confirmation object.
 */
async function handleDeleteJob(jobId) {
  const jobs = await getSavedJobs();
  // Filter creates a new array without the target job; then persist
  const filtered = jobs.filter(j => j.id !== jobId);
  await chrome.storage.local.set({ savedJobs: filtered });
  return { success: true };
}


// ─── Applied jobs helpers ────────────────────────────────────────────────────
//
// Applied jobs are a separate list from saved jobs.  They represent postings the
// user has actually submitted an application for.  The list is capped at 500
// entries (higher than saved jobs) and deduplicated by URL.

/**
 * Retrieves the list of jobs the user has marked as applied from local storage.
 *
 * @async
 * @returns {Promise<Array<Object>>} The stored appliedJobs array, or [] if absent.
 */
async function getAppliedJobs() {
  const result = await chrome.storage.local.get('appliedJobs');
  return result.appliedJobs || [];
}

/**
 * Adds a job to the applied-jobs list with URL-based deduplication.
 *
 * If a job with the same URL already exists in the list, the function returns
 * early with `{ success: true, duplicate: true }` rather than creating a second
 * entry.  This prevents accidental double-marking when navigating back to a job
 * page that was already applied to.
 *
 * New entries are prepended and the list is capped at 500 to bound storage use.
 *
 * @async
 * @param {Object} jobData - Job metadata (same shape as handleSaveJob, minus analysis).
 * @returns {Promise<Object>} The new job record, or { success: true, duplicate: true }
 *   if the URL was already present.
 */
async function handleMarkApplied(jobData) {
  const jobs = await getAppliedJobs();
  // Deduplicate by URL: applying to the same posting twice should be a no-op
  if (jobs.some(j => j.url === jobData.url)) {
    return { success: true, duplicate: true };
  }
  const job = {
    id: Date.now().toString(),
    title: jobData.title || 'Unknown Position',
    company: jobData.company || 'Unknown Company',
    location: jobData.location || '',
    salary: jobData.salary || '',
    score: jobData.score || 0,
    url: jobData.url || '',
    date: new Date().toISOString().split('T')[0]
    // Note: analysis is intentionally omitted here to keep the applied list leaner
  };
  // Prepend for chronological descending order
  jobs.unshift(job);
  // Cap at 500 entries — applied list is larger than saved list since users
  // typically apply to many more jobs than they bookmark.
  if (jobs.length > 500) jobs.length = 500;
  await chrome.storage.local.set({ appliedJobs: jobs });
  return job;
}

/**
 * Generates a tailored cover letter for a specific job using the AI.
 *
 * The job description is truncated to 6 000 characters (slightly less than the
 * analysis handler's 8 000 limit) because cover letter prompts include more
 * instructional text that itself consumes context window space.  A higher
 * temperature (0.4) is used here compared with analysis handlers to produce
 * more natural, varied prose.
 *
 * The raw AI text string is returned directly (not JSON-parsed) because a cover
 * letter is unstructured prose rather than a machine-readable object.
 *
 * @async
 * @param {string} jobDescription - Raw text of the job posting.
 * @param {Object} analysis       - Existing analysis object for the job (used to
 *   highlight matching skills and address gaps in the letter).
 * @throws {Error} If no API key is configured or no profile has been uploaded.
 * @returns {Promise<string>} The generated cover letter as a plain text string.
 */
async function handleGenerateCoverLetter(jobDescription, analysis, jobMeta) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No API key configured. Go to Settings.');
  const profile = await getProfile();
  if (!profile) throw new Error('No resume profile found. Upload your resume first.');

  // Cover letter prompts are verbose; use a smaller truncation limit than
  // job analysis to leave more budget for instructions and the profile blob.
  const maxLen = 6000;
  const truncatedJD = jobDescription.length > maxLen
    ? jobDescription.substring(0, maxLen) + '\n...[truncated]'
    : jobDescription;

  const messages = buildCoverLetterPrompt(profile, truncatedJD, analysis, jobMeta);
  // Return the raw AI string — cover letters are prose, not JSON
  const text = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0.4, // Moderate creativity: varied sentences without hallucinated facts
    maxTokens: 700    // ~500 words — a standard single-page cover letter length
  });
  const result = { text };
  if (jobDescription.length > maxLen) result.truncated = true;
  return result;
}

/**
 * Rewrites the user's resume experience bullets to better target a specific job.
 *
 * Before calling the AI, this function validates that the profile contains at
 * least one experience entry with a non-trivial description.  Without existing
 * bullets there is nothing to rewrite, and the AI would produce fabricated
 * content rather than reformulated real content.
 *
 * A try/catch around parseJSONResponse surfaces a clearer error message when
 * the AI response is truncated (which can happen with large profiles on models
 * that have low output token limits).
 *
 * @async
 * @param {string}   jobDescription - Raw text of the target job posting.
 * @param {string[]} missingSkills  - Skills identified as gaps in the job analysis,
 *   used to guide which bullets to emphasise or rewrite.
 * @throws {Error} If no API key is configured, no profile exists, or the profile
 *   has no experience descriptions to rewrite.
 * @returns {Promise<Object>} Structured object containing rewritten bullet arrays
 *   keyed by experience entry.
 */
async function handleRewriteBullets(jobDescription, missingSkills) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No API key configured. Go to Settings.');
  const profile = await getProfile();
  if (!profile) throw new Error('No resume profile found. Upload your resume first.');

  // Guard: ensure the profile has at least one experience entry with a real
  // description.  A description shorter than 10 chars is treated as effectively
  // empty (e.g. placeholder or whitespace).
  const hasExperience = Array.isArray(profile.experience) &&
    profile.experience.some(e => e.description && e.description.trim().length > 10);
  if (!hasExperience) {
    throw new Error('No experience bullets found in your resume profile. Make sure your resume was parsed correctly with job descriptions.');
  }

  const messages = buildBulletRewritePrompt(profile, jobDescription, missingSkills);
  const result = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0.2, // Slight creativity to improve phrasing, but stay factually grounded
    maxTokens: 4096   // Rewrites can be lengthy for candidates with many roles
  });

  // Wrap parseJSONResponse in a try/catch to convert cryptic parse failures into
  // an actionable error message (model output token limits are the most common cause).
  try {
    return parseJSONResponse(result);
  } catch (_) {
    throw new Error('AI response was truncated or invalid. Try a model with a larger output limit.');
  }
}

/**
 * Extracts all text from a DOCX XML paragraph (<w:p>) by concatenating
 * all <w:t> text nodes.
 * @param {string} paragraphXml - Raw XML of a <w:p> element.
 * @returns {string} Concatenated plain text.
 */
function extractParagraphText(paragraphXml) {
  const textMatches = paragraphXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
  return textMatches.map(m => m.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, '')).join('');
}

/**
 * Replaces text in a DOCX XML paragraph preserving formatting runs.
 * Puts all new text into the first <w:t> and clears the rest.
 * @param {string} paragraphXml - Raw XML of a <w:p> element.
 * @param {string} newText - Replacement text.
 * @returns {string} Modified paragraph XML.
 */
function replaceParagraphText(paragraphXml, newText) {
  let first = true;
  const escaped = newText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                         .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  return paragraphXml.replace(/<w:t[^>]*>[^<]*<\/w:t>/g, (match) => {
    if (first) {
      first = false;
      const tag = match.match(/<w:t[^>]*>/)[0];
      const openTag = tag.includes('xml:space') ? tag : '<w:t xml:space="preserve">';
      return openTag + escaped + '</w:t>';
    }
    return match.replace(/>[^<]*</, '><');
  });
}

/**
 * Normalizes text for fuzzy matching.
 * @param {string} str - Input string.
 * @returns {string} Normalized string.
 */
function normalizeForMatch(str) {
  return str.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Generates a tailored DOCX resume by editing the original uploaded DOCX.
 * Replaces experience bullets with rewritten versions and appends missing
 * skills. Returns the modified DOCX as base64.
 *
 * @async
 * @param {Array}    rewrittenBullets - Array of {original, improved} objects.
 * @param {string[]} missingSkills    - Skills identified as gaps.
 * @param {Array}    [customBullets]  - Array of {text, targetSection, targetIdx} for new bullets.
 * @returns {Promise<{base64: string, replacedCount: number, totalBullets: number, insertedCount: number}>}
 */
async function handleGenerateTailoredResume(rewrittenBullets, missingSkills, customBullets) {
  const profile = await getProfile();
  if (!profile) throw new Error('No resume profile found. Upload your resume first.');

  const { rawResumeBase64, resumeFileType } = await chrome.storage.local.get(['rawResumeBase64', 'resumeFileType']);
  if (!rawResumeBase64 || resumeFileType !== 'docx') {
    throw new Error('DOCX_REQUIRED');
  }

  // Decode base64 to ArrayBuffer
  const binaryString = atob(rawResumeBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Unzip the DOCX
  const zip = await JSZip.loadAsync(bytes.buffer);
  const docXmlFile = zip.file('word/document.xml');
  if (!docXmlFile) throw new Error('Invalid DOCX file — word/document.xml not found.');

  let docXml = await docXmlFile.async('string');

  // Replace bullets
  let replacedCount = 0;
  for (const bullet of rewrittenBullets) {
    const normalizedOriginal = normalizeForMatch(bullet.original);
    const paragraphRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
    let match;
    while ((match = paragraphRegex.exec(docXml)) !== null) {
      const paraXml = match[0];
      const paraText = extractParagraphText(paraXml);
      const normalizedPara = normalizeForMatch(paraText);

      if (normalizedPara && normalizedOriginal &&
          (normalizedPara.includes(normalizedOriginal) ||
           normalizedOriginal.includes(normalizedPara)) &&
          normalizedPara.length > 15) {
        const newParaXml = replaceParagraphText(paraXml, bullet.improved);
        docXml = docXml.replace(paraXml, newParaXml);
        replacedCount++;
        break;
      }
    }
  }

  // Add missing skills to the skills paragraph by appending to the last text run
  // (to preserve formatting — the first run is often bold like "Skills:")
  if (missingSkills && missingSkills.length > 0 && profile.skills) {
    const paragraphRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
    let match;
    while ((match = paragraphRegex.exec(docXml)) !== null) {
      const paraXml = match[0];
      const paraText = extractParagraphText(paraXml);
      const skillsFound = profile.skills.filter(s =>
        paraText.toLowerCase().includes(s.toLowerCase())
      );
      if (skillsFound.length >= 3) {
        const newSkills = missingSkills.filter(s =>
          !paraText.toLowerCase().includes(s.toLowerCase())
        );
        if (newSkills.length > 0) {
          const appendText = ', ' + newSkills.join(', ');
          const escaped = appendText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          // Find the last <w:t>...</w:t> and append to it
          const lastTIndex = paraXml.lastIndexOf('</w:t>');
          if (lastTIndex !== -1) {
            const newParaXml = paraXml.substring(0, lastTIndex) + escaped + paraXml.substring(lastTIndex);
            docXml = docXml.replace(paraXml, newParaXml);
          }
        }
        break;
      }
    }
  }

  // Insert custom bullets after the last bullet of their target job/project
  let insertedCount = 0;

  // Build a list of all company/title names to detect section boundaries
  const allSectionNames = [];
  if (profile.experience) {
    profile.experience.forEach(exp => {
      if (exp.company) allSectionNames.push(exp.company.toLowerCase());
      if (exp.title) allSectionNames.push(exp.title.toLowerCase());
    });
  }
  if (profile.projects) {
    profile.projects.forEach(proj => {
      const name = proj.name || proj.title || '';
      if (name) allSectionNames.push(name.toLowerCase());
    });
  }
  // Common resume section headers that signal a new section
  const sectionHeaders = ['education', 'skills', 'projects', 'certifications', 'awards',
    'publications', 'volunteer', 'interests', 'references', 'summary', 'objective',
    'technical skills', 'core competencies', 'professional development'];

  if (customBullets && customBullets.length > 0) {
    for (const custom of customBullets) {
      // Find the target job's title and company to locate it in the DOCX
      let targetText = '';
      if (custom.targetSection === 'experience' && profile.experience?.[custom.targetIdx]) {
        const exp = profile.experience[custom.targetIdx];
        targetText = (exp.company || exp.title || '').toLowerCase();
      } else if (custom.targetSection === 'projects' && profile.projects?.[custom.targetIdx]) {
        const proj = profile.projects[custom.targetIdx];
        targetText = (proj.name || proj.title || '').toLowerCase();
      }

      if (!targetText || !custom.text) continue;

      const paragraphRegex = /<w:p[ >][\s\S]*?<\/w:p>/g;
      let lastContentIdx = -1;
      let lastContentEnd = -1;
      let foundTarget = false;
      let match;

      while ((match = paragraphRegex.exec(docXml)) !== null) {
        const paraText = extractParagraphText(match[0]);
        const paraLower = paraText.toLowerCase().trim();

        // Found the target section
        if (paraLower.includes(targetText)) {
          foundTarget = true;
          continue;
        }

        if (foundTarget) {
          // Check if we've hit a NEW section (another job, project, or section header)
          const hitsNewSection = allSectionNames.some(name =>
            name !== targetText && paraLower.includes(name) && paraLower.length < 100
          );
          const hitsSectionHeader = sectionHeaders.some(h => paraLower === h || paraLower.startsWith(h + ':'));

          if (hitsNewSection || hitsSectionHeader) {
            break; // Stop — we've left the target section
          }

          // Track content paragraphs (skip empty/very short ones)
          if (paraText.trim().length > 10) {
            lastContentIdx = match.index;
            lastContentEnd = match.index + match[0].length;
          }
        }
      }

      if (lastContentIdx !== -1) {
        const lastPara = docXml.substring(lastContentIdx, lastContentEnd);
        const newPara = replaceParagraphText(lastPara, custom.text);
        docXml = docXml.substring(0, lastContentEnd) + newPara + docXml.substring(lastContentEnd);
        insertedCount++;
      }
    }
  }

  // Save modified XML and generate DOCX
  zip.file('word/document.xml', docXml);
  const modifiedDocx = await zip.generateAsync({ type: 'base64' });

  return {
    base64: modifiedDocx,
    replacedCount,
    totalBullets: rewrittenBullets.length,
    insertedCount,
    originalFileName: profile.resumeFileName || 'resume'
  };
}

/**
 * Removes a job from the applied-jobs list by its ID.
 *
 * @async
 * @param {string} jobId - The `id` field of the applied job record to remove.
 * @returns {Promise<{success: true}>} Confirmation object.
 */
async function handleDeleteAppliedJob(jobId) {
  const jobs = await getAppliedJobs();
  const filtered = jobs.filter(j => j.id !== jobId);
  await chrome.storage.local.set({ appliedJobs: filtered });
  return { success: true };
}


// ─── Message router ──────────────────────────────────────────────────────────
//
// The onMessage listener is the single entry point for all inter-component
// communication.  It delegates to handleMessage() which is a plain async
// function (easier to test in isolation than an inline async listener).
//
// Chrome's messaging API is synchronous by default: returning `true` from the
// listener signals that sendResponse will be called asynchronously.  Without
// `return true` Chrome would close the messaging channel before the async
// handler resolves, making sendResponse a no-op.

/**
 * Registers the extension's global message listener.
 *
 * Any component (popup, content script, profile page) that calls
 * `chrome.runtime.sendMessage()` or `chrome.tabs.sendMessage()` targeting this
 * extension will be handled here.  Responses are always wrapped in a uniform
 * envelope:
 *   - Success: `{ success: true,  data: <handler return value> }`
 *   - Failure: `{ success: false, error: <Error.message string> }`
 *
 * @listens chrome.runtime.onMessage
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Kick off the async handler; pipe its resolution/rejection into sendResponse
  // using the standard success/error envelope so callers have a uniform API.
  handleMessage(message, sender)
    .then(result => sendResponse({ success: true, data: result }))
    .catch(err => sendResponse({ success: false, error: err.message }));
  // Return true to keep the message channel open while the async handler runs.
  // Without this, Chrome would garbage-collect sendResponse before the Promise
  // resolves and the caller would never receive a response.
  return true;
});

/**
 * Routes an incoming extension message to the appropriate handler function.
 *
 * Messages are identified by `message.type` (a string constant).  The switch
 * is grouped into four logical sections:
 *   - AI operations   : tasks that require an LLM API call
 *   - Storage ops     : direct read/write of chrome.storage.local
 *   - Job management  : saved & applied job CRUD + cover letter / bullet rewrite
 *   - Tab forwarding  : relay messages from popup to the active content script
 *
 * @async
 * @param {Object} message - The message object sent by the caller.
 * @param {string} message.type - Discriminant string identifying the operation.
 * @param {Object} sender  - Chrome MessageSender describing the originating context.
 * @throws {Error} For unknown message types or when handler prerequisites fail.
 * @returns {Promise<*>} The result value produced by the matched handler.
 */
// ── Handler registry ──────────────────────────────────────────────────────
// Maps message type strings to handler functions. Replaces the former switch
// statement for cleaner routing and easier extensibility.

const handlers = {
  // ── AI operations ──────────────────────────────────────────────────────
  // These handlers all result in at least one HTTP call to an external AI API.

  'TEST_CONNECTION': (msg) => handleTestConnection(),

  'PARSE_RESUME': (msg) => handleParseResume(msg.rawText),

  'ANALYZE_JOB': (msg) => handleAnalyzeJob(msg.jobDescription, msg.jobTitle, msg.company),

  'GENERATE_AUTOFILL': (msg) => handleGenerateAutofill(msg.formFields),

  'MATCH_DROPDOWN': (msg) => handleMatchDropdown(msg.questionText, msg.options),

  // ── Storage operations ─────────────────────────────────────────────────
  // Direct reads and writes to chrome.storage.local; no AI calls involved.

  'SAVE_PROFILE': async (msg) => {
    await chrome.storage.local.set({ profile: msg.profile });
    return { success: true };
  },

  'GET_PROFILE': (msg) => getProfile(),

  'SAVE_SETTINGS': async (msg) => {
    await chrome.storage.local.set({ aiSettings: msg.settings });
    return { success: true };
  },

  'GET_SETTINGS': (msg) => getSettings(),

  'SAVE_QA_LIST': async (msg) => {
    if (msg.qaList && msg.qaList.length > 200) {
      throw new Error('Q&A list is limited to 200 entries. Please remove some before adding new ones.');
    }
    await chrome.storage.local.set({ qaList: msg.qaList });
    return { success: true };
  },

  'GET_QA_LIST': (msg) => getQAList(),

  // ── Job management ─────────────────────────────────────────────────────
  // CRUD operations for saved / applied job lists plus AI-assisted writing.

  'SAVE_JOB': (msg) => handleSaveJob(msg.jobData),

  'DELETE_JOB': (msg) => handleDeleteJob(msg.jobId),

  'GET_SAVED_JOBS': (msg) => getSavedJobs(),

  'GENERATE_COVER_LETTER': (msg) => handleGenerateCoverLetter(msg.jobDescription, msg.analysis, msg.jobMeta),

  'REWRITE_BULLETS': (msg) => handleRewriteBullets(msg.jobDescription, msg.missingSkills),

  'REWRITE_SINGLE_BULLET': async (msg) => {
    const settings = await getSettings();
    if (!settings.apiKey) throw new Error('No API key configured.');
    const messages = buildSingleBulletRewritePrompt(msg.originalBullet, msg.jobDescription, msg.missingSkills, msg.currentEdit);
    const result = await callAI(settings.provider, settings.apiKey, messages, {
      model: settings.model,
      temperature: 0.4,
      maxTokens: 512
    });
    return result.trim();
  },

  'GENERATE_TAILORED_RESUME': (msg) => handleGenerateTailoredResume(msg.rewrittenBullets, msg.missingSkills, msg.customBullets),

  'GENERATE_CUSTOM_BULLET': async (msg) => {
    const settings = await getSettings();
    if (!settings.apiKey) throw new Error('No API key configured.');
    const messages = buildCustomBulletPrompt(msg.description, msg.targetRole, msg.jobDescription, msg.missingSkills);
    const result = await callAI(settings.provider, settings.apiKey, messages, {
      model: settings.model,
      temperature: 0.3,
      maxTokens: 512
    });
    return result.trim();
  },

  'INCREMENT_RESUME_COUNTER': async () => {
    const { tailoredResumeCounter = 0 } = await chrome.storage.local.get('tailoredResumeCounter');
    const next = tailoredResumeCounter + 1;
    await chrome.storage.local.set({ tailoredResumeCounter: next });
    return next;
  },

  'SAVE_RAW_RESUME': async (msg) => {
    await chrome.storage.local.set({ rawResumeBase64: msg.rawResumeBase64, resumeFileType: msg.fileType });
    return { success: true };
  },

  'GET_RAW_RESUME': async () => {
    const data = await chrome.storage.local.get(['rawResumeBase64', 'resumeFileType']);
    return { rawResumeBase64: data.rawResumeBase64 || null, fileType: data.resumeFileType || null };
  },

  'MARK_APPLIED': (msg) => handleMarkApplied(msg.jobData),

  'GET_APPLIED_JOBS': (msg) => getAppliedJobs(),

  'DELETE_APPLIED_JOB': (msg) => handleDeleteAppliedJob(msg.jobId),

  'OPEN_PROFILE_TAB': async (msg) => {
    const hash = msg.hash ? '#' + msg.hash : '';
    await chrome.tabs.create({ url: chrome.runtime.getURL('profile.html' + hash) });
    return { success: true };
  },

  'GET_PROVIDERS': (msg) => PROVIDERS,

  // ── Tab forwarding ─────────────────────────────────────────────────────
  // The popup cannot directly address content scripts (it does not have a
  // tab ID), so these messages are relayed through the service worker which
  // can identify the active tab and forward the message to its content script.

  'TOGGLE_PANEL': (msg) => forwardToActiveTab(msg),

  'TRIGGER_ANALYZE': (msg) => forwardToActiveTab(msg),

  'TRIGGER_AUTOFILL': (msg) => forwardToActiveTab(msg),
};

async function handleMessage(message, sender) {
  const handler = handlers[message.type];
  if (!handler) throw new Error(`Unknown message type: ${message.type}`);
  return handler(message);
}

/**
 * Forwards a message to the content script running in the currently active tab.
 *
 * Used to bridge the popup → service worker → content script communication gap.
 * The popup can only talk to the service worker (via chrome.runtime.sendMessage);
 * it cannot directly invoke chrome.tabs.sendMessage because it does not know
 * which tab is active.  The service worker bridges this gap by querying for the
 * active tab and relaying the original message object unchanged.
 *
 * @async
 * @param {Object} message - The original message object to relay.
 * @throws {Error} If there is no active tab in the current window (e.g. the
 *   user has no normal tab open — only devtools or the extension page itself).
 * @returns {Promise<*>} Whatever the content script's sendMessage handler returns.
 */
async function forwardToActiveTab(message) {
  // Query for exactly one tab: the focused tab in the current browser window
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Guard against edge cases (e.g. only a devtools window is active)
  if (!tab?.id) throw new Error('No active tab found');
  // Forward the original message object to the content script in the active tab
  return chrome.tabs.sendMessage(tab.id, message);
}


// ─── Toolbar icon click handler ──────────────────────────────────────────────
//
// With no default_popup in the manifest, clicking the toolbar icon fires
// chrome.action.onClicked instead of opening a popup. We use this to send a
// TOGGLE_PANEL message directly to the active tab's content script, giving
// users a single-click toggle for the side panel.

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
    } catch (e) {
      // Content script not loaded on this page (e.g. chrome:// pages)
    }
  }
});


// ─── Extension install handler ───────────────────────────────────────────────

/**
 * Seeds chrome.storage.local with safe defaults on first install.
 *
 * This listener fires once when the extension is installed for the first time.
 * It does NOT fire on updates (details.reason === 'update') or on browser
 * startup (details.reason === 'chrome_update') to avoid overwriting data the
 * user has already configured.
 *
 * The storage schema initialised here mirrors every key that the rest of the
 * extension reads, ensuring all `|| default` fallbacks in the getter functions
 * are only a safety net and not the primary data path.
 *
 * @listens chrome.runtime.onInstalled
 * @param {{ reason: string, previousVersion?: string }} details
 *   Object describing why onInstalled fired.
 */
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Seed all storage keys in a single set() call to keep the operation atomic
    chrome.storage.local.set({
      // AI provider configuration — user fills in apiKey via the settings UI
      aiSettings: {
        provider: DEFAULT_PROVIDER,
        apiKey: '',
        model: DEFAULT_MODEL,
        temperature: DEFAULT_TEMPERATURE
      },
      profile: null,                              // No resume uploaded yet
      profileSlots: [null, null, null],           // Three resume slots (multi-profile feature)
      activeProfileSlot: 0,                       // Index of the currently active slot
      slotNames: ['Resume 1', 'Resume 2', 'Resume 3'], // Display names for each slot
      qaList: [],        // Custom Q&A pairs for autofill (empty on fresh install)
      savedJobs: [],     // Bookmarked job postings
      appliedJobs: []    // Jobs the user has submitted applications for
    });
  }
});
