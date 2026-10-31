/**
 * The template manifest contract (ADR-0004).
 *
 * The shape below mirrors `alem-reporting-templates/templates_manifest.json` as
 * measured on the committed export: 427 entries, one per template file, with
 * `name`, `scope`, `modality`, `type`, `author`, `status`, `variants`, `file`,
 * `relpath`, `bytes` and `guid`.
 *
 * Two fields are deliberately typed as `string` rather than as an enumerated
 * union: `modality` and `type`. The vocabulary lives in the corpus and is
 * imported from it at P1 step 5. Enumerating it here from memory would be a
 * guess that the corpus is then forced to satisfy.
 */

/** Bumped only when the manifest shape changes, with a migration for readers. */
export const TEMPLATE_SCHEMA_VERSION = 1 as const;

export type TemplateSchemaVersion = typeof TEMPLATE_SCHEMA_VERSION;

/**
 * `scope` is the label the export carries. It is *not* provenance: 123 files
 * labelled with the organisation's own scope carry a third-party author id
 * (ADR-0004). Treat it as a filing category, never as a licence assertion.
 */
export type TemplateScope = 'AlemHealth' | 'Publicly Shared';

/**
 * Four classes, because the export supports four and no more:
 *
 * - `org_authored` — a named author that is the organisation itself.
 * - `third_party` — a named external author (e.g. `RSNA`).
 * - `unattributed` — an opaque author id (`auth0|…`) that cannot be resolved to
 *   an organisation from metadata alone. The highest-risk class: the file sits
 *   inside the org's own scope while the metadata contradicts it.
 * - `unknown` — no author at all. 168 of 427 files. Provenance is unrecoverable
 *   from the export; default-deny applies.
 */
export type ProvenanceClass = 'org_authored' | 'third_party' | 'unattributed' | 'unknown';

export interface TemplateManifestEntry {
  readonly name: string;
  readonly scope: TemplateScope;
  readonly modality: string;
  readonly type: string;
  readonly author: string;
  readonly status: string;
  readonly variants: number;
  readonly file: string;
  readonly relpath: string;
  /** Byte count recorded by the exporter. The round-trip check asserts this. */
  readonly bytes: number;
  readonly guid: string;
}

/**
 * Classify an entry's provenance from the export alone.
 *
 * Deliberately conservative: anything not clearly org-authored is not treated as
 * licensable by default (ADR-0004). The `scope` field is not consulted — using it
 * here is what produced the miscount this ADR exists to prevent.
 */
export function classifyProvenance(entry: Pick<TemplateManifestEntry, 'author'>): ProvenanceClass {
  const author = entry.author.trim();

  if (author === '') {
    return 'unknown';
  }

  // The exporter writes an opaque identity-provider id when the account that
  // authored the file is not resolvable to a display name.
  if (author.toLowerCase().startsWith('auth0|')) {
    return 'unattributed';
  }

  if (author.toLowerCase() === 'rsna') {
    return 'third_party';
  }

  return 'org_authored';
}
