/**
 * Tests for lib/docxBullets.mjs (I7 from the audit).
 *
 * The two bugs being fixed:
 *  - String.replace lands on the first occurrence even when a bullet's text
 *    appears verbatim in two paragraphs (duplicate bullets across roles).
 *  - extractParagraphText didn't decode XML entities, so any bullet
 *    containing & < > " ' would silently miss its paragraph.
 */
import { describe, it, expect } from 'vitest';
import {
  decodeXmlEntities,
  escapeXml,
  extractParagraphText,
  normalizeForMatch,
  replaceParagraphText,
  replaceBulletsInDocXml,
} from '../../lib/docxBullets.mjs';

const wrapPara = (text) =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

describe('decodeXmlEntities', () => {
  it('decodes the five named entities', () => {
    expect(decodeXmlEntities('AT&amp;T &lt;tag&gt; &quot;hi&quot; &apos;x&apos;'))
      .toBe(`AT&T <tag> "hi" 'x'`);
  });
  it('does not double-decode &amp;amp;', () => {
    expect(decodeXmlEntities('&amp;amp;')).toBe('&amp;');
  });
});

describe('escapeXml', () => {
  it('encodes the five named entities', () => {
    expect(escapeXml(`AT&T <tag> "hi" 'x'`))
      .toBe('AT&amp;T &lt;tag&gt; &quot;hi&quot; &apos;x&apos;');
  });
  it('escape→decode round-trips', () => {
    const original = `Built CI/CD pipelines @ AT&T (>10x faster) — "blazing"`;
    expect(decodeXmlEntities(escapeXml(original))).toBe(original);
  });
});

describe('extractParagraphText', () => {
  it('joins multiple text runs', () => {
    const xml = '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>';
    expect(extractParagraphText(xml)).toBe('Hello world');
  });
  it('decodes XML entities while extracting', () => {
    const xml = '<w:p><w:r><w:t>AT&amp;T</w:t></w:r></w:p>';
    expect(extractParagraphText(xml)).toBe('AT&T');
  });
});

describe('replaceParagraphText', () => {
  it('puts new text in the first <w:t> and empties the rest', () => {
    const xml = '<w:p><w:r><w:t>old1 </w:t></w:r><w:r><w:t>old2</w:t></w:r></w:p>';
    const out = replaceParagraphText(xml, 'NEW');
    expect(out).toMatch(/<w:t[^>]*>NEW<\/w:t>/);
    expect(out.match(/<w:t[^>]*><\/w:t>/g)).not.toBeNull(); // a cleared run remains
  });
  it('escapes special chars in the replacement', () => {
    const xml = '<w:p><w:r><w:t>old</w:t></w:r></w:p>';
    const out = replaceParagraphText(xml, 'AT&T <hi>');
    expect(out).toContain('AT&amp;T &lt;hi&gt;');
  });
});

describe('replaceBulletsInDocXml — happy paths', () => {
  it('replaces a single matching bullet', () => {
    const docXml = '<root>' + wrapPara('Built CI/CD pipelines reducing deploy time') + '</root>';
    const { docXml: out, replacedCount } = replaceBulletsInDocXml(docXml, [
      { original: 'Built CI/CD pipelines reducing deploy time',
        improved: 'Built Kubernetes-native CI/CD pipelines on Argo CD reducing deploy time 10x' },
    ]);
    expect(replacedCount).toBe(1);
    expect(out).toContain('Argo CD');
    expect(out).not.toContain('Built CI/CD pipelines reducing deploy time');
  });

  it('skips paragraphs shorter than the threshold', () => {
    // Short text guards against matching ATS metadata like "Skills:"
    const docXml = '<root>' + wrapPara('Skills:') + '</root>';
    const { replacedCount } = replaceBulletsInDocXml(docXml, [
      { original: 'Skills', improved: 'X' },
    ]);
    expect(replacedCount).toBe(0);
  });

  it('handles bullets with XML entities (AT&T case)', () => {
    const docXml = '<root>' + wrapPara('Led integration with AT&amp;T billing platform end-to-end') + '</root>';
    const { docXml: out, replacedCount } = replaceBulletsInDocXml(docXml, [
      { original: 'Led integration with AT&T billing platform end-to-end',
        improved: 'Led AT&T integration end-to-end (Kafka + Spark)' },
    ]);
    expect(replacedCount).toBe(1);
    expect(out).toContain('AT&amp;T integration end-to-end');
  });
});

describe('replaceBulletsInDocXml — duplicate-bullet bug fix (I7)', () => {
  it('replaces two identical bullets with two different rewrites', () => {
    // Two roles with identical "Built CI/CD pipelines" wording.
    // Old behavior: both bullets landed on the first paragraph.
    // New behavior: each bullet finds its own paragraph.
    const docXml = '<root>'
      + wrapPara('Built CI/CD pipelines reducing deploy time at company A')
      + wrapPara('Built CI/CD pipelines reducing deploy time at company A')
      + '</root>';
    const { docXml: out, replacedCount } = replaceBulletsInDocXml(docXml, [
      { original: 'Built CI/CD pipelines reducing deploy time at company A',
        improved: 'REWRITE_ONE' },
      { original: 'Built CI/CD pipelines reducing deploy time at company A',
        improved: 'REWRITE_TWO' },
    ]);
    expect(replacedCount).toBe(2);
    expect(out).toContain('REWRITE_ONE');
    expect(out).toContain('REWRITE_TWO');
    expect(out).not.toContain('Built CI/CD pipelines reducing deploy time at company A');
  });

  it('does not consume an unused paragraph for a non-matching bullet', () => {
    const docXml = '<root>'
      + wrapPara('Built data pipelines for ingestion at terabyte scale')
      + wrapPara('Architected microservices on Kubernetes for tier-1 services')
      + '</root>';
    const { replacedCount } = replaceBulletsInDocXml(docXml, [
      { original: 'something completely unrelated to either paragraph here', improved: 'X' },
    ]);
    expect(replacedCount).toBe(0);
  });
});
