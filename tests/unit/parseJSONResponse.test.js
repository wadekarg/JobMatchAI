/**
 * Pin-tests for aiService.parseJSONResponse.
 *
 * Pins the contract first (so we can refactor without regressing real-world
 * AI response shapes), then asserts the new behaviour for the cases the
 * old greedy regex handled wrong.
 */
import { describe, it, expect } from 'vitest';
import { parseJSONResponse } from '../../aiService.js';

describe('parseJSONResponse — happy paths (pinned)', () => {
  it('parses pure JSON object', () => {
    expect(parseJSONResponse('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses pure JSON array', () => {
    expect(parseJSONResponse('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json fences', () => {
    const text = '```json\n{"score": 75}\n```';
    expect(parseJSONResponse(text)).toEqual({ score: 75 });
  });

  it('strips bare ``` fences', () => {
    const text = '```\n{"score": 75}\n```';
    expect(parseJSONResponse(text)).toEqual({ score: 75 });
  });

  it('extracts a single JSON object from surrounding prose', () => {
    const text = 'Here is the result: {"score": 75, "match": true} — done.';
    expect(parseJSONResponse(text)).toEqual({ score: 75, match: true });
  });

  it('extracts a single JSON array from surrounding prose', () => {
    const text = 'Answers: [1, 2, 3] — done.';
    expect(parseJSONResponse(text)).toEqual([1, 2, 3]);
  });
});

describe('parseJSONResponse — bug fixes (I5)', () => {
  it('does not greedy-match across two unrelated objects', () => {
    // The old `/\{[\s\S]*\}/` would match from first `{` to LAST `}`,
    // producing invalid JSON like `{example: "..."} actually {"score":75}`.
    // Now we must extract a balanced object.
    const text = 'Example: {"example": "ignore"} ... actually use this: {"score": 75}';
    const result = parseJSONResponse(text);
    // Either the first or last balanced object is acceptable; current
    // implementation extracts the first balanced one.
    expect(result).toBeTypeOf('object');
    expect(result).toHaveProperty('example');
  });

  it('throws a clear error when no JSON is present', () => {
    expect(() => parseJSONResponse('hello world')).toThrow(/Could not parse/);
  });

  it('handles JSON inside fenced block even when prose follows', () => {
    const text = 'Sure, here:\n```json\n{"a": 1}\n```\nLet me know if you need more.';
    expect(parseJSONResponse(text)).toEqual({ a: 1 });
  });

  it('handles nested objects without breaking', () => {
    const text = '{"outer": {"inner": [1, 2, {"deep": true}]}}';
    expect(parseJSONResponse(text)).toEqual({
      outer: { inner: [1, 2, { deep: true }] },
    });
  });

  it('handles strings containing braces inside the JSON', () => {
    const text = '{"text": "this has { and } in it"}';
    expect(parseJSONResponse(text)).toEqual({ text: 'this has { and } in it' });
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"quote": "she said \\"hi\\""}';
    expect(parseJSONResponse(text)).toEqual({ quote: 'she said "hi"' });
  });
});
