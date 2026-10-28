import { createHash } from 'node:crypto';

/**
 * Content hash over the canonical serialised form.
 *
 * A signature hashes this value, so it is computed from `serialize(parse(x))`
 * rather than from whatever the editor happens to hold: fixing a renderer must
 * never change what a signature appears to attest (ADR-0005).
 */
export function hash(canonical: string): string {
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
