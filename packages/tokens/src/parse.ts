/**
 * The parser. A direct port of the prototype's importer so that behaviour is
 * preserved rather than re-derived: the corpus is the specification, and a
 * cleaner parser that classifies a field differently is a regression wearing a
 * refactor's clothes.
 *
 * Deterministic rules only. Nothing here infers meaning from clinical wording.
 */
import { TOKEN_SCHEMA_VERSION } from './types.js';
import type { FieldDescriptor, FieldType, ParsedBody, Token } from './types.js';

/**
 * Top-level report sections observed in the corpus. Anything else that looks
 * like an upper-case heading is a level-2 organ/system sub-heading inside the
 * currently open section (BONES under FINDINGS).
 */
const CANONICAL = new Set([
  'EXAM',
  'EXAMINATION',
  'CLINICAL HISTORY',
  'CLINICAL INFORMATION',
  'INDICATION',
  'TECHNIQUE',
  'PROTOCOL',
  'CONTRAST',
  'COMPARISON',
  'FINDINGS',
  'IMPRESSION',
  'CONCLUSION',
  'RECOMMENDATION',
  'RECOMMENDATIONS',
  'ADDITIONAL',
  'ADDITIONAL FINDINGS',
  'LIMITATIONS',
  'SUMMARY',
]);

const UNITS = ['mm', 'cm', 'm', 'ml', 'cc', 'HU', 'degrees', 'degree', '%', 'kg', 'mg', 's', 'min'];

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const UNIT_RE = new RegExp(`^(${UNITS.map(escapeForRegExp).join('|')})\\b`, 'i');

const HEADING_COLON_RE = /^([A-Z][A-Z0-9 \-/&(),.'’]{2,45}):\s*$/;
const HEADING_MD_RE = /^(#{1,6})\s+(.+?)\s*$/;

interface Span {
  readonly start: number;
  readonly end: number;
  readonly inner: string;
}

/** True when every bracket in `s` is matched. */
function balanced(s: string): boolean {
  let depth = 0;
  for (const c of s) {
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * Depth-aware placeholder scanner.
 *
 * Placeholders in this corpus nest: `[[with or without]]` wraps a normal
 * placeholder, and `[[No enhancing lesions / [___] …]]` puts a blank inside a
 * choice. A flat regex either stops at the inner bracket (leaving literal
 * brackets in the report) or swallows several placeholders into one, so the span
 * is found by matching bracket depth.
 */
function scanFields(line: string): Span[] {
  const out: Span[] = [];
  let i = 0;

  while (i < line.length) {
    if (line.charAt(i) !== '[') {
      i += 1;
      continue;
    }

    let depth = 0;
    let j = i;
    let closed = false;

    for (; j < line.length; j += 1) {
      const ch = line.charAt(j);
      if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          closed = true;
          break;
        }
      }
    }

    if (!closed) {
      i += 1; // An unmatched '[' is literal text.
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

function slug(s: string, fallback = 'field'): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return out || fallback;
}

interface Classification {
  readonly type: FieldType;
  readonly placeholder: string;
  readonly options?: readonly string[];
  readonly unit?: string;
  readonly slotCount?: number;
}

/**
 * Classifies a bracket placeholder into a typed field.
 *
 * Order matters: a `dated` hint wins over a slash, because
 * `[none / prior study dated ___]` is a date suggestion, not a choice list.
 */
function classifyPlaceholder(inner: string, afterText: string): Classification {
  const raw = inner;
  const trimmed = inner.trim();
  const after = afterText.slice(0, 24);

  // [none / prior study dated ___]
  if (/dated/i.test(trimmed)) {
    return { type: 'dateOrNone', placeholder: raw };
  }

  // Multi-slot measurement: [__ x __ x __ cm]
  if (/_{2,}\s*[x×]\s*_{2,}\s*[x×]\s*_{2,}/i.test(trimmed)) {
    const unit = UNIT_RE.exec(after)?.[1] ?? UNIT_RE.exec(trimmed)?.[1] ?? null;
    return {
      type: 'multislot',
      slotCount: 3,
      ...(unit ? { unit: unit.toLowerCase() } : {}),
      placeholder: raw,
    };
  }

  // Choice list: [with or without], [left/right], [mild/moderate/severe]
  if (trimmed.includes('/')) {
    const parts = trimmed
      .split('/')
      .map((p) => p.trim())
      .filter(Boolean);
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
    const unit = UNIT_RE.exec(after)?.[1];
    if (unit) return { type: 'number', unit: unit.toLowerCase(), placeholder: raw };
    return { type: 'text', placeholder: raw };
  }

  // Numeric word hints.
  if (/^number$|_number_/i.test(trimmed.replace(/\s+/g, ''))) {
    return { type: 'number', placeholder: raw };
  }

  // A blank immediately followed by a unit is a measurement.
  const unit = UNIT_RE.exec(after)?.[1];
  if (unit && /_{1,}/.test(trimmed)) {
    return { type: 'number', unit: unit.toLowerCase(), placeholder: raw };
  }

  return { type: 'text', placeholder: raw };
}

function labelFor(cls: Classification): string {
  if (cls.type === 'enum' && cls.options) return cls.options.join(' / ');
  if (cls.type === 'number') return cls.unit ? `measurement (${cls.unit})` : 'number';
  if (cls.type === 'multislot')
    return `measurement ${cls.slotCount ?? 0} values (${cls.unit ?? 'unit'})`;
  if (cls.type === 'dateOrNone') return 'prior study date';

  const text = cls.placeholder.trim();
  return text.replace(/_+/g, '').trim() || 'free text';
}

/**
 * Parses a template body into tokens, fields and section names.
 *
 * The invariant this exists to support: `serialize(parse(body)) === body`.
 */
export function parse(body: string, templateType = 'FREE_TEXT'): ParsedBody {
  const tokens: Token[] = [];
  const fields: FieldDescriptor[] = [];
  const sections: string[] = [];
  const usedKeys = new Set<string>();

  let currentSection: string | null = null;
  let fieldSeq = 0;

  const pushText = (text: string): void => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.kind === 'text') {
      tokens[tokens.length - 1] = { kind: 'text', value: last.value + text };
    } else {
      tokens.push({ kind: 'text', value: text });
    }
  };

  const pushHeading = (level: 1 | 2, text: string, marker: string): void => {
    tokens.push({ kind: 'heading', level, text, marker });
    if (level === 1) {
      const name = text.trim();
      currentSection = name;
      sections.push(name);
    }
  };

  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const isLast = i === lines.length - 1;

    const md = HEADING_MD_RE.exec(line);
    if (md) {
      // '##' is the section level in the STRUCTURED family, so it maps to
      // level 1; deeper markers keep their relative depth. Without this the
      // structured templates collapse into one unnamed section.
      const depth = (md[1] ?? '#').length;
      const level: 1 | 2 = depth <= 2 ? 1 : 2;
      pushHeading(level, md[2] ?? '', '#'.repeat(depth) + ' ');
      pushText('\n');
      continue;
    }

    const colon = HEADING_COLON_RE.exec(line);
    if (colon) {
      // Keep the captured text verbatim: some headings carry a space before the
      // colon ('CTA CHEST :'). Trim only for lookup.
      const exact = colon[1] ?? '';
      const name = exact.trim();
      const level: 1 | 2 = CANONICAL.has(name) || currentSection === null ? 1 : 2;
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
      while (
        inner.length > 2 &&
        inner.startsWith('[') &&
        inner.endsWith(']') &&
        balanced(inner.slice(1, -1))
      ) {
        inner = inner.slice(1, -1);
      }

      const raw = line.slice(span.start, span.end);
      const cls = /[[\]]/.test(inner)
        ? ({ type: 'text', placeholder: inner } as const)
        : classifyPlaceholder(inner, after);

      fieldSeq += 1;

      const baseKey = `${slug(currentSection ?? 'body')}__${slug(inner || 'blank')}`;
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
        label: labelFor(cls),
        section: currentSection,
        ...(cls.options ? { options: cls.options } : {}),
        ...(cls.unit ? { unit: cls.unit } : {}),
        ...(cls.slotCount ? { slotCount: cls.slotCount } : {}),
      });

      tokens.push({ kind: 'field', key, raw, placeholder: cls.placeholder });
      lastIndex = span.end;
    }

    pushText(line.slice(lastIndex));
    if (!isLast) pushText('\n');
  }

  return {
    schema_version: TOKEN_SCHEMA_VERSION,
    template_type: templateType,
    tokens,
    fields,
    sections,
  };
}
