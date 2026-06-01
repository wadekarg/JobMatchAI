import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseAnthropicModels } from '../../aiService.js';
import {
  parseGroqModels,
  parseCerebrasModels,
  parseTogetherModels,
  parseOpenRouterModels,
  parseMistralModels,
  parseDeepSeekModels,
} from '../../aiService.js';

describe('parseAnthropicModels', () => {
  it('maps id + display_name into {id, name}', () => {
    const json = {
      data: [
        { type: 'model', id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
        { type: 'model', id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5' },
      ],
    };
    expect(parseAnthropicModels(json)).toEqual([
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
    ]);
  });

  it('filters out non-claude ids', () => {
    const json = {
      data: [
        { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4' },
        { id: 'some-internal-tool',        display_name: 'Internal' },
      ],
    };
    expect(parseAnthropicModels(json)).toEqual([
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    ]);
  });

  it('returns [] for empty data', () => {
    expect(parseAnthropicModels({ data: [] })).toEqual([]);
    expect(parseAnthropicModels({})).toEqual([]);
  });

  it('falls back to id when display_name is missing', () => {
    const json = { data: [{ id: 'claude-opus-4-20250514' }] };
    expect(parseAnthropicModels(json)).toEqual([
      { id: 'claude-opus-4-20250514', name: 'claude-opus-4-20250514' },
    ]);
  });

  it('returns [] when data is a non-array (defensive against API changes)', () => {
    expect(parseAnthropicModels({ data: 'oops' })).toEqual([]);
    expect(parseAnthropicModels({ data: null })).toEqual([]);
    expect(parseAnthropicModels(null)).toEqual([]);
  });
});

import { parseOpenAIModels } from '../../aiService.js';

describe('parseOpenAIModels', () => {
  it('keeps gpt-, o\\d, and chatgpt- prefixed ids', () => {
    const json = {
      data: [
        { id: 'gpt-4.1' },
        { id: 'gpt-4o' },
        { id: 'o3-mini' },
        { id: 'o4-mini' },
        { id: 'chatgpt-4o-latest' },
      ],
    };
    const out = parseOpenAIModels(json);
    expect(out.map(m => m.id)).toEqual([
      'gpt-4.1', 'gpt-4o', 'o3-mini', 'o4-mini', 'chatgpt-4o-latest',
    ]);
    expect(out.every(m => m.name === m.id)).toBe(true);
  });

  it('drops embeddings, image-gen, audio, moderation, fine-tunes', () => {
    const json = {
      data: [
        { id: 'gpt-4o' },
        { id: 'text-embedding-3-large' },
        { id: 'text-embedding-ada-002' },
        { id: 'dall-e-3' },
        { id: 'whisper-1' },
        { id: 'tts-1-hd' },
        { id: 'omni-moderation-latest' },
        { id: 'babbage-002' },
        { id: 'davinci-002' },
        { id: 'ft:gpt-3.5-turbo:org::abc' },
      ],
    };
    expect(parseOpenAIModels(json).map(m => m.id)).toEqual(['gpt-4o']);
  });

  it('drops non-chat-completion gpt-* variants (realtime, audio, transcribe, tts, image, search)', () => {
    const json = {
      data: [
        { id: 'gpt-4o' },                       // keep — vanilla chat
        { id: 'gpt-4o-realtime-preview' },      // drop — WebSocket-only
        { id: 'gpt-realtime' },                 // drop — WebSocket-only
        { id: 'gpt-4o-audio-preview' },         // drop — audio I/O
        { id: 'gpt-4o-transcribe' },            // drop — speech-to-text
        { id: 'gpt-4o-mini-transcribe' },       // drop — speech-to-text
        { id: 'gpt-4o-mini-tts' },              // drop — text-to-speech
        { id: 'gpt-image-1' },                  // drop — image generation
        { id: 'gpt-4o-search-preview' },        // drop — web-search endpoint
      ],
    };
    expect(parseOpenAIModels(json).map(m => m.id)).toEqual(['gpt-4o']);
  });

  it('returns [] for empty data', () => {
    expect(parseOpenAIModels({ data: [] })).toEqual([]);
    expect(parseOpenAIModels({})).toEqual([]);
  });

  it('returns [] for non-array data (defensive)', () => {
    expect(parseOpenAIModels({ data: 'oops' })).toEqual([]);
    expect(parseOpenAIModels({ data: null })).toEqual([]);
    expect(parseOpenAIModels(null)).toEqual([]);
  });

  it('uses id as name (OpenAI has no display_name)', () => {
    const json = { data: [{ id: 'gpt-4.1-mini' }] };
    expect(parseOpenAIModels(json)).toEqual([
      { id: 'gpt-4.1-mini', name: 'gpt-4.1-mini' },
    ]);
  });
});

import { parseGeminiModels } from '../../aiService.js';

describe('parseGeminiModels', () => {
  it('strips models/ prefix from name and uses displayName', () => {
    const json = {
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          supportedGenerationMethods: ['generateContent', 'countTokens'],
        },
        {
          name: 'models/gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    };
    expect(parseGeminiModels(json)).toEqual([
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro',   name: 'Gemini 2.5 Pro'   },
    ]);
  });

  it('drops models without generateContent support', () => {
    const json = {
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/embedding-001',
          displayName: 'Embedding 001',
          supportedGenerationMethods: ['embedContent'],
        },
        {
          name: 'models/aqa',
          displayName: 'AQA',
          supportedGenerationMethods: ['generateAnswer'],
        },
      ],
    };
    expect(parseGeminiModels(json).map(m => m.id)).toEqual(['gemini-2.5-flash']);
  });

  it('drops non-gemini-prefixed names', () => {
    const json = {
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Flash',  supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding-001',     displayName: 'Embed',  supportedGenerationMethods: ['generateContent'] },
      ],
    };
    expect(parseGeminiModels(json).map(m => m.id)).toEqual(['gemini-2.5-flash']);
  });

  it('returns [] for empty models', () => {
    expect(parseGeminiModels({ models: [] })).toEqual([]);
    expect(parseGeminiModels({})).toEqual([]);
  });

  it('returns [] for non-array models (defensive)', () => {
    expect(parseGeminiModels({ models: 'oops' })).toEqual([]);
    expect(parseGeminiModels({ models: null })).toEqual([]);
    expect(parseGeminiModels(null)).toEqual([]);
  });

  it('falls back to id when displayName is missing', () => {
    const json = {
      models: [{ name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] }],
    };
    expect(parseGeminiModels(json)).toEqual([
      { id: 'gemini-2.0-flash', name: 'gemini-2.0-flash' },
    ]);
  });

  it('drops entries with missing name', () => {
    const json = {
      models: [
        { supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash', displayName: 'Flash', supportedGenerationMethods: ['generateContent'] },
      ],
    };
    expect(parseGeminiModels(json).map(m => m.id)).toEqual(['gemini-2.5-flash']);
  });
});

import { parseCohereModels } from '../../aiService.js';

describe('parseCohereModels', () => {
  it('keeps models whose endpoints include "chat"', () => {
    const json = {
      models: [
        { name: 'command-r-plus',  endpoints: ['generate', 'chat'] },
        { name: 'command-r',       endpoints: ['generate', 'chat'] },
        { name: 'embed-english-v3.0', endpoints: ['embed'] },
        { name: 'rerank-v3.5',     endpoints: ['rerank'] },
      ],
    };
    expect(parseCohereModels(json).map(m => m.id)).toEqual(['command-r-plus', 'command-r']);
  });

  it('uses name as the id and the name (no separate display field)', () => {
    const json = { models: [{ name: 'command-r-plus', endpoints: ['chat'] }] };
    expect(parseCohereModels(json)).toEqual([
      { id: 'command-r-plus', name: 'command-r-plus' },
    ]);
  });

  it('returns [] for empty models', () => {
    expect(parseCohereModels({ models: [] })).toEqual([]);
    expect(parseCohereModels({})).toEqual([]);
  });

  it('returns [] for non-array models (defensive)', () => {
    expect(parseCohereModels({ models: 'oops' })).toEqual([]);
    expect(parseCohereModels({ models: null })).toEqual([]);
    expect(parseCohereModels(null)).toEqual([]);
  });

  it('skips entries with missing or non-array endpoints', () => {
    const json = {
      models: [
        { name: 'malformed-1' },
        { name: 'malformed-2', endpoints: 'chat' /* string, not array */ },
        { name: 'good',         endpoints: ['chat'] },
      ],
    };
    expect(parseCohereModels(json).map(m => m.id)).toEqual(['good']);
  });

  it('skips entries with missing name', () => {
    const json = {
      models: [
        { endpoints: ['chat'] },
        { name: 'good', endpoints: ['chat'] },
      ],
    };
    expect(parseCohereModels(json).map(m => m.id)).toEqual(['good']);
  });
});

describe('parseGroqModels', () => {
  it('keeps every entry (Groq hosts only chat models)', () => {
    const json = {
      data: [
        { id: 'llama-3.3-70b-versatile' },
        { id: 'llama-3.1-8b-instant' },
      ],
    };
    expect(parseGroqModels(json).map(m => m.id)).toEqual([
      'llama-3.3-70b-versatile', 'llama-3.1-8b-instant',
    ]);
  });

  it('uses id as name', () => {
    expect(parseGroqModels({ data: [{ id: 'qwen/qwen3-32b' }] }))
      .toEqual([{ id: 'qwen/qwen3-32b', name: 'qwen/qwen3-32b' }]);
  });

  it('returns [] for empty / non-array data (defensive)', () => {
    expect(parseGroqModels({ data: [] })).toEqual([]);
    expect(parseGroqModels({})).toEqual([]);
    expect(parseGroqModels({ data: 'oops' })).toEqual([]);
    expect(parseGroqModels(null)).toEqual([]);
  });

  it('skips entries missing an id', () => {
    expect(parseGroqModels({ data: [{ foo: 'bar' }, { id: 'good' }] }).map(m => m.id))
      .toEqual(['good']);
  });
});

describe('parseCerebrasModels', () => {
  it('keeps every entry (Cerebras hosts only chat models)', () => {
    const json = { data: [{ id: 'llama3.1-8b' }, { id: 'gpt-oss-120b' }] };
    expect(parseCerebrasModels(json).map(m => m.id)).toEqual(['llama3.1-8b', 'gpt-oss-120b']);
  });

  it('returns [] for empty / non-array data (defensive)', () => {
    expect(parseCerebrasModels({})).toEqual([]);
    expect(parseCerebrasModels({ data: null })).toEqual([]);
    expect(parseCerebrasModels(null)).toEqual([]);
  });

  it('uses id as name', () => {
    expect(parseCerebrasModels({ data: [{ id: 'zai-glm-4.7' }] }))
      .toEqual([{ id: 'zai-glm-4.7', name: 'zai-glm-4.7' }]);
  });

  it('skips entries missing an id', () => {
    expect(parseCerebrasModels({ data: [{ created: 123 }, { id: 'x' }] }).map(m => m.id)).toEqual(['x']);
  });
});

describe('parseTogetherModels', () => {
  it('keeps only entries with type === "chat"', () => {
    const json = {
      data: [
        { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat', display_name: 'Llama 3.3 70B' },
        { id: 'WhereIsAI/UAE-Large-V1',                  type: 'embedding' },
        { id: 'black-forest-labs/FLUX.1-dev',            type: 'image' },
      ],
    };
    expect(parseTogetherModels(json).map(m => m.id)).toEqual(['meta-llama/Llama-3.3-70B-Instruct-Turbo']);
  });

  it('prefers display_name over id', () => {
    const json = {
      data: [{ id: 'm/Llama-3.3-70B', type: 'chat', display_name: 'Llama 3.3 70B' }],
    };
    expect(parseTogetherModels(json)).toEqual([
      { id: 'm/Llama-3.3-70B', name: 'Llama 3.3 70B' },
    ]);
  });

  it('falls back to id when display_name is missing', () => {
    const json = { data: [{ id: 'm/Llama-3', type: 'chat' }] };
    expect(parseTogetherModels(json)).toEqual([{ id: 'm/Llama-3', name: 'm/Llama-3' }]);
  });

  it('returns [] for empty / non-array data', () => {
    expect(parseTogetherModels({ data: [] })).toEqual([]);
    expect(parseTogetherModels({})).toEqual([]);
    expect(parseTogetherModels(null)).toEqual([]);
  });

  it('accepts a bare array response (some Together versions return [...] not {data:[...]})', () => {
    const json = [
      { id: 'meta-llama/Llama-3.3-70B', type: 'chat', display_name: 'Llama' },
      { id: 'embed-model',              type: 'embedding' },
    ];
    expect(parseTogetherModels(json).map(m => m.id)).toEqual(['meta-llama/Llama-3.3-70B']);
  });
});

describe('parseOpenRouterModels', () => {
  it('keeps any modality that outputs text (text->text, text+image->text, etc.)', () => {
    const json = {
      data: [
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', architecture: { modality: 'text->text' } },
        { id: 'openai/gpt-4o',              name: 'GPT-4o',          architecture: { modality: 'text+image->text' } },
        { id: 'google/gemini-2.5-pro',      name: 'Gemini 2.5 Pro',  architecture: { modality: 'text+image+audio->text' } },
        { id: 'openai/dall-e-3',            name: 'DALL·E 3',        architecture: { modality: 'text->image' } },
        { id: 'stability/sd-3',             name: 'SD 3',            architecture: { modality: 'image->image' } },
      ],
    };
    expect(parseOpenRouterModels(json).map(m => m.id)).toEqual([
      'anthropic/claude-sonnet-4',
      'openai/gpt-4o',
      'google/gemini-2.5-pro',
    ]);
    // Drops dall-e-3 and stability/sd-3 — modality does not end in '->text'.
  });

  it('uses name when present, falls back to id', () => {
    const json = {
      data: [
        { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', architecture: { modality: 'text->text' } },
        { id: 'meta/llama-3-70b',                                   architecture: { modality: 'text->text' } },
      ],
    };
    expect(parseOpenRouterModels(json)).toEqual([
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
      { id: 'meta/llama-3-70b',          name: 'meta/llama-3-70b' },
    ]);
  });

  it('returns [] for empty / non-array data', () => {
    expect(parseOpenRouterModels({ data: [] })).toEqual([]);
    expect(parseOpenRouterModels({})).toEqual([]);
    expect(parseOpenRouterModels(null)).toEqual([]);
  });

  it('skips entries with missing or wrong architecture', () => {
    const json = {
      data: [
        { id: 'no-arch' },
        { id: 'wrong-arch', architecture: 'string' },
        { id: 'good',       architecture: { modality: 'text->text' } },
      ],
    };
    expect(parseOpenRouterModels(json).map(m => m.id)).toEqual(['good']);
  });

  it('returns [] for null/non-string modality', () => {
    expect(parseOpenRouterModels(null)).toEqual([]);
    expect(parseOpenRouterModels({ data: 'oops' })).toEqual([]);
    expect(parseOpenRouterModels({ data: [{ id: 'x', architecture: { modality: 42 } }] })).toEqual([]);
  });
});

describe('parseMistralModels', () => {
  it('keeps every entry (Mistral exposes only chat-capable models)', () => {
    const json = { data: [{ id: 'mistral-large-latest' }, { id: 'mistral-small-latest' }] };
    expect(parseMistralModels(json).map(m => m.id)).toEqual(['mistral-large-latest', 'mistral-small-latest']);
  });

  it('returns [] for empty / non-array data', () => {
    expect(parseMistralModels({})).toEqual([]);
    expect(parseMistralModels({ data: 'no' })).toEqual([]);
    expect(parseMistralModels(null)).toEqual([]);
  });

  it('uses id as name', () => {
    expect(parseMistralModels({ data: [{ id: 'mistral-large-latest' }] }))
      .toEqual([{ id: 'mistral-large-latest', name: 'mistral-large-latest' }]);
  });

  it('skips entries missing an id', () => {
    expect(parseMistralModels({ data: [{ foo: 'bar' }, { id: 'good' }] }).map(m => m.id)).toEqual(['good']);
  });
});

describe('parseDeepSeekModels', () => {
  it('keeps every entry (DeepSeek hosts only chat models)', () => {
    const json = { data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] };
    expect(parseDeepSeekModels(json).map(m => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('returns [] for empty / non-array data', () => {
    expect(parseDeepSeekModels({})).toEqual([]);
    expect(parseDeepSeekModels({ data: null })).toEqual([]);
    expect(parseDeepSeekModels(null)).toEqual([]);
  });

  it('uses id as name', () => {
    expect(parseDeepSeekModels({ data: [{ id: 'deepseek-chat' }] }))
      .toEqual([{ id: 'deepseek-chat', name: 'deepseek-chat' }]);
  });

  it('skips entries missing an id', () => {
    expect(parseDeepSeekModels({ data: [{ owned_by: 'x' }, { id: 'good' }] }).map(m => m.id)).toEqual(['good']);
  });
});

import {
  PROVIDERS,
  listProviderModels,
} from '../../aiService.js';

describe('curated-list parser sanity', () => {
  // For each provider, build a synthetic API response containing exactly
  // its curated model IDs, then assert the parser keeps all of them. If a
  // parser drops a curated id, the filter regex/predicate is too tight.

  it('Anthropic parser keeps every curated id', () => {
    const ids = PROVIDERS.anthropic.models.map(m => m.id);
    const json = { data: ids.map(id => ({ id, display_name: id })) };
    expect(parseAnthropicModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });

  it('OpenAI parser keeps every curated id', () => {
    const ids = PROVIDERS.openai.models.map(m => m.id);
    const json = { data: ids.map(id => ({ id })) };
    expect(parseOpenAIModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });

  it('Gemini parser keeps every curated id', () => {
    const ids = PROVIDERS.gemini.models.map(m => m.id);
    const json = {
      models: ids.map(id => ({
        name: 'models/' + id,
        displayName: id,
        supportedGenerationMethods: ['generateContent'],
      })),
    };
    expect(parseGeminiModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });

  it('Groq parser keeps every curated id', () => {
    const ids = PROVIDERS.groq.models.map(m => m.id);
    const json = { data: ids.map(id => ({ id })) };
    expect(parseGroqModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });

  it('Cerebras parser keeps every curated id', () => {
    const ids = PROVIDERS.cerebras.models.map(m => m.id);
    const json = { data: ids.map(id => ({ id })) };
    expect(parseCerebrasModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });

  it('Together parser keeps every curated id', () => {
    const ids = PROVIDERS.together.models.map(m => m.id);
    const json = { data: ids.map(id => ({ id, type: 'chat' })) };
    expect(parseTogetherModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });

  it('OpenRouter parser keeps every curated id', () => {
    const ids = PROVIDERS.openrouter.models.map(m => m.id);
    const json = { data: ids.map(id => ({ id, architecture: { modality: 'text->text' } })) };
    expect(parseOpenRouterModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });

  it('Mistral parser keeps every curated id', () => {
    const ids = PROVIDERS.mistral.models.map(m => m.id);
    const json = { data: ids.map(id => ({ id })) };
    expect(parseMistralModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });

  it('DeepSeek parser keeps every curated id', () => {
    const ids = PROVIDERS.deepseek.models.map(m => m.id);
    const json = { data: ids.map(id => ({ id })) };
    expect(parseDeepSeekModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });

  it('Cohere parser keeps every curated id', () => {
    const ids = PROVIDERS.cohere.models.map(m => m.id);
    const json = { models: ids.map(id => ({ name: id, endpoints: ['chat'] })) };
    expect(parseCohereModels(json).map(m => m.id).sort()).toEqual(ids.slice().sort());
  });
});

describe('listProviderModels', () => {
  // Save the real listModels function so any test that mutates it can be
  // restored by afterEach — survives crashes and test-runner aborts that
  // would skip a try/finally.
  let originalAnthropicListModels;
  beforeEach(() => {
    originalAnthropicListModels = PROVIDERS.anthropic.listModels;
  });
  afterEach(() => {
    PROVIDERS.anthropic.listModels = originalAnthropicListModels;
  });

  it('throws for an unknown provider', async () => {
    await expect(listProviderModels('not-a-real-provider', 'k')).rejects.toThrow(/Unknown provider/);
  });

  it('throws when a provider has no listModels function', async () => {
    delete PROVIDERS.anthropic.listModels;
    await expect(listProviderModels('anthropic', 'k')).rejects.toThrow(/does not support model listing yet/);
  });

  it('delegates to the provider listModels and returns its result', async () => {
    PROVIDERS.anthropic.listModels = async () => [{ id: 'fake-model', name: 'Fake Model' }];
    const out = await listProviderModels('anthropic', 'k');
    expect(out).toEqual([{ id: 'fake-model', name: 'Fake Model' }]);
  });
});
