import { describe, expect, it } from 'vitest';

import { parse, serialize } from '@reporting/tokens';

import { importCorpus } from './index.js';

/**
 * The fidelity gate (plan §17, P1 exit criterion): 427 files in, 427 files out,
 * byte for byte. This is the most important test in the build — every other
 * assertion downstream is about a document that these tokens represent.
 */
const result = importCorpus();

describe('corpus inventory', () => {
  it('imports every file the manifest names', () => {
    expect(result.stats.files).toBe(427);
    expect(result.stats.imported).toBe(427);
    expect(result.stats.quarantined).toBe(0);
    expect(result.quarantine).toEqual([]);
  });

  it('round-trips every file', () => {
    expect(result.stats.round_trip_pass).toBe(427);
    expect(result.stats.round_trip_fail).toBe(0);
  });

  it('agrees with the export on every file size', () => {
    const mismatched = result.provenance.filter((record) => record.bytes !== record.manifest_bytes);

    expect(mismatched).toEqual([]);
  });

  it('has a hash for every file, and no duplicate paths', () => {
    const paths = new Set(result.provenance.map((record) => record.relpath));

    expect(paths.size).toBe(427);
    expect(result.provenance.every((record) => /^sha256:[0-9a-f]{64}$/.test(record.sha256))).toBe(
      true,
    );
  });
});

describe('provenance', () => {
  /**
   * The measured table from ADR-0004. If this changes, the licensing position
   * changed, and that is a conversation before it is a test update.
   */
  it('classifies by author metadata, not by the scope label', () => {
    expect(result.stats.by_provenance).toEqual({
      org_authored: 1,
      third_party: 130,
      unattributed: 128,
      unknown: 168,
    });
  });

  it('does not treat the organisation scope as an authorship claim', () => {
    const inOwnScope = result.provenance.filter((record) => record.scope === 'AlemHealth');
    const count = (cls: string): number =>
      inOwnScope.filter((record) => record.provenance === cls).length;

    // 290 files are filed under the organisation's own scope. Not one of them is
    // authored by a named organisation account: 123 carry a third-party id and
    // 167 carry no author at all. The scope label asserts an ownership the
    // metadata does not support.
    expect(inOwnScope).toHaveLength(290);
    expect(count('unattributed')).toBe(123);
    expect(count('unknown')).toBe(167);
    expect(count('org_authored')).toBe(0);
  });
});

describe('known corpus defects stay fixtures, not surprises', () => {
  it('keeps the double-bracket placeholder as one field', () => {
    const body = 'TECHNIQUE:\n[[with and without IV contrast]]';

    expect(serialize(parse(body).tokens)).toBe(body);
    expect(parse(body).fields).toHaveLength(1);
  });

  it('decodes exporter escape sequences instead of rendering them as text', () => {
    const leaked = result.templates.filter((template) =>
      template.tokens.some(
        (token) => token.kind === 'text' && /\\u[0-9a-f]{4}/i.test(token.value),
      ),
    );

    expect(leaked.map((template) => template.source_relpath)).toEqual([]);
  });

  it('records which files needed transforming, so the change is reviewable', () => {
    const allowed = new Set(['bom', 'crlf', 'escapes']);
    const flagged = result.provenance.filter((record) => record.transforms.length > 0);
    const flagsOnRecords = flagged.reduce((total, record) => total + record.transforms.length, 0);

    expect(flagged.every((record) => record.transforms.every((flag) => allowed.has(flag)))).toBe(
      true,
    );
    // Per-flag counters and per-record flags must describe the same set of files.
    expect(flagsOnRecords).toBe(
      result.stats.transformed.bom +
        result.stats.transformed.crlf +
        result.stats.transformed.escapes,
    );
  });
});
