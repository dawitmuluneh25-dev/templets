/**
 * import-templates.mjs
 *
 * Converts the exported AlemHealth report templates (.md) into versioned
 * token-stream JSON for the PWA.
 *
 * Contract: render(parse(body)) === body, byte for byte, for every file.
 * If that invariant fails for a file, the file is quarantined rather than
 * silently shipped with altered clinical wording.
 *
 * Usage: node tools/import-templates.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.resolve(ROOT, '..', 'alem-reporting-templates');
const OUT = path.join(ROOT, 'data', 'templates.json');

// Top-level report sections observed in the corpus. Anything else that looks
// like an UPPERCASE heading is treated as a level-2 organ/system sub-heading
// inside the currently open section (e.g. BONES, SOFT TISSUES under FINDINGS).
const CANONICAL = new Set([
  'EXAM', 'EXAMINATION', 'CLINICAL HISTORY', 'CLINICAL INFORMATION', 'INDICATION',
  'TECHNIQUE', 'PROTOCOL', 'CONTRAST', 'COMPARISON', 'FINDINGS', 'IMPRESSION',
  'CONCLUSION', 'RECOMMENDATION', 'RECOMMENDATIONS', 'ADDITIONAL',
  'ADDITIONAL FINDINGS', 'LIMITATIONS', 'SUMMARY',
]);

const UNITS = ['mm', 'cm', 'm', 'ml', 'cc', 'HU', 'degrees', 'degree', '%', 'kg', 'mg', 's', 'min'];
const UNIT_RE = new RegExp(`^(${UNITS.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

const HEADING_COLON_RE = /^([A-Z][A-Z0-9 \-\/&(),.'’]{2,45}):\s*$/;
const HEADING_MD_RE = /^(#{1,6})\s+(.+?)\s*$/;
// Some templates wrap a placeholder in a second pair of brackets:
//   [[with and without IV contrast]]
// Both forms must become ONE field, otherwise the outer brackets survive as
// literal text and trip the placeholder-leak check.
function balanced(s) {
  let d = 0;
  for (const c of s) {
    if (c === '[') d += 1;
    else if (c === ']') { d -= 1; if (d < 0) return false; }
  }
  return d === 0;
}

/**
 * Depth-aware placeholder scanner.
 *
 * Placeholders in this corpus nest: `[[with or without]]` wraps a normal
 * placeholder, and `[[No enhancing lesions / [___] ...]]` puts a blank inside a
 * choice. A flat regex either stops at the inner bracket (leaving literal
 * brackets in the report) or lazily swallows several placeholders into one, so
 * the span is found by matching bracket depth instead.
 *
 * Returns [{ start, end, inner }] with end exclusive.
 */
function scanFields(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '[') {
      i += 1;
      continue;
    }
    let depth = 0;
    let j = i;
    let closed = false;
    for (; j < line.length; j++) {
      if (line[j] === '[') depth += 1;
      else if (line[j] === ']') {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          break;
        }
      }
    }
    if (!closed) {
      i += 1; // unmatched '[' is literal text
      continue;
    }
    const inner = line.slice(i + 1, j);
    if (inner.length > 200) {
      i += 1;
      continue;
    }
    out.push({ start: i, end: j + 1, inner });
    i = j + 1;
  }
  return out;
}

/* ------------------------------------------------------------------ utils */

function slug(s, fallback = 'field') {
  const out = String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return out || fallback;
}

function readTemplate(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/);

  // Header block = everything before the first bare '---' divider.
  let divider = lines.findIndex((l) => l.trim() === '---');
  let headerLines;
  let bodyLines;
  if (divider === -1) {
    // No divider: treat the whole file as body (defensive).
    headerLines = [];
    bodyLines = lines;
  } else {
    headerLines = lines.slice(0, divider);
    bodyLines = lines.slice(divider + 1);
  }

  const meta = {};
  for (const line of headerLines) {
    const m = /^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/.exec(line);
    if (m) meta[m[1].trim()] = m[2].trim();
  }

  // Body: drop a single leading blank line introduced by the divider, but keep
  // everything else exactly as-is so round-tripping is possible.
  if (bodyLines.length && bodyLines[0].trim() === '') bodyLines = bodyLines.slice(1);

  return { meta, body: cleanBody(bodyLines.join('\n')) };
}

/**
 * The source export leaked HTML escape sequences as literal text
 * ("iterative\\u00a0reconstruction" instead of a normal space). Left in place
 * they render as visible noise in the editor and the PDF, so they are decoded
 * once at import; the round-trip check runs against this cleaned body.
 */
function cleanBody(body) {
  return body
    .replace(/\\u00a0/gi, ' ')
    .replace(/\\u0000/gi, '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => {
      const code = parseInt(hex, 16);
      return code >= 32 && code < 127 ? String.fromCharCode(code) : '';
    });
}

/* ------------------------------------------------------------ field typing */

/**
 * Classifies a bracket placeholder into a typed field.
 * Deterministic rules only - no model inference at import time.
 */
function classifyPlaceholder(inner, afterText) {
  const raw = inner;
  const trimmed = inner.trim();
  const after = (afterText || '').slice(0, 24);

  // [none / prior study dated ___]
  if (/dated/i.test(trimmed)) {
    return { type: 'dateOrNone', placeholder: raw };
  }

  // Multi-slot measurement: [__ x __ x __ cm]
  if (/_{2,}\s*[x×]\s*_{2,}\s*[x×]\s*_{2,}/i.test(trimmed)) {
    const unit = (UNIT_RE.exec(after) || [])[1] || (UNIT_RE.exec(trimmed) || [])[1] || null;
    return { type: 'multislot', slotCount: 3, unit: unit ? unit.toLowerCase() : null, placeholder: raw };
  }

  // Choice list: [with or without], [left/right], [mild/moderate/severe]
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/').map((p) => p.trim()).filter(Boolean);
    const looksLikeChoice =
      parts.length >= 2 &&
      parts.length <= 8 &&
      parts.every((p) => p.length <= 28 && !/[.!?;:]/.test(p)) &&
      !/_{2,}/.test(trimmed);
    if (looksLikeChoice) {
      return { type: 'enum', options: parts, placeholder: raw };
    }
  }

  // Pure blank: [_], [___], [], [_ _]
  if (trimmed === '' || /^[_ ]+$/.test(trimmed)) {
    const unit = (UNIT_RE.exec(after) || [])[1];
    if (unit) return { type: 'number', unit: unit.toLowerCase(), placeholder: raw, blank: trimmed };
    return { type: 'text', placeholder: raw, blank: trimmed };
  }

  // Numeric word hints
  if (/^number$|_number_/i.test(trimmed.replace(/\s+/g, ''))) {
    return { type: 'number', unit: null, placeholder: raw };
  }

  // Semantic free text: [insert history], [location], [generic]
  const unit = (UNIT_RE.exec(after) || [])[1];
  if (unit && /_{1,}/.test(trimmed)) {
    return { type: 'number', unit: unit.toLowerCase(), placeholder: raw };
  }

  return { type: 'text', placeholder: raw };
}

/* ---------------------------------------------------------------- parsing */

function labelFor(cls, section) {
  if (cls.type === 'enum') return cls.options.join(' / ');
  if (cls.type === 'number') return cls.unit ? `measurement (${cls.unit})` : 'number';
  if (cls.type === 'multislot') return `measurement ${cls.slotCount} values (${cls.unit || 'unit'})`;
  if (cls.type === 'dateOrNone') return 'prior study date';
  const t = (cls.placeholder || '').trim();
  return t ? t.replace(/_+/g, '').trim() || 'free text' : 'free text';
}

/**
 * The renderer above is only correct if headings keep their original marker.
 * To guarantee that, the parser records the exact marker prefix on each
 * heading token. This wrapper is the authoritative round-trip renderer.
 */
function renderExact(tokens) {
  let out = '';
  for (const tk of tokens) {
    if (tk.t === 'text') out += tk.text;
    else if (tk.t === 'heading') out += (tk.prefix || '') + tk.text;
    else if (tk.t === 'field') out += tk.raw;
  }
  return out;
}

/* ------------------------------------------------------------------ main */

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * The .md headers carry only the base template name; the variant relationship
 * lives in the export's index CSV (`XR Chest [variant: XR Chest]`). Read it so
 * 126 variant files are grouped instead of appearing as duplicate cards.
 */
function readIndex() {
  const csvPath = path.join(SRC, 'templates_index.csv');
  if (!fs.existsSync(csvPath)) return new Map();
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift() || [];
  const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const map = new Map();
  for (const r of rows) {
    if (!r.length) continue;
    const file = r[idx.file_name];
    if (!file) continue;
    const display = r[idx.site_display_name] || '';
    const m = /^(.*?)\s*\[variant:\s*(.*?)\]$/.exec(display);
    map.set(file, {
      displayName: display,
      baseName: m ? m[1].trim() : display,
      variantLabel: m ? m[2].trim() : null,
    });
  }
  return map;
}

function main() {
  const files = [...listFiles(path.join(SRC, 'AlemHealth')), ...listFiles(path.join(SRC, 'Publicly Shared'))];
  const indexMap = readIndex();
  if (!files.length) {
    console.error(`No .md files found under ${SRC}`);
    process.exit(1);
  }

  const templates = [];
  const quarantined = [];
  const stats = {
    files: files.length,
    byType: {},
    byModality: {},
    byScope: {},
    fields: 0,
    fieldsByType: {},
    templatesWithFields: 0,
    roundTripPass: 0,
    roundTripFail: 0,
    // Templates whose remaining plain text still contains bracket runs. These
    // are the ones that can trip the UI placeholder-leak check, so the number
    // is reported explicitly rather than hidden.
    residualBracketTemplates: 0,
  };

  for (const file of files) {
    const { meta, body } = readTemplate(file);
    const type = (meta.Type || 'FREE_TEXT').toUpperCase();
    const name = meta['Template Name'] || path.basename(file, '.md');

    // Re-parse with exact heading markers preserved.
    const parsed = parseBodyWithMarkers(body, type);

    const rendered = renderExact(parsed.tokens);
    if (rendered !== body) {
      stats.roundTripFail += 1;
      quarantined.push({
        file: path.basename(file),
        reason: 'round-trip mismatch',
        firstDiff: firstDiff(rendered, body),
      });
      continue;
    }
    stats.roundTripPass += 1;

    const fromIndex = indexMap.get(path.basename(file)) || null;
    const displayName = fromIndex?.displayName || name;
    const baseName = fromIndex?.baseName || name;
    const variantLabel = fromIndex ? fromIndex.variantLabel : null;

    const id = 'tpl_' + slug(meta.GUID || path.basename(file, '.md')).slice(0, 40) +
      '_' + slug(path.basename(file, '.md')).slice(-6);

    stats.byType[type] = (stats.byType[type] || 0) + 1;
    const mod = meta.Modality || 'unset';
    stats.byModality[mod] = (stats.byModality[mod] || 0) + 1;
    const scope = meta.Scope || 'unknown';
    stats.byScope[scope] = (stats.byScope[scope] || 0) + 1;
    if (parsed.tokens.some((t) => t.t === 'text' && /\[[^\]\n]{1,80}\]/.test(t.text))) {
      stats.residualBracketTemplates += 1;
    }

    stats.fields += parsed.fields.length;
    if (parsed.fields.length) stats.templatesWithFields += 1;
    for (const f of parsed.fields) stats.fieldsByType[f.type] = (stats.fieldsByType[f.type] || 0) + 1;

    templates.push({
      id,
      name: displayName,
      baseName,
      variantLabel,
      scope,
      modality: mod,
      type,
      author: meta.Author && meta.Author !== '-' ? meta.Author : null,
      status: meta.Status || 'Active',
      guid: meta.GUID || null,
      versionNo: 1,
      sections: parsed.sections,
      tokens: parsed.tokens,
      fields: parsed.fields,
      charCount: body.length,
      sourceFile: path.basename(file),
      sourceFolder: path.basename(path.dirname(file)),
    });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    sourceSystem: 'alembhealth-connect',
    sourceNote:
      'Imported from connect.alem.health > Settings > Report Templates. Bodies verified by round-trip render.',
    stats: { ...stats, templates: templates.length, quarantined: quarantined.length },
    quarantined,
    templates,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload), 'utf8');

  const sizeMb = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2);
  console.log('--- import summary ---');
  console.log(`files            ${stats.files}`);
  console.log(`imported         ${templates.length}`);
  console.log(`quarantined      ${quarantined.length}`);
  console.log(`round-trip pass  ${stats.roundTripPass}`);
  console.log(`round-trip fail  ${stats.roundTripFail}`);
  console.log(`by type          ${JSON.stringify(stats.byType)}`);
  console.log(`by modality      ${JSON.stringify(stats.byModality)}`);
  console.log(`fields           ${stats.fields} (${stats.templatesWithFields} templates)`);
  console.log(`field types      ${JSON.stringify(stats.fieldsByType)}`);
  console.log(`output           ${OUT} (${sizeMb} MB)`);
  if (quarantined.length) {
    console.log('QUARANTINED:');
    for (const q of quarantined.slice(0, 20)) console.log('  ', q.file, '|', q.reason, '|', q.firstDiff);
    process.exitCode = 2;
  }
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      return `at ${i}: got ${JSON.stringify(a.slice(Math.max(0, i - 15), i + 15))} want ${JSON.stringify(b.slice(Math.max(0, i - 15), i + 15))}`;
    }
  }
  return `length ${a.length} vs ${b.length}`;
}

/* Parser variant that records the exact heading marker so round-tripping is
 * exact (the marker is template content, not decoration). */
function parseBodyWithMarkers(body, templateType) {
  const tokens = [];
  const fields = [];
  const sections = [];
  let currentSection = null;
  let fieldSeq = 0;
  const usedKeys = new Set();

  const pushText = (text) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.t === 'text') last.text += text;
    else tokens.push({ t: 'text', text });
  };

  const pushHeading = (level, name, prefix) => {
    tokens.push({ t: 'heading', level, text: name, prefix });
    if (level === 1) {
      currentSection = name.trim();
      sections.push(name.trim());
    }
  };

  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isLast = i === lines.length - 1;

    const md = HEADING_MD_RE.exec(line);
    if (md) {
      // '##' is the section level in the STRUCTURED family, so it maps to
      // level 1; deeper markers keep their relative depth. Without this the
      // structured templates collapse into one unnamed section.
      const depth = md[1].length;
      const level = depth <= 2 ? 1 : depth - 1;
      pushHeading(level, md[2], '#'.repeat(depth) + ' ');
      pushText('\n');
      continue;
    }

    const hc = HEADING_COLON_RE.exec(line);
    if (hc) {
      // Keep the captured text verbatim (some headings have a space before the
      // colon: 'CTA CHEST :'). Trim only for lookup/slug purposes.
      const exact = hc[1];
      const name = exact.trim();
      const level = CANONICAL.has(name) || currentSection === null ? 1 : 2;
      pushHeading(level, exact, '');
      pushText(line.slice(exact.length) + '\n'); // keeps ':' and trailing spaces
      continue;
    }

    let lastIndex = 0;
    for (const span of scanFields(line)) {
      pushText(line.slice(lastIndex, span.start));
      const after = line.slice(span.end);

      // Strip redundant wrapper brackets: [[with or without]] -> with or without
      let inner = span.inner;
      while (inner.length > 2 && inner.startsWith('[') && inner.endsWith(']') && balanced(inner.slice(1, -1))) {
        inner = inner.slice(1, -1);
      }
      const raw = line.slice(span.start, span.end);
      const cls = /[\[\]]/.test(inner)
        ? { type: 'text', placeholder: inner }
        : classifyPlaceholder(inner, after);
      fieldSeq += 1;

      const baseKey = `${slug(currentSection || 'body')}__${slug(inner || 'blank')}`;
      let key = baseKey;
      let n = 1;
      while (usedKeys.has(key)) {
        n += 1;
        key = `${baseKey}_${n}`;
      }
      usedKeys.add(key);

      fields.push({
        key,
        ordinal: fieldSeq,
        placeholder: cls.placeholder,
        raw,
        type: cls.type,
        label: labelFor(cls, currentSection),
        section: currentSection,
        ...(cls.options ? { options: cls.options } : {}),
        ...(cls.unit ? { unit: cls.unit } : {}),
        ...(cls.slotCount ? { slotCount: cls.slotCount } : {}),
      });

      tokens.push({ t: 'field', key, raw });
      lastIndex = span.end;
    }
    pushText(line.slice(lastIndex));
    if (!isLast) pushText('\n');
  }

  return { tokens, fields, sections, templateType };
}

main();
