// aiService.js — AI provider abstraction + prompt templates
// Only imported by background.js service worker

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const DEFAULT_TEMPERATURE = 0.3;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;
const DEFAULT_PROVIDER = 'anthropic';

// ─── Provider Registry ──────────────────────────────────────────────

const PROVIDERS = {
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

async function callAI(provider, apiKey, messages, options = {}) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown provider: ${provider}`);

  const params = {
    model: options.model || config.defaultModel,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: options.maxTokens || 4096
  };

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      return await dispatchCall(config, apiKey, messages, params);
    } catch (e) {
      lastError = e;
      if (e.status === 429) continue; // retry rate limits
      throw e;
    }
  }
  throw lastError;
}

function dispatchCall(config, apiKey, messages, params) {
  switch (config.apiStyle) {
    case 'anthropic': return fetchAnthropic(config, apiKey, messages, params);
    case 'openai':    return fetchOpenAI(config, apiKey, messages, params);
    case 'gemini':    return fetchGemini(config, apiKey, messages, params);
    case 'cohere':    return fetchCohere(config, apiKey, messages, params);
    default: throw new Error(`Unsupported API style: ${config.apiStyle}`);
  }
}

function throwAPIError(status, body) {
  const err = new Error(`API error ${status}: ${body}`);
  err.status = status;
  throw err;
}

// ─── Anthropic adapter ──────────────────────────────────────────────

async function fetchAnthropic(config, apiKey, messages, params) {
  const resp = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
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
  return data.content?.[0]?.text || '';
}

// ─── OpenAI-compatible adapter (OpenAI, Groq, Cerebras, Together, OpenRouter, Mistral, DeepSeek) ──

async function fetchOpenAI(config, apiKey, messages, params) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`
  };
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
  return data.choices?.[0]?.message?.content || '';
}

// ─── Google Gemini adapter ──────────────────────────────────────────

async function fetchGemini(config, apiKey, messages, params) {
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const url = `${config.endpoint}/${params.model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: {
        temperature: params.temperature,
        maxOutputTokens: params.maxTokens
      }
    })
  });
  if (!resp.ok) throwAPIError(resp.status, await resp.text());
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─── Cohere adapter ─────────────────────────────────────────────────

async function fetchCohere(config, apiKey, messages, params) {
  const resp = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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
  const content = data.message?.content;
  if (Array.isArray(content)) return content.map(c => c.text).join('');
  return content || '';
}

// ─── JSON response parser (handles markdown-fenced responses) ───────

function parseJSONResponse(text) {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch (_) { /* fall through */ }

  // Strip markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch (_) { /* fall through */ }
  }

  // Try to find first { ... } or [ ... ] block
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch (_) { /* fall through */ }
  }

  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      return JSON.parse(arrMatch[0]);
    } catch (_) { /* fall through */ }
  }

  throw new Error('Could not parse JSON from AI response');
}

// ─── Prompt templates ───────────────────────────────────────────────

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

function buildJobAnalysisPrompt(resumeData, jobDescription, jobTitle, company) {
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

function buildAutofillPrompt(resumeData, qaList, formFields) {
  const resumeText = typeof resumeData === 'string'
    ? resumeData
    : JSON.stringify(resumeData, null, 2);

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

function buildDropdownMatchPrompt(profileData, qaList, questionText, options) {
  // Filter to only Q&A entries with non-empty answers
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

function buildCoverLetterPrompt(resumeData, jobDescription, analysis) {
  const resumeText = typeof resumeData === 'string' ? resumeData : JSON.stringify(resumeData, null, 2);
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

function buildBulletRewritePrompt(resumeData, jobDescription, missingSkills) {
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

function buildTestPrompt() {
  return [
    {
      role: 'user',
      content: 'Respond with exactly: {"status":"ok","message":"Connection successful"}'
    }
  ];
}

// ─── Exports (for service worker import) ────────────────────────────

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
