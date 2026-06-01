import { describe, it, expect } from 'vitest';
import { migrateAiSettings } from '../../lib/aiSettingsMigration.mjs';

describe('migrateAiSettings', () => {
  it('returns already-migrated settings unchanged', () => {
    const input = {
      provider: 'anthropic',
      apiKey:   'sk-ant-test',
      model:    'claude-sonnet-4-20250514',
      temperature: 0.3,
      keys:     { anthropic: 'sk-ant-test' },
    };
    expect(migrateAiSettings(input)).toBe(input); // same reference, untouched
  });

  it('returns settings with empty keys map unchanged (reference-equal)', () => {
    // After "Clear saved keys" the steady state is keys:{}. Confirm we
    // don't accidentally clone-on-pass — locks the cheap-path contract.
    const input = { provider: 'anthropic', apiKey: 'sk-ant', keys: {} };
    expect(migrateAiSettings(input)).toBe(input);
  });

  it('seeds keys from old shape (apiKey + provider, no keys field)', () => {
    const input = {
      provider: 'anthropic',
      apiKey:   'sk-ant-test',
      model:    'claude-sonnet-4-20250514',
      temperature: 0.3,
    };
    const out = migrateAiSettings(input);
    expect(out).toEqual({
      provider: 'anthropic',
      apiKey:   'sk-ant-test',
      model:    'claude-sonnet-4-20250514',
      temperature: 0.3,
      keys:     { anthropic: 'sk-ant-test' },
    });
    // Does not mutate the input
    expect(input.keys).toBeUndefined();
  });

  it('returns empty keys when old apiKey is empty', () => {
    const input = {
      provider: 'anthropic',
      apiKey:   '',
      model:    'claude-sonnet-4-20250514',
      temperature: 0.3,
    };
    expect(migrateAiSettings(input)).toEqual({
      ...input,
      keys: {},
    });
  });

  it('passes null / undefined through unchanged', () => {
    expect(migrateAiSettings(null)).toBeNull();
    expect(migrateAiSettings(undefined)).toBeUndefined();
  });
});
