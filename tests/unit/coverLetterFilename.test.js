import { describe, it, expect } from 'vitest';
import { buildCoverLetterFilename } from '../../lib/coverLetterFilename.mjs';

const FIXED_DATE = new Date(2026, 4, 11); // May 11, 2026 (months are 0-indexed)

describe('buildCoverLetterFilename', () => {
  it('formats the standard case with company + title + date', () => {
    expect(buildCoverLetterFilename('Google', 'Software Engineer', FIXED_DATE, 'docx'))
      .toBe('CoverLetter_Google_Software-Engineer_20260511.docx');
  });

  it('hyphenates multi-word segments', () => {
    expect(buildCoverLetterFilename('Capital One', 'Senior ML Engineer, Risk', FIXED_DATE, 'pdf'))
      .toBe('CoverLetter_Capital-One_Senior-ML-Engineer-Risk_20260511.pdf');
  });

  it('strips special chars and collapses runs of hyphens', () => {
    expect(buildCoverLetterFilename('AT&T', 'C++ Engineer', FIXED_DATE, 'docx'))
      .toBe('CoverLetter_AT-T_C-Engineer_20260511.docx');
  });

  it('truncates long titles at the last hyphen before char 30', () => {
    const longTitle = 'Senior Principal Software Engineer, Machine Learning Platforms';
    const result = buildCoverLetterFilename('Google', longTitle, FIXED_DATE, 'docx');
    // The title segment is "Senior-Principal-Software-Engineer-..." truncated at a hyphen boundary at or before char 30.
    expect(result).toMatch(/^CoverLetter_Google_[A-Za-z0-9-]{1,30}_20260511\.docx$/);
    // Must end on a word, not mid-word (the char before the trailing "_20260511" should be a letter/digit, not a hyphen)
    const titleSegment = result.replace(/^CoverLetter_Google_/, '').replace(/_20260511\.docx$/, '');
    expect(titleSegment).not.toMatch(/-$/);
    expect(titleSegment.length).toBeLessThanOrEqual(30);
  });

  it('uses "Unknown" when company is empty', () => {
    expect(buildCoverLetterFilename('', 'Software Engineer', FIXED_DATE, 'docx'))
      .toBe('CoverLetter_Unknown_Software-Engineer_20260511.docx');
  });

  it('drops the title segment when title is empty', () => {
    expect(buildCoverLetterFilename('Google', '', FIXED_DATE, 'docx'))
      .toBe('CoverLetter_Google_20260511.docx');
  });

  it('uses "Unknown" + no title when both are empty', () => {
    expect(buildCoverLetterFilename('', '', FIXED_DATE, 'docx'))
      .toBe('CoverLetter_Unknown_20260511.docx');
  });

  it('formats date as YYYYMMDD with zero-padding', () => {
    const earlyDate = new Date(2026, 0, 3); // January 3, 2026
    expect(buildCoverLetterFilename('Google', 'Engineer', earlyDate, 'pdf'))
      .toBe('CoverLetter_Google_Engineer_20260103.pdf');
  });

  it('trims whitespace from inputs', () => {
    expect(buildCoverLetterFilename('  Google  ', '  Software Engineer  ', FIXED_DATE, 'docx'))
      .toBe('CoverLetter_Google_Software-Engineer_20260511.docx');
  });
});
