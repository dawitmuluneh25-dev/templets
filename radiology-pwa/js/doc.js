/**
 * The report document model.
 *
 * A report's body is the template's token stream, split into sections. Editing
 * replaces a section's token array (text edits) while field values live in a
 * separate map keyed by field key - so re-rendering never destroys the
 * template's structure, and a signed report can always be reproduced verbatim.
 */

/** Splits a template token stream into level-1 sections. */
export function buildSections(template) {
  const sections = [];
  let current = null;

  for (const tk of template.tokens) {
    if (tk.t === 'heading' && tk.level === 1) {
      current = { heading: tk.text.trim(), level: 1, tokens: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      // Body opened with a sub-heading or bare text: synthesise a section so
      // nothing is lost.
      current = { heading: 'REPORT', level: 1, tokens: [] };
      sections.push(current);
    }
    current.tokens.push(tk);
  }

  // Free-text headings are written as `EXAM:` — the colon is a heading marker,
  // so it must not survive as the first body character (it would render as a
  // stray ":" line under every heading).
  for (const s of sections) {
    const first = s.tokens[0];
    if (first && first.t === 'text' && first.text.startsWith(':')) {
      // Drop the heading colon plus the single newline that followed it, so the
      // section body does not open with a blank line.
      s.tokens[0] = { ...first, text: first.text.slice(1).replace(/^[ \t]*\n?[ \t]*/, '') };
    } else if (first && first.t === 'text' && /^[ \t]*\n/.test(first.text)) {
      s.tokens[0] = { ...first, text: first.text.replace(/^[ \t]*\n[ \t]*/, '') };
    }
  }

  return sections;
}

export function createReport(template, opts = {}) {
  const now = new Date().toISOString();
  const report = {
    id: 'rep_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4),
    templateId: template.id,
    templateName: template.name,
    templateType: template.type,
    modality: template.modality,
    templateVersion: template.versionNo || 1,
    createdAt: now,
    updatedAt: now,
    state: 'draft',
    study: {
      accession: opts.accession || '',
      demographics: opts.demographics || '',
      indication: opts.indication || '',
    },
    sections: buildSections(template).map((s) => ({
      heading: s.heading,
      level: s.level,
      tokens: s.tokens.map((t) => ({ ...t })),
    })),
    fieldValues: {},
    acknowledged: [],
    signedAt: null,
    signedBy: null,
  };
  // Snapshot of the untouched rendering: lets validation tell "reviewed" apart
  // from "pristine boilerplate", which is the single most dangerous sign-off.
  report.baselineHash = contentHash(reportText(report));
  return report;
}

/** Value for a field, or '' when unfilled. */
export function fieldValue(report, key) {
  const v = report.fieldValues?.[key];
  return v === undefined || v === null ? '' : String(v);
}

/** Renders one section to plain text. Unfilled fields render as [hint]. */
export function renderSection(report, section, { includeUnfilled = true } = {}) {
  let out = '';
  for (const tk of section.tokens) {
    if (tk.t === 'text') out += tk.text;
    else if (tk.t === 'heading') out += (tk.prefix || '') + tk.text;
    else if (tk.t === 'field') {
      const v = fieldValue(report, tk.key);
      if (v) out += v;
      else if (includeUnfilled) out += tk.raw || '';
    }
  }
  return out;
}

/** Full report text, headings included. */
export function reportText(report, opts = {}) {
  const parts = [];
  for (const s of report.sections) {
    const body = renderSection(report, s, opts).replace(/\s+$/, '');
    parts.push(`${s.heading}\n${body}`.replace(/^\s*\n/, ''));
  }
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Report text with unfilled placeholders omitted (for word counts / quality checks). */
export function filledText(report) {
  return reportText(report, { includeUnfilled: false });
}

export function sectionByHeading(report, heading) {
  return report.sections.find((s) => s.heading.trim().toUpperCase() === heading.toUpperCase()) || null;
}

export function wordCount(text) {
  return (text.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) || []).length;
}

/** Fields belonging to a section, in document order. */
export function fieldsInSection(template, section) {
  const keys = new Set(
    section.tokens.filter((t) => t.t === 'field').map((t) => t.key)
  );
  return (template?.fields || []).filter((f) => keys.has(f.key));
}

export function isEmptyReport(report) {
  return report.sections.every((s) => s.tokens.every((t) => t.t !== 'text' || !t.text.trim()));
}

/** Stable, cheap content hash used to detect unmodified boilerplate. */
export function contentHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** True when the report still renders byte-identically to the template default. */
export function isUnmodified(report) {
  if (!report.baselineHash) return false;
  return contentHash(reportText(report)) === report.baselineHash;
}
