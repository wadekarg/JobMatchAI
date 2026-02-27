// background.js — Service worker: message routing + AI API calls
import {
  callAI,
  PROVIDERS,
  parseJSONResponse,
  buildResumeParsePrompt,
  buildJobAnalysisPrompt,
  buildAutofillPrompt,
  buildDropdownMatchPrompt,
  buildTestPrompt,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  DEFAULT_PROVIDER
} from './aiService.js';

import { deterministicFieldMatcher } from './deterministicMatcher.js';

// ─── Settings helpers ───────────────────────────────────────────────

async function getSettings() {
  const result = await chrome.storage.local.get('aiSettings');
  return result.aiSettings || {
    provider: DEFAULT_PROVIDER,
    apiKey: '',
    model: DEFAULT_MODEL,
    temperature: DEFAULT_TEMPERATURE
  };
}

async function getProfile() {
  const result = await chrome.storage.local.get('profile');
  return result.profile || null;
}

async function getQAList() {
  const result = await chrome.storage.local.get('qaList');
  return result.qaList || [];
}

async function getSavedJobs() {
  const result = await chrome.storage.local.get('savedJobs');
  return result.savedJobs || [];
}

// ─── AI operation handlers ──────────────────────────────────────────

async function handleTestConnection() {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No API key configured');

  const messages = buildTestPrompt();
  const result = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0,
    maxTokens: 100
  });
  return parseJSONResponse(result);
}

async function handleParseResume(rawText) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No API key configured. Go to Profile → AI Settings.');

  const messages = buildResumeParsePrompt(rawText);
  const result = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0.1,
    maxTokens: 4096
  });
  return parseJSONResponse(result);
}

async function handleAnalyzeJob(jobDescription, jobTitle, company) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No API key configured. Go to Profile → AI Settings.');

  const profile = await getProfile();
  if (!profile) throw new Error('No resume profile found. Upload your resume first.');

  // Truncate long job descriptions
  const maxLen = 8000;
  const truncatedJD = jobDescription.length > maxLen
    ? jobDescription.substring(0, maxLen) + '\n...[truncated]'
    : jobDescription;

  const messages = buildJobAnalysisPrompt(profile, truncatedJD, jobTitle, company);
  const result = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0
  });
  return parseJSONResponse(result);
}

async function handleGenerateAutofill(formFields) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No API key configured. Go to Profile → AI Settings.');

  const profile = await getProfile();
  if (!profile) throw new Error('No resume profile found. Upload your resume first.');

  const qaList = await getQAList();
  const messages = buildAutofillPrompt(profile, qaList, formFields);
  const result = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0,
    maxTokens: 4096
  });
  return parseJSONResponse(result);
}

async function handleMatchDropdown(questionText, options) {
  const profile = await getProfile();
  const qaList = await getQAList();

  // ── Step 1: Try deterministic matching FIRST (no AI call) ──
  const deterMatch = deterministicFieldMatcher(questionText, options, qaList, profile);
  if (deterMatch.matched && deterMatch.option) {
    console.log('[JobMatch BG] Deterministic match:', deterMatch.topic, '→', deterMatch.option);
    return deterMatch.option;
  }

  // ── Step 2: Fall back to AI only if deterministic failed ──
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('No API key configured.');

  console.log('[JobMatch BG] AI fallback for:', questionText, '(topic:', deterMatch.topic || 'unknown', ')');
  const messages = buildDropdownMatchPrompt(profile, qaList, questionText, options);
  const result = await callAI(settings.provider, settings.apiKey, messages, {
    model: settings.model,
    temperature: 0,
    maxTokens: 200
  });
  const aiChoice = result.trim().replace(/^["']|["']$/g, '');

  // ── Step 3: Validate AI's choice exists in the actual options ──
  const choiceLower = aiChoice.toLowerCase().trim();
  for (const opt of options) {
    if (opt.toLowerCase().trim() === choiceLower) return opt;
  }
  // Partial match validation
  for (const opt of options) {
    const optLower = opt.toLowerCase().trim();
    if (optLower.includes(choiceLower) || choiceLower.includes(optLower)) return opt;
  }

  console.warn('[JobMatch BG] AI returned unmatched option:', aiChoice, 'from:', options);
  return aiChoice;
}

async function handleSaveJob(jobData) {
  const jobs = await getSavedJobs();
  const job = {
    id: Date.now().toString(),
    title: jobData.title || 'Unknown Position',
    company: jobData.company || 'Unknown Company',
    location: jobData.location || '',
    salary: jobData.salary || '',
    score: jobData.score || 0,
    url: jobData.url || '',
    date: new Date().toISOString().split('T')[0],
    analysis: jobData.analysis || null
  };
  jobs.unshift(job);
  // Keep max 100 jobs
  if (jobs.length > 100) jobs.length = 100;
  await chrome.storage.local.set({ savedJobs: jobs });
  return job;
}

async function handleDeleteJob(jobId) {
  const jobs = await getSavedJobs();
  const filtered = jobs.filter(j => j.id !== jobId);
  await chrome.storage.local.set({ savedJobs: filtered });
  return { success: true };
}

// ─── Applied jobs helpers ────────────────────────────────────────

async function getAppliedJobs() {
  const result = await chrome.storage.local.get('appliedJobs');
  return result.appliedJobs || [];
}

async function handleMarkApplied(jobData) {
  const jobs = await getAppliedJobs();
  // Dedup by URL
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
  };
  jobs.unshift(job);
  // Cap at 500
  if (jobs.length > 500) jobs.length = 500;
  await chrome.storage.local.set({ appliedJobs: jobs });
  return job;
}

async function handleDeleteAppliedJob(jobId) {
  const jobs = await getAppliedJobs();
  const filtered = jobs.filter(j => j.id !== jobId);
  await chrome.storage.local.set({ appliedJobs: filtered });
  return { success: true };
}

// ─── Message router ─────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(result => sendResponse({ success: true, data: result }))
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true; // keep channel open for async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    // AI operations
    case 'TEST_CONNECTION':
      return handleTestConnection();

    case 'PARSE_RESUME':
      return handleParseResume(message.rawText);

    case 'ANALYZE_JOB':
      return handleAnalyzeJob(message.jobDescription, message.jobTitle, message.company);

    case 'GENERATE_AUTOFILL':
      return handleGenerateAutofill(message.formFields);

    case 'MATCH_DROPDOWN':
      return handleMatchDropdown(message.questionText, message.options);

    // Storage operations
    case 'SAVE_PROFILE':
      await chrome.storage.local.set({ profile: message.profile });
      return { success: true };

    case 'GET_PROFILE':
      return getProfile();

    case 'SAVE_SETTINGS':
      await chrome.storage.local.set({ aiSettings: message.settings });
      return { success: true };

    case 'GET_SETTINGS':
      return getSettings();

    case 'SAVE_QA_LIST':
      await chrome.storage.local.set({ qaList: message.qaList });
      return { success: true };

    case 'GET_QA_LIST':
      return getQAList();

    case 'SAVE_JOB':
      return handleSaveJob(message.jobData);

    case 'DELETE_JOB':
      return handleDeleteJob(message.jobId);

    case 'GET_SAVED_JOBS':
      return getSavedJobs();

    case 'MARK_APPLIED':
      return handleMarkApplied(message.jobData);

    case 'GET_APPLIED_JOBS':
      return getAppliedJobs();

    case 'DELETE_APPLIED_JOB':
      return handleDeleteAppliedJob(message.jobId);

    case 'OPEN_PROFILE_TAB': {
      const hash = message.hash ? '#' + message.hash : '';
      await chrome.tabs.create({ url: chrome.runtime.getURL('profile.html' + hash) });
      return { success: true };
    }

    case 'GET_PROVIDERS':
      return PROVIDERS;

    // Tab forwarding (popup → content script)
    case 'TOGGLE_PANEL':
    case 'TRIGGER_ANALYZE':
    case 'TRIGGER_AUTOFILL':
      return forwardToActiveTab(message);

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

async function forwardToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  return chrome.tabs.sendMessage(tab.id, message);
}

// ─── Extension install handler ──────────────────────────────────────

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      aiSettings: {
        provider: DEFAULT_PROVIDER,
        apiKey: '',
        model: DEFAULT_MODEL,
        temperature: DEFAULT_TEMPERATURE
      },
      profile: null,
      qaList: [],
      savedJobs: [],
      appliedJobs: []
    });
  }
});
