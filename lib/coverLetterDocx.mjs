/**
 * Pure builder for the OOXML parts of a generated cover letter .docx.
 * Returns an object map { [zipPath]: xmlString } the service worker can zip
 * with JSZip. No JSZip / chrome.* dependency — testable in plain Node.
 *
 * Layout order (each non-empty section becomes one or more paragraphs):
 *   1. Name              — 14pt bold black
 *   2. Contact line      — 10pt grey #555555
 *   3. Date              — 11pt regular
 *   4. Recipient block   — array of 11pt lines (e.g. "Hiring Manager" / company)
 *   5. Salutation        — 11pt regular (e.g. "Dear Hiring Manager,")
 *   6. Body paragraphs   — 11pt regular, 1.15 line spacing
 *   7. Sign-off          — 11pt regular (e.g. "Sincerely,")
 *   8. Signature         — 11pt regular (typically the user's name)
 *
 * Font sizing uses OOXML half-points: 14pt → 28, 11pt → 22, 10pt → 20.
 * Page size for US Letter is 12240×15840 twips (1 twip = 1/1440 inch).
 * One-inch margin = 1440 twips. Paragraph spacing-after = 240 twips ≈ 12pt
 * (gives a visible blank line between sections without an empty paragraph).
 */

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const CALIBRI       = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>';
const SPACE_AFTER   = '<w:spacing w:after="240"/>';      // ~12pt gap after — one blank line
const TIGHT_AFTER   = '<w:spacing w:after="0"/>';        // no gap (e.g. within recipient block)
// Body paragraphs: 1.15 line height, 12pt gap after, justified alignment.
// `<w:jc w:val="both"/>` is OOXML's "justify" — it stretches inter-word
// space so every line (except the last in a paragraph) reaches the right
// margin, matching how Word labels the alignment as "Justify".
const BODY_SPACING  = '<w:spacing w:after="240" w:line="276" w:lineRule="auto"/><w:jc w:val="both"/>';

/** Encode the five named XML entities for safe insertion into <w:t>. */
function escapeXml(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

/** A single <w:p> with one run + optional paragraph- and run-level properties. */
function paragraph(text, rPrXml = '', pPrXml = '') {
  // Soft-break-aware: split on \n and emit a <w:br/> between segments.
  const segments = String(text).split('\n');
  const runInner = segments.map((seg, i) => {
    const escaped = escapeXml(seg);
    const t = `<w:t xml:space="preserve">${escaped}</w:t>`;
    return i === 0 ? t : `<w:br/>${t}`;
  }).join('');
  const rPr = rPrXml ? `<w:rPr>${rPrXml}</w:rPr>` : '';
  const pPr = pPrXml ? `<w:pPr>${pPrXml}</w:pPr>` : '';
  return `<w:p>${pPr}<w:r>${rPr}${runInner}</w:r></w:p>`;
}

function buildBodyXml({ name, contactLine, today, recipient, salutation, paragraphs, signOff, signature }) {
  const parts = [];

  // 1. Name — bold 14pt. Tight under contact line, big gap follows the contact line.
  if (name && name.trim()) {
    parts.push(paragraph(name.trim(), `${CALIBRI}<w:b/><w:sz w:val="28"/>`, TIGHT_AFTER));
  }
  // 2. Contact line — 10pt grey, gap after to separate header from date.
  if (contactLine && contactLine.trim()) {
    parts.push(paragraph(contactLine.trim(), `${CALIBRI}<w:sz w:val="20"/><w:color w:val="555555"/>`, SPACE_AFTER));
  }
  // 3. Date — gap after separates from recipient/salutation.
  if (today && today.trim()) {
    parts.push(paragraph(today.trim(), `${CALIBRI}<w:sz w:val="22"/>`, SPACE_AFTER));
  }
  // 4. Recipient block — consecutive lines tight, gap after the last.
  if (Array.isArray(recipient) && recipient.length > 0) {
    const cleaned = recipient.map(l => String(l || '').trim()).filter(Boolean);
    cleaned.forEach((line, i) => {
      const isLast = i === cleaned.length - 1;
      parts.push(paragraph(line, `${CALIBRI}<w:sz w:val="22"/>`, isLast ? SPACE_AFTER : TIGHT_AFTER));
    });
  }
  // 5. Salutation — gap follows.
  if (salutation && salutation.trim()) {
    parts.push(paragraph(salutation.trim(), `${CALIBRI}<w:sz w:val="22"/>`, SPACE_AFTER));
  }
  // 6. Body — 1.15 line spacing + gap between paragraphs.
  for (const p of (paragraphs || [])) {
    if (p == null) continue;
    parts.push(paragraph(p, `${CALIBRI}<w:sz w:val="22"/>`, BODY_SPACING));
  }
  // 7. Sign-off — gap separates from typed signature.
  if (signOff && signOff.trim()) {
    parts.push(paragraph(signOff.trim(), `${CALIBRI}<w:sz w:val="22"/>`, SPACE_AFTER));
  }
  // 8. Signature — tight under sign-off.
  if (signature && signature.trim()) {
    parts.push(paragraph(signature.trim(), `${CALIBRI}<w:sz w:val="22"/>`, TIGHT_AFTER));
  }

  return parts.join('');
}

export function buildCoverLetterDocxParts({ name, contactLine, today, recipient, salutation, paragraphs, signOff, signature }) {
  const bodyContent = buildBodyXml({ name, contactLine, today, recipient, salutation, paragraphs, signOff, signature });

  const documentXml = XML_DECL +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' +
        bodyContent +
        '<w:sectPr>' +
          '<w:pgSz w:w="12240" w:h="15840"/>' +
          '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
        '</w:sectPr>' +
      '</w:body>' +
    '</w:document>';

  const contentTypesXml = XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const rootRelsXml = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const documentRelsXml = XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '</Relationships>';

  return {
    '[Content_Types].xml':           contentTypesXml,
    '_rels/.rels':                   rootRelsXml,
    'word/_rels/document.xml.rels':  documentRelsXml,
    'word/document.xml':             documentXml,
  };
}
