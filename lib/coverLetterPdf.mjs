/**
 * Pure populator for a cover-letter PDF, given a jsPDF instance.
 *
 * The caller (background.js) constructs `new jsPDF({unit:'pt', format:'letter'})`
 * — at unit:'pt' the page is 612×792 with 1-inch margins = 72pt.
 *
 * Layout from top-down, all left-aligned at x=72:
 *   1. Name              — 14pt bold black
 *   2. Contact line      — 10pt grey #555555
 *      [section gap]
 *   3. Date              — 11pt regular black
 *      [section gap]
 *   4. Recipient block   — array of 11pt lines (e.g. "Hiring Manager", company)
 *      [section gap]
 *   5. Salutation        — 11pt regular (e.g. "Dear Hiring Manager,")
 *      [section gap]
 *   6. Body paragraphs   — 11pt regular, blank line between each
 *      [section gap]
 *   7. Sign-off          — 11pt regular (e.g. "Sincerely,")
 *      [signature gap — taller, leaves room for a handwritten signature]
 *   8. Signature         — 11pt regular (user's name)
 *
 * Auto-paginates by tracking `y` and calling `addPage()` when we'd overflow.
 */

const MARGIN_X    = 72;     // 1 inch
const MARGIN_TOP  = 72;
const MARGIN_BOT  = 72;
const NAME_PT     = 14;
const CONTACT_PT  = 10;
const BODY_PT     = 11;
const NAME_LH     = 18;     // line-height pt
const CONTACT_LH  = 14;
const BODY_LH     = 16;
const PARA_GAP    = 8;      // between body paragraphs
const SECTION_GAP = 16;     // bigger gap between major sections
const SIG_GAP     = 32;     // sign-off → signature: room for a handwritten signature

export function populateCoverLetterPdf(doc, { name, contactLine, today, recipient, salutation, paragraphs, signOff, signature }) {
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const textW = pageW - MARGIN_X * 2;
  const bottomLimit = pageH - MARGIN_BOT;
  let y = MARGIN_TOP;

  const ensureRoom = (linesNeeded, lineHeight) => {
    if (y + linesNeeded * lineHeight > bottomLimit) {
      doc.addPage();
      y = MARGIN_TOP;
    }
  };

  // 1. Name — 14pt bold black
  if (name && name.trim()) {
    ensureRoom(1, NAME_LH);
    doc.setFontSize(NAME_PT);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(0, 0, 0);
    doc.text(name.trim(), MARGIN_X, y);
    y += NAME_LH;
  }

  // 2. Contact line — 10pt grey
  if (contactLine && contactLine.trim()) {
    ensureRoom(1, CONTACT_LH);
    doc.setFontSize(CONTACT_PT);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(85, 85, 85); // #555555
    doc.text(contactLine.trim(), MARGIN_X, y);
    y += CONTACT_LH;
  }

  // Reset to black + body font for everything that follows.
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(BODY_PT);
  doc.setFont('helvetica', 'normal');

  // 3. Date
  if (today && today.trim()) {
    y += SECTION_GAP;
    ensureRoom(1, BODY_LH);
    doc.text(today.trim(), MARGIN_X, y);
    y += BODY_LH;
  }

  // 4. Recipient block — consecutive lines tight together, gap after the block
  if (Array.isArray(recipient) && recipient.length > 0) {
    const cleaned = recipient.map(l => String(l || '').trim()).filter(Boolean);
    if (cleaned.length > 0) {
      y += SECTION_GAP;
      for (const line of cleaned) {
        ensureRoom(1, BODY_LH);
        doc.text(line, MARGIN_X, y);
        y += BODY_LH;
      }
    }
  }

  // 5. Salutation
  if (salutation && salutation.trim()) {
    y += SECTION_GAP;
    ensureRoom(1, BODY_LH);
    doc.text(salutation.trim(), MARGIN_X, y);
    y += BODY_LH;
  }

  // 6. Body paragraphs — section gap before first, smaller gap between
  //    subsequent. Justified (align: 'justify') stretches inter-word space
  //    so each line except the last reaches the right margin.
  let firstBodyParagraph = true;
  for (const para of (paragraphs || [])) {
    if (para == null) continue;
    const lines = doc.splitTextToSize(String(para), textW);
    y += firstBodyParagraph ? SECTION_GAP : PARA_GAP;
    firstBodyParagraph = false;
    ensureRoom(lines.length, BODY_LH);
    doc.text(lines, MARGIN_X, y, { align: 'justify', maxWidth: textW });
    y += lines.length * BODY_LH;
  }

  // 7. Sign-off
  if (signOff && signOff.trim()) {
    y += SECTION_GAP;
    ensureRoom(1, BODY_LH);
    doc.text(signOff.trim(), MARGIN_X, y);
    y += BODY_LH;
  }

  // 8. Signature — extra-large gap leaves room for a handwritten signature
  if (signature && signature.trim()) {
    y += SIG_GAP;
    ensureRoom(1, BODY_LH);
    doc.text(signature.trim(), MARGIN_X, y);
    y += BODY_LH;
  }
}
