/**
 * Builds a sanitized filename for a generated cover letter download.
 *
 * Pattern: CoverLetter_<Company>_<JobTitle>_<YYYYMMDD>.<ext>
 *
 * Sanitization (per segment):
 *   1. Trim.
 *   2. Replace any char not in [A-Za-z0-9] with '-'.
 *   3. Collapse runs of '-'.
 *   4. Trim leading/trailing '-'.
 *   5. Truncate to 30 chars at the last '-' boundary <= 30.
 *
 * Empty-segment rules:
 *   - Empty company → substitute "Unknown" (recipient must know who the letter is for).
 *   - Empty title   → drop the segment entirely (company alone often identifies the application).
 *
 * Date is always YYYYMMDD (lexically sortable = chronologically sortable).
 */
export function buildCoverLetterFilename(company, title, date, ext) {
  const companySeg = sanitizeSegment(company) || 'Unknown';
  const titleSeg   = sanitizeSegment(title);
  const dateSeg    = formatDate(date);

  const parts = ['CoverLetter', companySeg];
  if (titleSeg) parts.push(titleSeg);
  parts.push(dateSeg);

  return parts.join('_') + '.' + ext;
}

function sanitizeSegment(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  s = s.replace(/[^A-Za-z0-9]+/g, '-'); // collapse runs of non-alnum into a single '-'
  s = s.replace(/^-+|-+$/g, '');         // trim hyphens at the ends
  if (!s) return '';
  if (s.length <= 30) return s;
  // Truncate at the last '-' before char 30; if no '-' boundary, hard-cut at 30.
  const cut = s.lastIndexOf('-', 30);
  if (cut > 0) return s.slice(0, cut);
  return s.slice(0, 30);
}

function formatDate(date) {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + m + d;
}
