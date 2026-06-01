import { describe, it, expect, beforeEach } from 'vitest';
import { populateCoverLetterPdf } from '../../lib/coverLetterPdf.mjs';

/**
 * Records every jsPDF method call so tests can assert call order/args.
 * Mirrors only the surface area populateCoverLetterPdf uses.
 */
function makeMockDoc() {
  const calls = [];
  const splitter = (text, maxWidth) => {
    // Simple line-wrap mock: split on existing \n only — fine for tests.
    return String(text).split('\n');
  };
  return {
    calls,
    setFontSize(n)        { calls.push(['setFontSize', n]); },
    setFont(name, style)  { calls.push(['setFont', name, style]); },
    setTextColor(...args) { calls.push(['setTextColor', ...args]); },
    text(t, x, y)         { calls.push(['text', t, x, y]); },
    addPage()             { calls.push(['addPage']); },
    splitTextToSize: splitter,
    getTextDimensions(t)  { return { w: 100, h: 12 }; },
    internal: {
      pageSize: { getWidth: () => 612, getHeight: () => 792 },
    },
  };
}

const baseInput = {
  name: 'Gajanan Wadekar',
  contactLine: 'gaj@example.com · +1 555 123 4567',
  today: 'May 11, 2026',
  paragraphs: ['Dear Hiring Manager,', 'I am writing to apply.', 'Sincerely,\nGajanan'],
};

describe('populateCoverLetterPdf', () => {
  let doc;
  beforeEach(() => { doc = makeMockDoc(); });

  it('emits the name with 14pt bold', () => {
    populateCoverLetterPdf(doc, baseInput);
    const nameTextCall = doc.calls.find(c => c[0] === 'text' && c[1] === 'Gajanan Wadekar');
    expect(nameTextCall).toBeTruthy();
    // The setFontSize(14) and setFont(..., 'bold') must precede the name text.
    const nameIdx = doc.calls.indexOf(nameTextCall);
    const before  = doc.calls.slice(0, nameIdx);
    expect(before).toContainEqual(['setFontSize', 14]);
    expect(before.some(c => c[0] === 'setFont' && c[2] === 'bold')).toBe(true);
  });

  it('emits the contact line at 10pt grey', () => {
    populateCoverLetterPdf(doc, baseInput);
    const contactIdx = doc.calls.findIndex(c => c[0] === 'text' && c[1] === baseInput.contactLine);
    expect(contactIdx).toBeGreaterThan(-1);
    const before = doc.calls.slice(0, contactIdx);
    expect(before).toContainEqual(['setFontSize', 10]);
    // setTextColor should have been called with 85,85,85 (#555) before the contact line.
    expect(before.some(c => c[0] === 'setTextColor' && c[1] === 85 && c[2] === 85 && c[3] === 85)).toBe(true);
  });

  it('emits the date after the header', () => {
    populateCoverLetterPdf(doc, baseInput);
    const dateIdx = doc.calls.findIndex(c => c[0] === 'text' && c[1] === 'May 11, 2026');
    const nameIdx = doc.calls.findIndex(c => c[0] === 'text' && c[1] === 'Gajanan Wadekar');
    expect(dateIdx).toBeGreaterThan(nameIdx);
  });

  it('emits each body paragraph as its own text call', () => {
    populateCoverLetterPdf(doc, baseInput);
    const textCalls = doc.calls.filter(c => c[0] === 'text');
    // We have 3 header text calls (name, contact, date) + 3 body paragraphs = 6 minimum.
    expect(textCalls.length).toBeGreaterThanOrEqual(6);
    expect(textCalls.some(c => {
      const t = Array.isArray(c[1]) ? c[1].join(' ') : c[1];
      return t.includes('Dear Hiring Manager');
    })).toBe(true);
    expect(textCalls.some(c => {
      const t = Array.isArray(c[1]) ? c[1].join(' ') : c[1];
      return t.includes('I am writing to apply');
    })).toBe(true);
  });

  it('skips name calls when name is empty', () => {
    populateCoverLetterPdf(doc, { ...baseInput, name: '' });
    expect(doc.calls.some(c => c[0] === 'setFontSize' && c[1] === 14)).toBe(false);
    expect(doc.calls.some(c => c[0] === 'text' && c[1] === 'Gajanan Wadekar')).toBe(false);
  });

  it('skips contact calls when contactLine is empty', () => {
    populateCoverLetterPdf(doc, { ...baseInput, contactLine: '' });
    // The grey color call should not appear.
    expect(doc.calls.some(c => c[0] === 'setTextColor' && c[1] === 85)).toBe(false);
  });

  it('calls addPage when the running y exceeds the page', () => {
    // Force many body paragraphs to overflow the page.
    const many = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}.`);
    populateCoverLetterPdf(doc, { ...baseInput, paragraphs: many });
    expect(doc.calls.some(c => c[0] === 'addPage')).toBe(true);
  });

  it('emits each recipient line as its own text call', () => {
    populateCoverLetterPdf(doc, { ...baseInput, recipient: ['Hiring Manager', 'Deepgram'] });
    const textCalls = doc.calls.filter(c => c[0] === 'text');
    expect(textCalls.some(c => c[1] === 'Hiring Manager')).toBe(true);
    expect(textCalls.some(c => c[1] === 'Deepgram')).toBe(true);
  });

  it('filters empty recipient entries', () => {
    populateCoverLetterPdf(doc, { ...baseInput, recipient: ['Hiring Manager', '', null, '   '] });
    const textCalls = doc.calls.filter(c => c[0] === 'text');
    expect(textCalls.some(c => c[1] === 'Hiring Manager')).toBe(true);
    expect(textCalls.filter(c => c[1] === '').length).toBe(0);
  });

  it('emits the salutation', () => {
    populateCoverLetterPdf(doc, { ...baseInput, salutation: 'Dear Hiring Manager,' });
    const textCalls = doc.calls.filter(c => c[0] === 'text');
    expect(textCalls.some(c => c[1] === 'Dear Hiring Manager,')).toBe(true);
  });

  it('emits sign-off followed by signature', () => {
    // Use a different name than the header so the signature text call
    // doesn't collide with the name text call when finding by string match.
    populateCoverLetterPdf(doc, {
      ...baseInput,
      name:      'Test User',
      signOff:   'Sincerely,',
      signature: 'Gajanan Wadekar',
    });
    const textCalls = doc.calls.filter(c => c[0] === 'text');
    const signOffIdx   = textCalls.findIndex(c => c[1] === 'Sincerely,');
    const signatureIdx = textCalls.findIndex(c => c[1] === 'Gajanan Wadekar');
    expect(signOffIdx).toBeGreaterThanOrEqual(0);
    expect(signatureIdx).toBeGreaterThan(signOffIdx);
  });

  it('skips sign-off and signature when both are absent', () => {
    populateCoverLetterPdf(doc, baseInput);
    const textCalls = doc.calls.filter(c => c[0] === 'text');
    expect(textCalls.some(c => c[1] === 'Sincerely,')).toBe(false);
  });

  it('justifies body paragraphs (passes align:justify + maxWidth to doc.text)', () => {
    populateCoverLetterPdf(doc, baseInput);
    // Find body-paragraph text calls: they pass an array (from splitTextToSize)
    // and a 4th arg with align:'justify'.
    const bodyTextCalls = doc.calls.filter(c =>
      c[0] === 'text' && Array.isArray(c[1])
    );
    expect(bodyTextCalls.length).toBeGreaterThanOrEqual(1);
    // Each body call should have been invoked with the justify option.
    // (The mock currently records the call as [type, t, x, y] — opts get
    // dropped — so we re-verify the implementation directly via inspect.)
    // For this assertion we rely on the impl calling doc.text(lines, x, y, opts);
    // a behavioural check is good enough at the unit level — we mock the
    // doc.text signature below so we capture the options arg too.
    const docWithOpts = (() => {
      const calls = [];
      return {
        calls,
        setFontSize() {}, setFont() {}, setTextColor() {},
        text(t, x, y, opts) { calls.push(['text', t, x, y, opts]); },
        addPage() {},
        splitTextToSize: (t) => String(t).split('\n'),
        getTextDimensions: () => ({ w: 100, h: 12 }),
        internal: { pageSize: { getWidth: () => 612, getHeight: () => 792 } },
      };
    })();
    populateCoverLetterPdf(docWithOpts, baseInput);
    const bodyOpts = docWithOpts.calls
      .filter(c => c[0] === 'text' && Array.isArray(c[1]))
      .map(c => c[4]);
    expect(bodyOpts.length).toBeGreaterThan(0);
    for (const opts of bodyOpts) {
      expect(opts).toMatchObject({ align: 'justify' });
      expect(typeof opts.maxWidth).toBe('number');
    }
  });

  it('renders the full envelope (name, contact, date, recipient, salutation, body, sign-off, signature)', () => {
    populateCoverLetterPdf(doc, {
      ...baseInput,
      recipient:  ['Hiring Manager', 'Deepgram'],
      salutation: 'Dear Hiring Manager,',
      signOff:    'Sincerely,',
      signature:  'Gajanan Wadekar',
    });
    const textCalls = doc.calls.filter(c => c[0] === 'text');
    // 1 name + 1 contact + 1 date + 2 recipient + 1 salutation + 3 body + 1 signOff + 1 signature = 11
    expect(textCalls.length).toBe(11);
  });
});
