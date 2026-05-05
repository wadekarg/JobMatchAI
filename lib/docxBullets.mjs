/**
 * DOCX paragraph editing helpers used by the tailored-resume generator.
 *
 * Pulled out of background.js so we can unit-test the matching/replacement
 * logic without spinning up JSZip or chrome.storage. The service worker
 * imports from here; tests import from here.
 *
 * The bug this module fixes (I7 from the audit):
 *   - The old code used `docXml.replace(paraXml, newParaXml)` which replaces
 *     only the first match. When two bullets had identical text across
 *     different roles, both replacements landed on the first paragraph.
 *   - It also didn't decode XML entities before matching, so a bullet
 *     containing "AT&T" would never match `<w:t>AT&amp;T</w:t>`.
 */

const PARAGRAPH_REGEX = /<w:p[ >][\s\S]*?<\/w:p>/g;
const TEXT_RUN_REGEX  = /<w:t[^>]*>([^<]*)<\/w:t>/g;

/** Decode the five named XML entities back to their characters. */
export function decodeXmlEntities(s) {
  return String(s)
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&amp;/g,  '&'); // last so we don't double-decode
}

/** Encode the five named XML entities for safe insertion into <w:t>. */
export function escapeXml(s) {
  return String(s)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

/**
 * Extracts the visible text content of a <w:p> paragraph by concatenating
 * every <w:t> text run and decoding XML entities.
 */
export function extractParagraphText(paragraphXml) {
  const matches = paragraphXml.match(TEXT_RUN_REGEX) || [];
  const inner = matches
    .map(m => m.replace(/<w:t[^>]*>/, '').replace(/<\/w:t>/, ''))
    .join('');
  return decodeXmlEntities(inner);
}

/** Lowercase + collapse whitespace for fuzzy matching. */
export function normalizeForMatch(str) {
  return String(str || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Replaces all visible text in a <w:p> paragraph with `newText`. The new text
 * goes into the first <w:t> (preserving its formatting attrs); every other
 * <w:t> in the paragraph is emptied. Returns the new paragraph XML.
 */
export function replaceParagraphText(paragraphXml, newText) {
  const escaped = escapeXml(newText);
  let first = true;
  return paragraphXml.replace(/<w:t[^>]*>[^<]*<\/w:t>/g, (match) => {
    if (first) {
      first = false;
      const tag = match.match(/<w:t[^>]*>/)[0];
      const openTag = tag.includes('xml:space') ? tag : '<w:t xml:space="preserve">';
      return openTag + escaped + '</w:t>';
    }
    // Empty out the rest of the runs
    return match.replace(/>[^<]*</, '><');
  });
}

/**
 * Walks all <w:p> paragraphs in the document and tries to match each input
 * bullet to one. Each paragraph can only be replaced once even if multiple
 * bullets would match it.
 *
 * Returns the modified docXml and the count of successful replacements.
 *
 * @param {string} docXml - Raw word/document.xml.
 * @param {Array<{original: string, improved: string}>} bullets
 * @returns {{ docXml: string, replacedCount: number }}
 */
export function replaceBulletsInDocXml(docXml, bullets) {
  if (!Array.isArray(bullets) || bullets.length === 0) {
    return { docXml, replacedCount: 0 };
  }

  // Collect paragraph spans up front so we can match without re-scanning
  // a mutating string and so we can mark spans as already used.
  PARAGRAPH_REGEX.lastIndex = 0;
  const paragraphs = []; // { start, end, xml, text, used }
  let m;
  while ((m = PARAGRAPH_REGEX.exec(docXml)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    paragraphs.push({
      start, end,
      xml: m[0],
      text: normalizeForMatch(extractParagraphText(m[0])),
      used: false,
    });
  }

  // For each bullet, find the first unused paragraph that matches.
  // Build a list of replacements with positions, then apply right→left so
  // earlier offsets stay valid as we splice in new (possibly longer) text.
  const replacements = []; // { start, end, newXml }
  let replacedCount = 0;

  for (const bullet of bullets) {
    const target = normalizeForMatch(bullet.original);
    if (!target) continue;
    for (const p of paragraphs) {
      if (p.used || !p.text || p.text.length <= 15) continue;
      // Fuzzy match: either side may contain the other (handles minor edits)
      if (p.text.includes(target) || target.includes(p.text)) {
        replacements.push({
          start: p.start,
          end: p.end,
          newXml: replaceParagraphText(p.xml, bullet.improved || ''),
        });
        p.used = true;
        replacedCount++;
        break;
      }
    }
  }

  // Apply replacements right→left so earlier indices remain valid
  replacements.sort((a, b) => b.start - a.start);
  let out = docXml;
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.newXml + out.slice(r.end);
  }

  return { docXml: out, replacedCount };
}
