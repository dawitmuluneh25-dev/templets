import { describe, expect, it } from 'vitest';

import { TEMPLATE_SCHEMA_VERSION, classifyProvenance } from './index.js';

/**
 * Every case below is a row from the measured manifest, not an invented sample.
 * The counts in ADR-0004 depend on this function being right.
 */
describe('provenance classification', () => {
  it('pins the schema version', () => {
    expect(TEMPLATE_SCHEMA_VERSION).toBe(1);
  });

  it('treats an empty author as unknown rather than assuming ownership', () => {
    expect(classifyProvenance({ author: '' })).toBe('unknown');
    expect(classifyProvenance({ author: '   ' })).toBe('unknown');
  });

  it('does not resolve an opaque auth0 id to the organisation', () => {
    expect(classifyProvenance({ author: 'auth0|5f2c9a1e7b3d4c0008a1b2c3' })).toBe('unattributed');
  });

  it('classifies RSNA as third party', () => {
    expect(classifyProvenance({ author: 'RSNA' })).toBe('third_party');
    expect(classifyProvenance({ author: 'rsna' })).toBe('third_party');
  });

  it('classifies a named organisation author as org authored', () => {
    expect(classifyProvenance({ author: 'alemhealth' })).toBe('org_authored');
  });
});
