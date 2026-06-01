import { describe, it, expect } from 'vitest';
import { buildCoverLetterDocxParts } from '../../lib/coverLetterDocx.mjs';

const baseInput = {
  name: 'Gajanan Wadekar',
  contactLine: 'gaj@example.com · +1 555 123 4567 · linkedin.com/in/gaj',
  today: 'May 11, 2026',
  paragraphs: ['Dear Hiring Manager,', 'I am writing to apply.', 'Sincerely,\nGajanan Wadekar'],
};

describe('buildCoverLetterDocxParts', () => {
  it('returns the four required OOXML parts', () => {
    const parts = buildCoverLetterDocxParts(baseInput);
    expect(Object.keys(parts).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/_rels/document.xml.rels',
      'word/document.xml',
    ].sort());
  });

  it('every part is well-formed XML starting with <?xml', () => {
    const parts = buildCoverLetterDocxParts(baseInput);
    for (const [path, xml] of Object.entries(parts)) {
      expect(xml, `part ${path}`).toMatch(/^<\?xml/);
    }
  });

  it('document.xml contains the name as bold 14pt (sz val=28)', () => {
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(baseInput);
    expect(doc).toMatch(/<w:b\/>[\s\S]*?<w:sz w:val="28"\/>[\s\S]*?Gajanan Wadekar/);
  });

  it('document.xml contains the contact line as 10pt grey (color 555555)', () => {
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(baseInput);
    expect(doc).toMatch(/<w:sz w:val="20"\/>[\s\S]*?<w:color w:val="555555"\/>[\s\S]*?linkedin\.com\/in\/gaj/);
  });

  it('document.xml contains the date paragraph', () => {
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(baseInput);
    expect(doc).toContain('May 11, 2026');
  });

  it('produces one <w:p> per body paragraph plus header paragraphs', () => {
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(baseInput);
    const paragraphCount = (doc.match(/<w:p[ >]/g) || []).length;
    // 3 header paragraphs (name, contact, date) + 3 body paragraphs = 6
    expect(paragraphCount).toBe(6);
  });

  it('XML-escapes ampersands, less-than, and greater-than in body', () => {
    const input = { ...baseInput, paragraphs: ['AT&T sells <good> "stuff"'] };
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(input);
    expect(doc).toContain('AT&amp;T sells &lt;good&gt; &quot;stuff&quot;');
    expect(doc).not.toContain('AT&T sells');
  });

  it('omits the name paragraph when name is empty', () => {
    const input = { ...baseInput, name: '', paragraphs: ['Dear Hiring Manager,', 'I am writing to apply.', 'Sincerely,'] };
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(input);
    expect(doc).not.toContain('Gajanan Wadekar');
    expect(doc).not.toContain('<w:sz w:val="28"/>'); // 14pt is the name size — only used for the name
  });

  it('omits the contact paragraph when contactLine is empty', () => {
    const input = { ...baseInput, contactLine: '' };
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(input);
    expect(doc).not.toContain('<w:color w:val="555555"/>');
  });

  it('preserves soft line breaks inside a paragraph as <w:br/>', () => {
    const input = { ...baseInput, paragraphs: ['Line one.\nLine two.'] };
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(input);
    expect(doc).toMatch(/Line one\.<\/w:t><w:br\/><w:t[^>]*>Line two\./);
  });

  it('document.xml declares letter page size (12240 x 15840 twips)', () => {
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(baseInput);
    expect(doc).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
  });

  it('document.xml declares 1-inch margins (1440 twips)', () => {
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(baseInput);
    expect(doc).toContain('w:top="1440"');
    expect(doc).toContain('w:right="1440"');
    expect(doc).toContain('w:bottom="1440"');
    expect(doc).toContain('w:left="1440"');
  });

  it('declares Calibri as the font on every run', () => {
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(baseInput);
    // Every <w:rPr> we emit should include a Calibri font declaration.
    const rPrBlocks = doc.match(/<w:rPr>[\s\S]*?<\/w:rPr>/g) || [];
    expect(rPrBlocks.length).toBeGreaterThan(0);
    for (const block of rPrBlocks) {
      expect(block).toContain('<w:rFonts w:ascii="Calibri"');
    }
  });

  it('applies 240-twip space-after to paragraphs', () => {
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(baseInput);
    // Body paragraphs should carry both line=276 (1.15 spacing) and after=240.
    expect(doc).toContain('w:after="240"');
  });

  it('uses 1.15 line spacing on body paragraphs', () => {
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(baseInput);
    expect(doc).toContain('w:line="276" w:lineRule="auto"');
  });

  it('justifies body paragraphs only (not header / salutation / signature)', () => {
    const input = {
      ...baseInput,
      recipient:  ['Hiring Manager', 'Deepgram'],
      salutation: 'Dear Hiring Manager,',
      signOff:    'Sincerely,',
      signature:  'Gajanan Wadekar',
    };
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(input);
    // Body paragraphs are the only ones that pair line=276 with jc="both".
    const jcMatches = doc.match(/<w:jc w:val="both"\/>/g) || [];
    // 3 body paragraphs → 3 justification declarations, no more.
    expect(jcMatches.length).toBe(3);
  });

  it('emits the recipient block when provided', () => {
    const input = { ...baseInput, recipient: ['Hiring Manager', 'Deepgram'] };
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(input);
    expect(doc).toContain('Hiring Manager');
    expect(doc).toContain('Deepgram');
    // First recipient line should be tight (after="0"), so its <w:pPr>
    // contains the tight spacing rule rather than the wider 240-twip one.
    expect(doc).toMatch(/<w:p><w:pPr><w:spacing w:after="0"\/>[\s\S]*?Hiring Manager/);
  });

  it('filters empty recipient lines and skips an all-empty array', () => {
    // Override `paragraphs` to avoid body text colliding with assertions.
    const cleanBody = { ...baseInput, paragraphs: ['Greetings.', 'I am writing.', 'Yours truly.'] };
    const noBlock = buildCoverLetterDocxParts({ ...cleanBody, recipient: ['', null, '   '] });
    expect(noBlock['word/document.xml']).not.toContain('Hiring Manager');
    const partial = buildCoverLetterDocxParts({ ...cleanBody, recipient: ['Hiring Manager', ''] });
    expect(partial['word/document.xml']).toContain('Hiring Manager');
  });

  it('emits the salutation when provided', () => {
    const input = { ...baseInput, salutation: 'Dear Hiring Manager,' };
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(input);
    expect(doc).toContain('Dear Hiring Manager,');
  });

  it('emits the sign-off and signature when provided', () => {
    const input = { ...baseInput, signOff: 'Sincerely,', signature: 'Gajanan Wadekar' };
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(input);
    expect(doc).toContain('Sincerely,');
    // signature paragraph must come after sign-off paragraph in document order
    const signOffIdx   = doc.indexOf('Sincerely,');
    const signatureIdx = doc.lastIndexOf('Gajanan Wadekar');
    expect(signatureIdx).toBeGreaterThan(signOffIdx);
  });

  it('omits sign-off and signature when both are empty', () => {
    // Strip "Sincerely," from the body too so we can assert its true absence.
    const input = { ...baseInput, paragraphs: ['Greetings.', 'I am writing.', 'Yours truly.'] };
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(input);
    expect(doc).not.toContain('Sincerely,');
  });

  it('produces the right number of paragraphs with the full envelope', () => {
    // name + contact + date + 2 recipient lines + salutation + 3 body + sign-off + signature = 11
    const input = {
      ...baseInput,
      recipient:  ['Hiring Manager', 'Deepgram'],
      salutation: 'Dear Hiring Manager,',
      signOff:    'Sincerely,',
      signature:  'Gajanan Wadekar',
    };
    const { 'word/document.xml': doc } = buildCoverLetterDocxParts(input);
    const paragraphCount = (doc.match(/<w:p[ >]/g) || []).length;
    expect(paragraphCount).toBe(11);
  });
});
