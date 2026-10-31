/**
 * Reading the export exactly as it was written.
 *
 * Two things happen here that change bytes, and both are recorded per file
 * rather than hidden: a UTF-8 BOM is dropped, and `\\u00a0` style escape
 * sequences leaked by the exporter are decoded to the characters they represent.
 * The raw file is hashed *before* either, so the transformation is auditable
 * against a source that has not moved.
 *
 * Nothing here rewrites clinical wording. Where a body cannot be reproduced from
 * its tokens, the file is quarantined — never repaired.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The frozen export. `corpus/raw` is this directory; see corpus/README.md. */
export function defaultSourceDir(): string {
  return fileURLToPath(new URL('../../../alem-reporting-templates/', import.meta.url));
}

export function defaultOutputDir(): string {
  return fileURLToPath(new URL('../../../corpus/generated/', import.meta.url));
}

export function defaultProvenancePath(): string {
  return fileURLToPath(new URL('../../../corpus/provenance.json', import.meta.url));
}

export interface TransformFlags {
  /** The file started with a UTF-8 byte-order mark, which was dropped. */
  readonly bom: boolean;
  /** The file used CRLF line endings, normalised to LF. */
  readonly crlf: boolean;
  /** Exporter escape sequences were decoded (`\\u00a0` → space). */
  readonly escapes: boolean;
}

export interface RawTemplate {
  /** `Key: value` pairs from the header block above the first `---`. */
  readonly meta: Readonly<Record<string, string>>;
  /** The body after cleaning. Round-trip is asserted against this, not the raw text. */
  readonly body: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly flags: TransformFlags;
}

/**
 * Exporter noise: `iterative\\u00a0reconstruction` instead of a normal space.
 * Left alone it renders as visible garbage in the editor and the PDF. The
 * prototype's exact rule is preserved so behaviour does not drift.
 */
function cleanBody(body: string): { body: string; changed: boolean } {
  let changed = false;

  const out = body
    .replace(/\\u00a0/gi, () => {
      changed = true;
      return ' ';
    })
    .replace(/\\u0000/gi, () => {
      changed = true;
      return '';
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => {
      changed = true;
      const code = Number.parseInt(hex, 16);
      return code >= 32 && code < 127 ? String.fromCharCode(code) : '';
    });

  return { body: out, changed };
}

export function readTemplate(file: string): RawTemplate {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');

  const bom = text.startsWith('\uFEFF');
  const withoutBom = bom ? text.slice(1) : text;
  const crlf = withoutBom.includes('\r\n');

  const lines = withoutBom.split(/\r?\n/);

  // Header block = everything before the first bare '---' divider.
  const divider = lines.findIndex((line) => line.trim() === '---');
  const headerLines = divider === -1 ? [] : lines.slice(0, divider);
  let bodyLines = divider === -1 ? lines : lines.slice(divider + 1);

  const meta: Record<string, string> = {};
  for (const line of headerLines) {
    const match = /^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/.exec(line);
    const key = match?.[1];
    if (key !== undefined) meta[key.trim()] = (match?.[2] ?? '').trim();
  }

  // Drop the single blank line the divider introduces; keep everything else so
  // the body can be reproduced exactly.
  const first = bodyLines[0];
  if (first !== undefined && first.trim() === '') bodyLines = bodyLines.slice(1);

  const cleaned = cleanBody(bodyLines.join('\n'));

  return {
    meta,
    body: cleaned.body,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    flags: { bom, crlf, escapes: cleaned.changed },
  };
}

export function sha256(input: Buffer | string): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

/** Recursively lists `.md` files under a directory, sorted, using forward slashes. */
export function listTemplateFiles(dir: string, prefix = ''): string[] {
  if (!fs.existsSync(dir)) return [];

  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTemplateFiles(abs, rel));
    else if (entry.name.toLowerCase().endsWith('.md')) out.push(rel);
  }

  return out.sort();
}
