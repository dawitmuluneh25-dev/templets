/**
 * Three-tier validation.
 *
 *   hard  - blocks sign-off
 *   soft  - signable after an explicit acknowledgement, recorded in the audit log
 *   nudge - advisory only
 *
 * Required-ness is derived per template, never globally: 35 templates in the
 * imported corpus have no IMPRESSION section and 10 have no FINDINGS, so a
 * global "IMPRESSION required" rule would make them impossible to sign.
 */

import {
  sectionByHeading,
  renderSection,
  wordCount,
  filledText,
  fieldValue,
  isEmptyReport,
  isUnmodified,
} from './doc.js';

const LITERAL_BRACKETS = /\[[^\]\n]{1,80}\]/;

export function validate(report, template) {
  const issues = [];

  const push = (severity, message, opts = {}) =>
    issues.push({
      id: opts.id || `${severity}:${issues.length}`,
      severity,
      message,
      section: opts.section || null,
      fieldKey: opts.fieldKey || null,
      action: opts.action || null,
    });

  const headings = new Set(report.sections.map((s) => s.heading.trim().toUpperCase()));

  /* ------------------------------------------------------------- hard tier */

  if (isEmptyReport(report)) {
    push('hard', 'The report is empty. Fill at least the findings and impression.', {
      id: 'empty',
      section: report.sections[0]?.heading,
    });
  }

  const exam = sectionByHeading(report, 'EXAM');
  if (exam && !renderSection(report, exam, { includeUnfilled: false }).trim()) {
    push('hard', 'EXAM is empty. State the examination performed.', { id: 'exam-empty', section: exam.heading });
  }

  // Only enforced when the template actually contains the section.
  for (const required of ['IMPRESSION', 'FINDINGS']) {
    if (!headings.has(required)) continue;
    const sec = sectionByHeading(report, required);
    const filled = renderSection(report, sec, { includeUnfilled: false }).trim();
    if (!filled) {
      push(
        'hard',
        `${required} is empty. This template includes that section, so it must be completed before signing.`,
        { id: `${required}-empty`, section: sec.heading }
      );
    }
  }

  // Typed-in literal brackets that were never converted to a field (or a field
  // hint the user left as text) are the highest-value leak check: fast readers
  // sign reports with "___" still in them.
  for (const s of report.sections) {
    for (const tk of s.tokens) {
      if (tk.t === 'text' && LITERAL_BRACKETS.test(tk.text)) {
        const m = LITERAL_BRACKETS.exec(tk.text);
        push('hard', `Unresolved placeholder text in ${s.heading}: "${m[0]}". Replace it or remove it.`, {
          id: 'placeholder-leak:' + s.heading,
          section: s.heading,
        });
        break;
      }
    }
  }

  // Numeric fields must parse when filled.
  for (const f of template?.fields || []) {
    const v = fieldValue(report, f.key);
    if (!v) continue;
    if (f.type === 'number' || f.type === 'multislot') {
      const nums = v.split(/[x×]/).map((p) => p.trim()).filter(Boolean);
      const bad = nums.length === 0 || nums.some((n) => Number.isNaN(Number.parseFloat(n)));
      if (bad) {
        push('hard', `"${v}" is not a number for ${f.label}. Enter digits only (unit is ${f.unit || 'free'}).`, {
          id: 'bad-number:' + f.key,
          fieldKey: f.key,
          section: f.section,
        });
      }
    }
  }

  /* ------------------------------------------------------------- soft tier */

  const comparison = sectionByHeading(report, 'COMPARISON');
  if (comparison && !renderSection(report, comparison, { includeUnfilled: false }).trim()) {
    push('soft', 'COMPARISON is empty. State "None provided." or cite the prior study.', {
      id: 'comparison-empty',
      section: comparison.heading,
    });
  }

  const detail = filledText(report);
  const impression = sectionByHeading(report, 'IMPRESSION');
  if (impression && headings.has('FINDINGS') && !renderSection(report, sectionByHeading(report, 'FINDINGS'), { includeUnfilled: false }).trim()) {
    push('soft', 'IMPRESSION is filled but FINDINGS is empty — the reasoning is not visible in the report.', {
      id: 'findings-missing-support',
      section: 'FINDINGS',
    });
  }

  const unfilled = (template?.fields || []).filter(
    (f) => (f.type === 'enum' || f.type === 'dateOrNone') && !fieldValue(report, f.key)
  );
  if (unfilled.length) {
    const sample = unfilled.slice(0, 3).map((f) => `"${f.label}"`).join(', ');
    push(
      'soft',
      `${unfilled.length} structured field${unfilled.length > 1 ? 's' : ''} left unset (${sample}${unfilled.length > 3 ? ', …' : ''}).`,
      { id: 'unfilled-fields', action: 'focus-first-field', fieldKey: unfilled[0].key, section: unfilled[0].section }
    );
  }

  if (unfilled.length === 0 && (template?.fields || []).length > 0) {
    // all good, nothing to add
  }

  /* ------------------------------------------------------------ nudge tier */

  if (impression) {
    const impText = renderSection(report, impression, { includeUnfilled: false }).trim();
    const wc = wordCount(impText);
    if (impText && wc < 8) {
      push('nudge', `IMPRESSION is only ${wc} word${wc === 1 ? '' : 's'}. A referring clinician may not be able to act on it.`, {
        id: 'impression-brief',
        section: 'IMPRESSION',
      });
    }
  }

  const findings = sectionByHeading(report, 'FINDINGS');
  if (findings) {
    const wc = wordCount(renderSection(report, findings, { includeUnfilled: false }));
    if (wc > 0 && wc < 25) {
      push('nudge', `FINDINGS is only ${wc} words for this template — check nothing was left out.`, {
        id: 'findings-brief',
        section: 'FINDINGS',
      });
    }
  }

  if (detail.trim() && !/\b(no|none|without|unremarkable|normal|within normal limits)\b/i.test(detail)) {
    push('nudge', 'No explicitly normal phrasing found. Confirm this is intentional for a study with findings.', {
      id: 'no-normal-phrase',
    });
  }

  /* Unmodified boilerplate is a hard block, not a nudge: the template's default
   * findings describe a hypothetical patient and are the most dangerous thing
   * to sign unread. */
  if (isUnmodified(report)) {
    issues.unshift({
      id: 'unmodified',
      severity: 'hard',
      message:
        'This report is still the unmodified template text. Review each finding against the images before signing.',
      section: report.sections[0]?.heading || null,
      fieldKey: null,
      action: null,
    });
  }

  /* ---------------------------------------------------------------- summary */

  const acked = new Set(report.acknowledged || []);
  const counts = {
    hard: issues.filter((i) => i.severity === 'hard').length,
    soft: issues.filter((i) => i.severity === 'soft').length,
    nudge: issues.filter((i) => i.severity === 'nudge').length,
    softUnacked: issues.filter((i) => i.severity === 'soft' && !acked.has(i.id)).length,
  };

  return {
    issues,
    counts,
    canSign: counts.hard === 0 && counts.softUnacked === 0,
  };
}
