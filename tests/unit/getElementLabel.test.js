/**
 * DOM tests for getElementLabel (I9 from the audit).
 *
 * The function lives inside an IIFE in directFill.js so we can't `import`
 * it directly. Instead we evaluate the source in the happy-dom realm and
 * pull the function reference back via a temporary global hook.
 *
 * The single failing test pins the bug: when an ancestor wrapper contains
 * two form fields, the old code returned the same label for both because
 * `parent.querySelector('label')` returns the first label in the subtree.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let getElementLabel;

beforeAll(() => {
  // Patch directFill.js so the IIFE leaks getElementLabel onto globalThis
  // for testing without modifying the production file.
  const src = readFileSync(join(__dirname, '..', '..', 'directFill.js'), 'utf8');
  const patched = src.replace(
    'function getElementLabel(el) {',
    'globalThis.__getElementLabel = function getElementLabel(el) {'
  );
  // Use indirect eval so the source runs in the global scope where
  // happy-dom's `window` (and other DOM globals) are visible.
  // eslint-disable-next-line no-eval
  (0, eval)(patched);
  getElementLabel = globalThis.__getElementLabel;
});

function frag(html) {
  document.body.innerHTML = html;
}

describe('getElementLabel — happy paths (pinned)', () => {
  it('uses label[for=id]', () => {
    frag('<label for="x">First name</label><input id="x">');
    expect(getElementLabel(document.getElementById('x'))).toBe('First name');
  });

  it('uses wrapping <label>', () => {
    frag('<label>Email <input id="e"></label>');
    expect(getElementLabel(document.getElementById('e'))).toBe('Email');
  });

  it('uses aria-label', () => {
    frag('<input id="x" aria-label="Salary expectation">');
    expect(getElementLabel(document.getElementById('x'))).toBe('Salary expectation');
  });

  it('uses aria-labelledby', () => {
    frag('<span id="lbl">Citizenship</span><input id="x" aria-labelledby="lbl">');
    expect(getElementLabel(document.getElementById('x'))).toBe('Citizenship');
  });

  it('uses placeholder when nothing else available', () => {
    frag('<input id="x" placeholder="Enter your phone">');
    expect(getElementLabel(document.getElementById('x'))).toBe('Enter your phone');
  });

  it('uses .field container with one label and one input', () => {
    frag('<div class="field"><span class="field-label">Country</span><input id="x"></div>');
    expect(getElementLabel(document.getElementById('x'))).toBe('Country');
  });

  it('falls back to name attribute', () => {
    frag('<input id="x" name="work_authorization">');
    expect(getElementLabel(document.getElementById('x'))).toBe('work authorization');
  });
});

describe('getElementLabel — ancestor walk safety (I9 fix)', () => {
  it('does NOT return a label from a multi-input ancestor', () => {
    // Two unlabeled inputs share a wrapper that contains a single <label>.
    // Old behavior: BOTH inputs got "Gender" as their label, so the AI
    // would dutifully fill the second input with the gender answer.
    // New behavior: skip ambiguous ancestors and return ''.
    frag(`
      <div class="wrapper">
        <label>Gender</label>
        <input id="a">
        <input id="b">
      </div>
    `);
    const a = getElementLabel(document.getElementById('a'));
    const b = getElementLabel(document.getElementById('b'));
    // At most one of them should be labeled "Gender" — they must not both be.
    expect(a === 'Gender' && b === 'Gender').toBe(false);
  });

  it('still finds an ancestor label when the ancestor has exactly one input', () => {
    frag(`
      <section>
        <h3>About you</h3>
        <div>
          <label>Veteran status</label>
          <input id="v">
        </div>
      </section>
    `);
    expect(getElementLabel(document.getElementById('v'))).toBe('Veteran status');
  });

  it('ignores select/textarea siblings as well as inputs', () => {
    frag(`
      <div class="wrapper">
        <label>Race</label>
        <input id="a">
        <select id="b"><option>x</option></select>
      </div>
    `);
    const a = getElementLabel(document.getElementById('a'));
    const b = getElementLabel(document.getElementById('b'));
    expect(a === 'Race' && b === 'Race').toBe(false);
  });
});
