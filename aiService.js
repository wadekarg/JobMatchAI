/**
 * @file aiService.js
 * @description AI provider abstraction layer for JobMatch AI.
 *
 * This module is the single point of contact for all AI API interactions within
 * the extension. It supports 10+ providers:
 *   - Anthropic (Claude)     — proprietary API style, custom auth headers
 *   - OpenAI                 — OpenAI chat completions style (the de-facto standard)
 *   - Google Gemini          — unique REST style; API key passed as a URL query param
 *   - Groq                   — OpenAI-compatible endpoint, very fast inference
 *   - Cerebras               — OpenAI-compatible endpoint, hardware-accelerated
 *   - Together AI             — OpenAI-compatible endpoint, open-source model hosting
 *   - OpenRouter             — OpenAI-compatible aggregator; requires extra referrer headers
 *   - Mistral AI             — OpenAI-compatible endpoint
 *   - DeepSeek               — OpenAI-compatible endpoint
 *   - Cohere                 — proprietary v2 chat API style, array content blocks
 *
 * Key responsibilities:
 *   1. Maintaining the canonical provider registry (PROVIDERS) with endpoints,
 *      model lists, key placeholders, and API style tags.
 *   2. Routing calls through the correct HTTP adapter based on `apiStyle`.
 *   3. Retrying failed requests on rate-limit (HTTP 429) with exponential back-off.
 *   4. Parsing AI responses that may contain raw JSON or markdown-fenced JSON blocks.
 *   5. Providing typed prompt-builder functions for every use-case in the extension
 *      (resume parsing, job analysis, autofill, cover letter, bullet rewrite, etc.).
 *
 * This file is only imported by background.js (the extension service worker). It
 * uses ES module exports and must not be included in a regular <script> tag context.
 */

// ─── Global constants ────────────────────────────────────────────────

/** Default model ID used when no provider-specific model is requested. */
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

/**
 * Default sampling temperature applied to all providers unless overridden.
 * 0.3 keeps responses focused and deterministic without being fully greedy.
 */
const DEFAULT_TEMPERATURE = 0.3;

/** Maximum number of additional retry attempts after the initial call fails. */
const MAX_RETRIES = 2;

/**
 * Base delay in milliseconds between retry attempts.
 * The actual delay doubles with each attempt (exponential back-off):
 *   attempt 1 → 1000 ms, attempt 2 → 2000 ms.
 */
const RETRY_DELAY_MS = 1000;

/** Provider key used when no explicit provider is specified by the caller. */
const DEFAULT_PROVIDER = 'anthropic';

// ─── Provider Registry ──────────────────────────────────────────────
//
// Each entry in PROVIDERS describes a single AI provider. Fields:
//   name          — Human-readable label shown in the extension UI.
//   apiStyle      — Selects which HTTP adapter function to use:
//                     'anthropic' → fetchAnthropic
//                     'openai'    → fetchOpenAI  (also used by Groq, Cerebras,
//                                   Together, OpenRouter, Mistral, DeepSeek)
//                     'gemini'    → fetchGemini
//                     'cohere'    → fetchCohere
//   endpoint      — Base URL for the provider's chat API.
//   keyPlaceholder — Prefix hint shown in the API key input field.
//   hint          — User-facing tooltip explaining where to obtain the key.
//   free          — Whether the provider offers a free tier (used to badge the UI).
//   models        — Ordered list of { id, name } objects available for selection.
//   defaultModel  — Model ID pre-selected when the user first picks this provider.
//   extraHeaders  — (optional) Additional HTTP headers merged into every request.
//                   Only defined for providers that require them (e.g. OpenRouter).
//
// ────────────────────────────────────────────────────────────────────

const PROVIDERS = {

  // ── Anthropic (Claude) ────────────────────────────────────────────
  // Uses a proprietary request/response format (not OpenAI-compatible).
  // Auth: custom 'x-api-key' header (not 'Authorization: Bearer').
  // Requires 'anthropic-version' header to pin the API contract.
  // Requires 'anthropic-dangerous-direct-browser-access' header because
  // the Anthropic SDK normally blocks browser-side calls as a security
  // measure; this header explicitly opts the caller in to direct access.
  anthropic: {
    name: 'Anthropic (Claude)',
    apiStyle: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    keyPlaceholder: 'sk-ant-api03-...',
    hint: 'Get key at console.anthropic.com',
    free: false,
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
    ],
    defaultModel: 'claude-sonnet-4-20250514',
  },

  // ── OpenAI ────────────────────────────────────────────────────────
  // The canonical OpenAI Chat Completions API. Many other providers
  // mirror this schema, making it the de-facto industry standard.
  // Auth: 'Authorization: Bearer <key>' header.
  // Response path: choices[0].message.content
  openai: {
    name: 'OpenAI',
    apiStyle: 'openai',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    keyPlaceholder: 'sk-...',
    hint: 'Get key at platform.openai.com/api-keys',
    free: false,
    models: [
      { id: 'gpt-4.1', name: 'GPT-4.1' },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'o4-mini', name: 'o4-mini (Reasoning)' },
      { id: 'o3-mini', name: 'o3-mini (Reasoning)' },
    ],
    defaultModel: 'gpt-4.1',
  },

  // ── Google Gemini ─────────────────────────────────────────────────
  // Uses Google's own GenerativeLanguage REST API — NOT OpenAI-compatible.
  // Quirks:
  //   - The API key is appended as a '?key=...' query parameter in the URL,
  //     rather than being placed in an Authorization header.
  //   - The model ID is embedded in the URL path, not in the request body.
  //   - Message roles use 'user' / 'model' (not 'user' / 'assistant').
  //   - Token limit field is 'maxOutputTokens' (not 'max_tokens').
  //   - Response path: candidates[0].content.parts[0].text
  gemini: {
    name: 'Google (Gemini)',
    apiStyle: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',
    keyPlaceholder: 'AIza...',
    hint: 'Get key at aistudio.google.com/apikey — Free tier available',
    free: true,
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite' },
    ],
    defaultModel: 'gemini-2.5-flash',
  },

  // ── Groq ──────────────────────────────────────────────────────────
  // OpenAI-compatible endpoint backed by Groq's LPU hardware.
  // Notably fast inference; hosts open-source models (Llama, Qwen).
  // Auth: 'Authorization: Bearer <key>' (same as OpenAI).
  groq: {
    name: 'Groq',
    apiStyle: 'openai',
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    keyPlaceholder: 'gsk_...',
    hint: 'Get key at console.groq.com — Free tier available',
    free: true,
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B' },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B' },
      { id: 'qwen/qwen3-32b', name: 'Qwen 3 32B' },
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B' },
    ],
    defaultModel: 'llama-3.3-70b-versatile',
  },

  // ── Cerebras ──────────────────────────────────────────────────────
  // OpenAI-compatible endpoint running on Cerebras wafer-scale hardware.
  // Optimised for throughput; hosts open-source models.
  // Auth: 'Authorization: Bearer <key>' (same as OpenAI).
  cerebras: {
    name: 'Cerebras',
    apiStyle: 'openai',
    endpoint: 'https://api.cerebras.ai/v1/chat/completions',
    keyPlaceholder: 'csk-...',
    hint: 'Get key at cloud.cerebras.ai — Free tier available',
    free: true,
    models: [
      { id: 'llama3.1-8b', name: 'Llama 3.1 8B' },
      { id: 'gpt-oss-120b', name: 'GPT-OSS 120B' },
      { id: 'qwen-3-235b-a22b-instruct-2507', name: 'Qwen 3 235B Instruct' },
      { id: 'zai-glm-4.7', name: 'Z.ai GLM 4.7' },
    ],
    defaultModel: 'llama3.1-8b',
  },

  // ── Together AI ───────────────────────────────────────────────────
  // OpenAI-compatible endpoint for hosting and running open-source models.
  // Provides free credits on signup for experimentation.
  // Auth: 'Authorization: Bearer <key>' (same as OpenAI).
  together: {
    name: 'Together AI',
    apiStyle: 'openai',
    endpoint: 'https://api.together.xyz/v1/chat/completions',
    keyPlaceholder: 'tok_...',
    hint: 'Get key at api.together.ai — Free credits on signup',
    free: true,
    models: [
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B Turbo' },
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', name: 'Llama 3.1 8B Turbo' },
      { id: 'Qwen/Qwen2.5-72B-Instruct-Turbo', name: 'Qwen 2.5 72B Turbo' },
      { id: 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B', name: 'DeepSeek R1 70B' },
    ],
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },

  // ── OpenRouter ────────────────────────────────────────────────────
  // OpenAI-compatible aggregator that proxies requests to many backends.
  // Unique among providers here because it requires two extra headers:
  //   'HTTP-Referer' — identifies the calling application for rate-limit
  //                    attribution and their analytics dashboard.
  //   'X-Title'      — human-readable app name shown in OpenRouter's UI.
  // These are injected via the extraHeaders field and merged at call time.
  // Auth: 'Authorization: Bearer <key>' (same as OpenAI).
  openrouter: {
    name: 'OpenRouter',
    apiStyle: 'openai',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    keyPlaceholder: 'sk-or-...',
    hint: 'Get key at openrouter.ai — Aggregator with free models',
    free: true,
    extraHeaders: { 'HTTP-Referer': 'https://github.com/wadekarg/JobMatchAI', 'X-Title': 'JobMatch AI' },
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (Free)' },
      { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash (Free)' },
      { id: 'deepseek/deepseek-chat-v3-0324:free', name: 'DeepSeek V3 (Free)' },
      { id: 'qwen/qwen-2.5-72b-instruct:free', name: 'Qwen 2.5 72B (Free)' },
    ],
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
  },

  // ── Mistral AI ────────────────────────────────────────────────────
  // OpenAI-compatible endpoint from Mistral. Includes reasoning models
  // (Magistral series) alongside standard chat and code-specialised models.
  // Auth: 'Authorization: Bearer <key>' (same as OpenAI).
  mistral: {
    name: 'Mistral AI',
    apiStyle: 'openai',
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    keyPlaceholder: 'M...',
    hint: 'Get key at console.mistral.ai — Free tier available',
    free: true,
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large 3' },
      { id: 'mistral-small-latest', name: 'Mistral Small 3.2' },
      { id: 'magistral-medium-1-2-25-09', name: 'Magistral Medium (Reasoning)' },
      { id: 'magistral-small-1-2-25-09', name: 'Magistral Small (Reasoning)' },
      { id: 'codestral-25-08', name: 'Codestral' },
    ],
    defaultModel: 'mistral-large-latest',
  },

  // ── DeepSeek ──────────────────────────────────────────────────────
  // OpenAI-compatible endpoint from DeepSeek. Offers both a standard chat
  // model (V3) and a chain-of-thought reasoning model (R1).
  // Auth: 'Authorization: Bearer <key>' (same as OpenAI).
  deepseek: {
    name: 'DeepSeek',
    apiStyle: 'openai',
    endpoint: 'https://api.deepseek.com/chat/completions',
    keyPlaceholder: 'sk-...',
    hint: 'Get key at platform.deepseek.com — Very affordable',
    free: false,
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1' },
    ],
    defaultModel: 'deepseek-chat',
  },

  // ── Cohere ────────────────────────────────────────────────────────
  // Uses Cohere's proprietary v2 Chat API — NOT OpenAI-compatible.
  // Quirks:
  //   - Response body structure differs: the text lives at
  //     message.content, which is an array of content blocks
  //     (each block has a 'text' property). The adapter joins them.
  //   - Auth: 'Authorization: Bearer <key>' (same header name as OpenAI,
  //     but the response shape is entirely different).
  cohere: {
    name: 'Cohere',
    apiStyle: 'cohere',
    endpoint: 'https://api.cohere.com/v2/chat',
    keyPlaceholder: '...',
    hint: 'Get key at dashboard.cohere.com — Free trial tier',
    free: true,
    models: [
      { id: 'command-a-03-2025', name: 'Command A' },
      { id: 'command-r-plus-08-2024', name: 'Command R+' },
      { id: 'command-r-08-2024', name: 'Command R' },
      { id: 'command-r7b-12-2024', name: 'Command R 7B (Fast)' },
    ],
    defaultModel: 'command-a-03-2025',
  },
};

// ─── Main AI call router with retry ─────────────────────────────────

/**
 * Public entry point for all AI calls. Resolves the provider config, builds
 * the final params object, and delegates to `dispatchCall` with automatic
 * exponential back-off retry on HTTP 429 (rate limit) errors.
 *
 * @param {string} provider  - Key into PROVIDERS (e.g. 'anthropic', 'openai').
 * @param {string} apiKey    - User-supplied API key for the chosen provider.
 * @param {Array<{role: string, content: string}>} messages
 *                           - Conversation messages in OpenAI role/content format.
 *                             Adapters translate this to provider-specific formats
 *                             where needed (e.g. Gemini uses 'model' instead of
 *                             'assistant', and structures content as parts arrays).
 * @param {Object} [options] - Optional overrides.
 * @param {string} [options.model]       - Model ID to use instead of the provider default.
 * @param {number} [options.temperature] - Sampling temperature (0–1). Defaults to DEFAULT_TEMPERATURE.
 * @param {number} [options.maxTokens]   - Maximum tokens in the response. Defaults to 4096.
 * @returns {Promise<string>} The text content of the AI's response.
 * @throws {Error} If the provider key is unknown, if a non-429 API error occurs,
 *                 or if all retry attempts are exhausted.
 */
async function callAI(provider, apiKey, messages, options = {}) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  // Consolidate call parameters, falling back to provider and global defaults.
  const params = {
    model: options.model || config.defaultModel,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: options.maxTokens || 4096
  };

  let lastError;
  // Attempt the call up to (1 + MAX_RETRIES) times total.
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential back-off: 1 s, 2 s, 4 s, … capped by MAX_RETRIES.
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      return await dispatchCall(config, apiKey, messages, params);
    } catch (e) {
      lastError = e;
      // Only retry on rate-limit errors (429); surface all other errors immediately.
      if (e.status === 429) continue; // retry rate limits
      throw e;
    }
  }
  // All retry attempts exhausted — re-throw the last captured error.
  throw lastError;
}

// ─── callAI dispatcher ───────────────────────────────────────────────
//
// dispatchCall acts as a simple strategy router: it inspects the provider's
// `apiStyle` tag and calls the corresponding fetch adapter. This decouples the
// retry logic in callAI from the per-provider HTTP details.
//
// Why a separate function (not inlined in callAI)?
//   Keeps the retry loop clean and makes it easy to add new API styles
//   without touching the retry/back-off code.
//

/**
 * Routes a prepared API call to the appropriate provider-specific fetch adapter.
 *
 * @param {Object} config   - Provider config object from PROVIDERS.
 * @param {string} apiKey   - User-supplied API key.
 * @param {Array}  messages - Messages array in OpenAI role/content format.
 * @param {Object} params   - Resolved call parameters (model, temperature, maxTokens).
 * @returns {Promise<string>} The response text from the provider.
 * @throws {Error} If config.apiStyle is not a recognised adapter name.
 */
function dispatchCall(config, apiKey, messages, params) {
  switch (config.apiStyle) {
    case 'anthropic': return fetchAnthropic(config, apiKey, messages, params);
    case 'openai':    return fetchOpenAI(config, apiKey, messages, params);
    case 'gemini':    return fetchGemini(config, apiKey, messages, params);
    case 'cohere':    return fetchCohere(config, apiKey, messages, params);
    default: throw new Error(`Unsupported API style: ${config.apiStyle}`);
  }
}

/**
 * Creates and throws a normalised API error with the HTTP status attached as
 * a property so that the retry logic in callAI can inspect it.
 *
 * @param {number} status - HTTP status code returned by the provider.
 * @param {string} body   - Raw response body text (for inclusion in the message).
 * @throws {Error} Always throws; never returns.
 */
function throwAPIError(status, body) {
  const err = new Error(`API error ${status}: ${body}`);
  // Attach the numeric status so callers can branch on specific codes (e.g. 429).
  err.status = status;
  throw err;
}

// ─── Anthropic adapter ──────────────────────────────────────────────
//
// The Anthropic Messages API has its own request/response schema that differs
// from the OpenAI standard in several ways:
//   - Auth header is 'x-api-key' (lowercase, no 'Bearer' prefix).
//   - An 'anthropic-version' header is mandatory to pin the API version.
//   - 'anthropic-dangerous-direct-browser-access: true' is required when
//     calling the API directly from a browser/extension context because
//     Anthropic's SDK normally blocks non-server origins as a CSRF safeguard.
//   - Request body uses 'max_tokens' (same name as OpenAI, different position).
//   - Response text lives at data.content[0].text (an array of content blocks).
//

/**
 * Calls the Anthropic Claude Messages API.
 *
 * @param {Object} config   - Anthropic provider config from PROVIDERS.
 * @param {string} apiKey   - Anthropic API key (format: sk-ant-api03-...).
 * @param {Array}  messages - Messages in OpenAI role/content format.
 * @param {Object} params   - Resolved call params (model, temperature, maxTokens).
 * @returns {Promise<string>} The text from the first content block of the response.
 */
async function fetchAnthropic(config, apiKey, messages, params) {
  const resp = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Anthropic uses a custom 'x-api-key' header, not the standard 'Authorization: Bearer'.
      'x-api-key': apiKey,
      // Required header to pin the API contract version for Anthropic's Messages API.
      'anthropic-version': '2023-06-01',
      // Required when calling Anthropic directly from a browser/extension context.
      // Without this, Anthropic's CORS policy blocks the request.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      messages
    })
  });
  if (!resp.ok) throwAPIError(resp.status, await resp.text());
  const data = await resp.json();
  // Anthropic returns an array of content blocks; extract the text of the first.
  return data.content?.[0]?.text || '';
}

// ─── OpenAI-compatible adapter (OpenAI, Groq, Cerebras, Together, OpenRouter, Mistral, DeepSeek) ──
//
// Many providers expose an API that is structurally identical to OpenAI's Chat
// Completions endpoint. A single adapter handles all of them:
//   - Auth: 'Authorization: Bearer <key>' for all.
//   - Request body: { model, max_tokens, temperature, messages }.
//   - Response text: choices[0].message.content.
//
// The only variation between these providers is the base URL (config.endpoint)
// and, for OpenRouter, the additional 'HTTP-Referer' / 'X-Title' headers stored
// in config.extraHeaders. These are merged into the headers object at call time.
//

/**
 * Calls any OpenAI-compatible Chat Completions endpoint.
 * Used for: OpenAI, Groq, Cerebras, Together AI, OpenRouter, Mistral, DeepSeek.
 *
 * @param {Object} config   - Provider config from PROVIDERS (apiStyle: 'openai').
 * @param {string} apiKey   - Bearer token for the provider.
 * @param {Array}  messages - Messages in OpenAI role/content format.
 * @param {Object} params   - Resolved call params (model, temperature, maxTokens).
 * @returns {Promise<string>} The assistant message content string.
 */
async function fetchOpenAI(config, apiKey, messages, params) {
  const headers = {
    'Content-Type': 'application/json',
    // Standard Bearer token auth used by all OpenAI-compatible providers.
    'Authorization': `Bearer ${apiKey}`
  };
  // Merge any provider-specific extra headers (e.g. OpenRouter's HTTP-Referer and X-Title).
  if (config.extraHeaders) Object.assign(headers, config.extraHeaders);

  const resp = await fetch(config.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.maxTokens,
      temperature: params.temperature,
      messages
    })
  });
  if (!resp.ok) throwAPIError(resp.status, await resp.text());
  const data = await resp.json();
  // Standard OpenAI response path; all compatible providers mirror this structure.
  return data.choices?.[0]?.message?.content || '';
}

// ─── Google Gemini adapter ──────────────────────────────────────────
//
// The Gemini GenerativeLanguage REST API differs from OpenAI in several ways:
//   - The API key is passed as a URL query parameter (?key=...) rather than in
//     a request header. No Authorization header is sent at all.
//   - The model ID is embedded in the URL path
//     (e.g. /v1beta/models/gemini-2.5-flash:generateContent),
//     not in the request body.
//   - Message roles must be 'user' or 'model'; Gemini does not accept 'assistant'.
//     The adapter translates 'assistant' → 'model' before sending.
//   - Message content is structured as an array of 'parts' objects
//     (e.g. [{ text: "..." }]) rather than a plain string.
//   - The generation config uses 'maxOutputTokens' (not 'max_tokens').
//   - Response text lives at candidates[0].content.parts[0].text.
//

/**
 * Calls the Google Gemini GenerateContent API.
 *
 * @param {Object} config   - Gemini provider config from PROVIDERS.
 * @param {string} apiKey   - Google AI Studio API key (format: AIza...).
 * @param {Array}  messages - Messages in OpenAI role/content format.
 * @param {Object} params   - Resolved call params (model, temperature, maxTokens).
 * @returns {Promise<string>} The generated text from the first candidate's first part.
 */
async function fetchGemini(config, apiKey, messages, params) {
  // Convert from OpenAI message format to Gemini's 'contents' format.
  // 'assistant' role must become 'model' — Gemini rejects 'assistant'.
  // Content is wrapped in a parts array as Gemini supports multi-modal inputs.
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));

  // Gemini's URL embeds both the model name and the action in the path.
  // The API key is appended as a query parameter — no Authorization header used.
  const url = `${config.endpoint}/${params.model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: params.temperature,
        // Gemini uses 'maxOutputTokens' where OpenAI uses 'max_tokens'.
        maxOutputTokens: params.maxTokens
      }
    })
  });
  if (!resp.ok) throwAPIError(resp.status, await resp.text());
  const data = await resp.json();
  // Gemini response: candidates array → first candidate → content → parts array → first part text.
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─── Cohere adapter ─────────────────────────────────────────────────
//
// Cohere's v2 Chat API is NOT OpenAI-compatible. Key differences:
//   - Auth uses 'Authorization: Bearer <key>' (same header name as OpenAI),
//     but the request and response bodies are different.
//   - Response text is at data.message.content, which is an array of content
//     blocks (each with a 'text' field). The adapter joins all blocks.
//     If content is not an array (future-proofing), it is returned directly.
//

/**
 * Calls the Cohere v2 Chat API.
 *
 * @param {Object} config   - Cohere provider config from PROVIDERS.
 * @param {string} apiKey   - Cohere API key.
 * @param {Array}  messages - Messages in OpenAI role/content format.
 * @param {Object} params   - Resolved call params (model, temperature, maxTokens).
 * @returns {Promise<string>} The concatenated text from all response content blocks.
 */
async function fetchCohere(config, apiKey, messages, params) {
  const resp = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Cohere uses 'Authorization: Bearer' like OpenAI, but the API schema differs.
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: params.model,
      messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens
    })
  });
  if (!resp.ok) throwAPIError(resp.status, await resp.text());
  const data = await resp.json();
  // Cohere v2 returns content as an array of typed blocks; join all text blocks.
  const content = data.message?.content;
  if (Array.isArray(content)) return content.map(c => c.text).join('');
  return content || '';
}

// ─── JSON response parser (handles markdown-fenced responses) ───────
//
// AI models frequently wrap their JSON output in markdown code fences
// (```json ... ```) even when instructed not to. This function attempts
// four progressively looser parse strategies before giving up:
//   1. Direct JSON.parse — handles clean responses.
//   2. Strip ``` fences — handles the most common markdown wrapping.
//   3. Extract first {...} block — handles responses with prose before/after.
//   4. Extract first [...] block — handles array-valued responses with prose.
//

/**
 * Parses a JSON value from an AI response string that may contain markdown
 * code fences or surrounding prose.
 *
 * @param {string} text - Raw text returned by the AI model.
 * @returns {*} The parsed JavaScript value (object, array, etc.).
 * @throws {Error} If no valid JSON can be extracted by any strategy.
 */
function parseJSONResponse(text) {
  // Strategy 1: Try direct parse first — cheapest path for clean responses.
  try {
    return JSON.parse(text);
  } catch (_) { /* fall through */ }

  // Strategy 2: Strip markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch (_) { /* fall through */ }
  }

  // Strategy 3: Try to find first { ... } or [ ... ] block
  // Handles cases where the model prefixes/suffixes the JSON with explanation text.
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch (_) { /* fall through */ }
  }

  // Strategy 4: Try to find a top-level JSON array if no object was found.
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch (_) { /* fall through */ }
  }

  // All strategies exhausted — the response cannot be parsed as JSON.
  throw new Error('Could not parse JSON from AI response');
}

// ─── Prompt templates ───────────────────────────────────────────────
//
// Each buildXxxPrompt function constructs the `messages` array that is passed
// to callAI. All prompts use only a single 'user' turn (no system prompt) to
// maximise compatibility across providers, some of which handle system prompts
// differently or not at all.
//
// Prompts include explicit JSON schema examples and formatting rules to reduce
// the likelihood of the model wrapping its response in prose or markdown.
//

// ─── Prompt: Resume Parser ────────────────────────────────────────

/**
 * Builds a prompt that instructs the model to extract structured data from
 * raw resume text and return it as a typed JSON object.
 *
 * The JSON schema covers all common resume sections: contact info, summary,
 * skills, experience, education, certifications, and projects. Fields that
 * are absent in the source text should be returned as empty strings or arrays,
 * ensuring the downstream code can always access every key without null checks.
 *
 * @param {string} rawText - Plain text extracted from the user's resume file.
 * @returns {Array<{role: string, content: string}>} A single-message messages array.
 */
function buildResumeParsePrompt(rawText) {
  return [
    {
      role: 'user',
      content: `Parse this resume text into structured JSON. Extract all information you can find.

Return ONLY a JSON object with this structure (use empty strings/arrays for missing fields):
{
  "name": "Full Name",
  "email": "email@example.com",
  "phone": "phone number",
  "location": "City, State",
  "linkedin": "LinkedIn URL",
  "website": "portfolio/website URL",
  "summary": "professional summary",
  "skills": ["skill1", "skill2"],
  "experience": [
    {
      "title": "Job Title",
      "company": "Company Name",
      "dates": "Start - End",
      "description": "responsibilities and achievements"
    }
  ],
  "education": [
    {
      "degree": "Degree Name",
      "school": "School Name",
      "dates": "Start - End",
      "details": "GPA, honors, relevant coursework"
    }
  ],
  "certifications": ["cert1", "cert2"],
  "projects": [
    {
      "name": "Project Name",
      "description": "what it does",
      "technologies": ["tech1", "tech2"]
    }
  ]
}

Resume text:
${rawText}`
    }
  ];
}

// ─── Prompt: Job Analysis ────────────────────────────────────────

/**
 * Builds a prompt that asks the model to compare a candidate's resume against
 * a specific job posting and return a structured match analysis.
 *
 * The returned JSON includes a numeric match score (0–100), lists of matching
 * and missing skills, actionable recommendations, and an insights block with
 * strength/gap summaries and ATS keyword suggestions.
 *
 * @param {Object|string} resumeData    - Parsed resume object or raw resume text.
 * @param {string}        jobDescription - Full text of the job posting.
 * @param {string}        [jobTitle]     - Job title extracted from the posting.
 * @param {string}        [company]      - Company name extracted from the posting.
 * @returns {Array<{role: string, content: string}>} A single-message messages array.
 */
function buildJobAnalysisPrompt(resumeData, jobDescription, jobTitle, company) {
  // Accept either a pre-parsed resume object or a raw string, normalising to text.
  const resumeText = typeof resumeData === 'string' ? resumeData : JSON.stringify(resumeData, null, 2);
  return [
    {
      role: 'user',
      content: `Analyze how well this resume matches the job posting. Be specific and actionable.

Return ONLY a JSON object:
{
  "matchScore": 75,
  "matchingSkills": ["skill1", "skill2"],
  "missingSkills": ["skill3", "skill4"],
  "recommendations": [
    "Specific recommendation 1",
    "Specific recommendation 2"
  ],
  "insights": {
    "strengths": "What makes this candidate strong for this role",
    "gaps": "Key gaps to address",
    "keywords": ["important ATS keywords to include"]
  }
}

RESUME:
${resumeText}

JOB TITLE: ${jobTitle || 'Not specified'}
COMPANY: ${company || 'Not specified'}
JOB DESCRIPTION:
${jobDescription}`
    }
  ];
}

// ─── Prompt: Autofill ─────────────────────────────────────────────

/**
 * Builds a prompt for filling out a structured job application form.
 *
 * This is the most complex prompt in the file. It encodes strict behavioural
 * rules to ensure the model acts as a deterministic selector rather than a
 * creative generator:
 *   - Dropdown and radio fields: the model MUST return an option that exists
 *     character-for-character in the available_options list.
 *   - Demographic fields (gender, race, etc.): if no saved answer exists, the
 *     model must default to "Prefer not to say" / "Decline to self-identify"
 *     rather than guessing.
 *   - Text fields: generated using resume data and saved Q&A; fabrication is
 *     explicitly prohibited.
 *   - The sentinel value "NEEDS_USER_INPUT" signals that the extension should
 *     prompt the user rather than auto-fill.
 *
 * @param {Object|string}          resumeData  - Parsed resume object or raw text.
 * @param {Array<{question, answer}>} qaList   - User's saved Q&A pairs.
 * @param {Array<Object>}          formFields  - Detected form fields with metadata
 *                                               (question_id, field_type, available_options).
 * @returns {Array<{role: string, content: string}>} A single-message messages array.
 */
function buildAutofillPrompt(resumeData, qaList, formFields) {
  const resumeText = typeof resumeData === 'string'
    ? resumeData
    : JSON.stringify(resumeData, null, 2);

  // Flatten saved Q&A pairs into a readable block for the model.
  const qaText = (qaList || [])
    .map(qa => `Q: ${qa.question}\nA: ${qa.answer}`)
    .join('\n\n');

  return [
    {
      role: 'user',
      content: `
You are a STRICT deterministic job application form selector.

Your job is to SELECT — not generate — values for structured fields.

========================================================
ABSOLUTE RULES (VIOLATION BREAKS AUTOMATION)
========================================================

1) DROPDOWN & RADIO FIELDS
--------------------------------
- You MUST return exactly one value from available_options.
- The selected_option MUST match an option character-for-character.
- You MUST NOT output saved QA text directly unless it exactly matches an available option.
- You MUST NOT invent text.
- You MUST NOT paraphrase options.
- If no reasonable semantic match exists → return "NEEDS_USER_INPUT".

2) SEMANTIC MATCHING LOGIC (MANDATORY)
--------------------------------
Step 1: Find matching saved Q&A by meaning.
Step 2: Compare that saved answer to available_options.
Step 3: Choose the option closest in meaning.

Examples:
Saved: "Male"
Options: ["Man", "Woman"] → pick "Man"

Saved: "Heterosexual"
Options: ["Straight/Heterosexual", "Bisexual"] → pick "Straight/Heterosexual"

Saved: "No"
Options: ["No, I am not a protected veteran", "I am a veteran"] → pick full matching sentence.

If multiple close matches → choose most specific.

3) DEMOGRAPHIC SAFETY
--------------------------------
If question is about:
- Gender
- Race
- Sexual orientation
- Veteran status
- Disability

AND user has NO saved QA answer →
Select:
"Prefer not to say"
or
"Decline to self-identify"
if available.

If not available → return NEEDS_USER_INPUT.

4) TEXTAREA / SHORT TEXT
--------------------------------
- Generate professional answers using resume + saved QA.
- NEVER fabricate experience.
- For phone/email/name/address fields: use the profile data directly.
- If insufficient data → NEEDS_USER_INPUT.

5) CHECKBOX
--------------------------------
Return:
"Yes" → to check
"No"  → to leave unchecked

6) VALIDATION STEP (CRITICAL)
--------------------------------
Before finalizing dropdown/radio answer:
- Confirm selected_option exists in available_options EXACTLY.
If not → return NEEDS_USER_INPUT.

========================================================
OUTPUT FORMAT (STRICT JSON ONLY)
========================================================

{
  "answers": [
    {
      "question_id": "",
      "field_type": "",
      "selected_option": "",
      "generated_text": ""
    }
  ]
}

Rules:
- For dropdown/radio → use selected_option only.
- For textarea → use generated_text only.
- Do NOT include explanations.
- Do NOT include markdown.
- Do NOT include extra fields.
- Return valid JSON only.

========================================================
USER PROFILE:
${resumeText}

========================================================
SAVED Q&A:
${qaText || 'None'}

========================================================
FORM FIELDS:
${JSON.stringify(formFields, null, 2)}
`
    }
  ];
}

// ─── Prompt: Dropdown matcher ─────────────────────────────────────

/**
 * Builds a focused single-question prompt for matching a saved Q&A answer to
 * one specific dropdown's available options.
 *
 * This is used for targeted re-attempts when the bulk autofill prompt produces
 * an invalid selection for a single dropdown/radio field. It applies the same
 * semantic matching rules as the autofill prompt but for a single question at
 * a time, making it easier for the model to reason carefully.
 *
 * Notable rules encoded in the prompt:
 *   - The model must return the exact option text, character-for-character.
 *   - The model must NOT include quotes, the option number, or explanations.
 *   - The sentinel value "SKIP" is returned if no reasonable match exists.
 *   - Demographic defaults ("Prefer not to say") apply here too.
 *
 * @param {Object|string|null}     profileData  - User profile/resume data for context.
 * @param {Array<{question, answer}>} qaList    - User's saved Q&A pairs.
 * @param {string}                 questionText - The form question label text.
 * @param {string[]}               options      - The dropdown's available option strings.
 * @returns {Array<{role: string, content: string}>} A single-message messages array.
 */
function buildDropdownMatchPrompt(profileData, qaList, questionText, options) {
  // Filter to only Q&A entries with non-empty answers to reduce noise in the prompt.
  const relevantQA = (qaList || []).filter(qa => qa.answer && qa.answer.trim());
  const qaText = relevantQA.map(qa => `Q: ${qa.question}\nA: ${qa.answer}`).join('\n\n');
  const profileText = profileData ? (typeof profileData === 'string' ? profileData : JSON.stringify(profileData)) : '';

  return [
    {
      role: 'user',
      content: `You must select ONE option from the list below for this job application question.

FORM QUESTION: "${questionText}"

OPTIONS (copy your answer character-for-character from this list):
${options.map((o, i) => `${i + 1}. ${o}`).join('\n')}

USER'S SAVED Q&A ANSWERS:
${qaText || 'None saved'}

USER PROFILE:
${profileText || 'None'}

STEP-BY-STEP INSTRUCTIONS:
1. Read the form question carefully.
2. Search the saved Q&A answers above for one that matches this question's TOPIC.
   - "Gender" in Q&A matches "I identify my gender as" on the form.
   - "Race / Ethnicity" in Q&A matches "I identify my race/ethnicity as" on the form.
   - "Veteran status" in Q&A matches "Veteran Status" on the form.
   - "Disability status" in Q&A matches "I have a disability" on the form.
   - "Sexual orientation" in Q&A matches "I identify my sexual orientation as" on the form.
3. Take the user's saved ANSWER for that topic.
4. Find the numbered option above that is CLOSEST IN MEANING to that answer.
   - Saved "Male" or "Man" → pick the option containing "Man" (NOT non-binary, NOT woman)
   - Saved "Female" or "Woman" → pick the option containing "Woman"
   - Saved "Indian" or "South Asian" → pick the option containing "South Asian" (NOT Central Asian, NOT East Asian)
   - Saved "No" for veteran → pick option containing "No" or "not a veteran"
   - Saved "No" for disability → pick option containing "No"
   - Saved "Straight" or "Heterosexual" → pick option containing "Straight" or "Heterosexual"
   - Saved "Cisgender" → pick option containing "Cisgender"
5. If the user has NO saved answer for this topic AND this is a demographic question →
   pick "Prefer not to say" or "Decline to self-identify" if available.
6. If truly no match → return: SKIP

RETURN ONLY the exact option text from the numbered list above.
No quotes. No explanation. No number. Just the option text exactly as written.`
    }
  ];
}

// ─── Prompt: Cover Letter ────────────────────────────────────────

/**
 * Builds a prompt that generates a tailored cover letter body for a specific
 * job application.
 *
 * The prompt enforces strict structural and stylistic rules:
 *   - Exactly 3 paragraphs (opening, skills match, closing CTA).
 *   - 200–250 words — long enough to be substantive, short enough to be read.
 *   - No address headers, date lines, salutations, signatures, or placeholders.
 *   - Must reference specific skills from the resume and the actual job/company.
 *   - Output is plain text only — no JSON, no markdown.
 *
 * The top 6 matching skills from the prior job analysis are injected to help
 * the model focus on the most relevant talking points.
 *
 * @param {Object|string} resumeData     - Parsed resume object or raw text.
 * @param {string}        jobDescription - Full text of the job posting.
 * @param {Object|null}   [analysis]     - Job analysis result from buildJobAnalysisPrompt
 *                                         (used to extract pre-computed matchingSkills).
 * @returns {Array<{role: string, content: string}>} A single-message messages array.
 */
function buildCoverLetterPrompt(resumeData, jobDescription, analysis) {
  const resumeText = typeof resumeData === 'string' ? resumeData : JSON.stringify(resumeData, null, 2);
  // Limit to 6 skills to keep the prompt focused and avoid overwhelming the model.
  const matchingSkills = (analysis?.matchingSkills || []).slice(0, 6).join(', ');
  return [
    {
      role: 'user',
      content: `Write a professional cover letter for this job application.

RULES:
- Exactly 3 paragraphs: compelling opening (why this role/company), skills + experience match (reference 2-3 specific skills from the resume), closing call to action
- Tailored to the actual job title and company — no generic filler
- 200-250 words. No clichés like "I am a hard worker"
- Do NOT include address headers, date lines, "Dear Hiring Manager", signature, or any [placeholders]
- Start directly with the first sentence of paragraph one

RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}

CANDIDATE'S MATCHING SKILLS: ${matchingSkills || 'see resume'}

Return ONLY the cover letter body text. No JSON, no markdown, no extra commentary.`
    }
  ];
}

// ─── Prompt: Bullet rewriter ─────────────────────────────────────

/**
 * Builds a prompt that rewrites existing resume experience bullets to better
 * align with a target job description.
 *
 * Key constraints:
 *   - The model must rewrite existing bullets, not fabricate new ones.
 *   - Missing skills from the job analysis are supplied so the model can
 *     weave them in where they genuinely fit.
 *   - Job description is truncated to 3000 characters to stay within token limits
 *     while retaining the most important keywords near the top of the JD.
 *   - Output is a JSON array of { job, original, improved } objects.
 *
 * @param {Object|string} resumeData      - Parsed resume object or raw text.
 *                                          If an object, the experience array is
 *                                          used to build a readable text block.
 * @param {string}        jobDescription  - Full text of the job posting (truncated to 3000 chars).
 * @param {string[]}      [missingSkills] - Skills identified as gaps in the job analysis.
 * @returns {Array<{role: string, content: string}>} A single-message messages array.
 */
function buildBulletRewritePrompt(resumeData, jobDescription, missingSkills) {
  // Build a human-readable experience summary from structured data if available,
  // otherwise fall back to raw text or JSON serialisation.
  const experience = (typeof resumeData === 'object' && resumeData.experience)
    ? resumeData.experience.map(e => `${e.title || ''} at ${e.company || ''}:\n${e.description || ''}`).join('\n\n')
    : (typeof resumeData === 'string' ? resumeData : JSON.stringify(resumeData));
  const missing = (missingSkills || []).join(', ');

  return [
    {
      role: 'user',
      content: `Suggest improved resume bullet points to better match this job description.

RULES:
- Rewrite existing bullets — never fabricate experience, numbers, or results that aren't already implied
- Weave in JD keywords and action verbs naturally
- Focus especially on incorporating these missing skills where they fit: ${missing || 'none identified'}
- Return JSON only — no markdown, no commentary

CURRENT EXPERIENCE:
${experience}

JOB DESCRIPTION (excerpt):
${jobDescription.substring(0, 3000)}

Return ONLY a JSON array:
[
  {
    "job": "Job Title at Company",
    "original": "The original bullet text",
    "improved": "The improved bullet with better keywords"
  }
]`
    }
  ];
}

// ─── Prompt: Connection test ──────────────────────────────────────

/**
 * Builds a minimal prompt used to verify that a provider API key is valid and
 * the endpoint is reachable. The model is instructed to return a fixed JSON
 * response, making it trivial to confirm the round-trip succeeded.
 *
 * @returns {Array<{role: string, content: string}>} A single-message messages array.
 */
function buildTestPrompt() {
  return [
    {
      role: 'user',
      content: 'Respond with exactly: {"status":"ok","message":"Connection successful"}'
    }
  ];
}

// ─── Exports (for service worker import) ────────────────────────────
//
// All public symbols are exported as named exports for use by background.js.
// This file uses ES module syntax (export {}) and is loaded as a module
// script in the extension's service worker manifest entry.
//

export {
  callAI,
  PROVIDERS,
  parseJSONResponse,
  buildResumeParsePrompt,
  buildJobAnalysisPrompt,
  buildAutofillPrompt,
  buildDropdownMatchPrompt,
  buildCoverLetterPrompt,
  buildBulletRewritePrompt,
  buildTestPrompt,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  DEFAULT_PROVIDER
};
