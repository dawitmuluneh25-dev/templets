/**
 * The seam between this system and the systems it sits between.
 *
 * Two external capabilities, both of which a hospital will describe differently and neither
 * of which we get to choose:
 *
 * - **Reading context.** Launching on a study, knowing which patient it belongs to and what
 *   the order asked for. In one site this is a FHIR Patient + ServiceRequest; in another a
 *   DICOMweb QIDO call against the PACS; in a third, a CSV a scheduler drops nightly.
 * - **Delivering the signed report.** A FHIR `DiagnosticReport`, an HL7 ORU^R01 over MLLP,
 *   a document pushed into a vendor portal, or a PDF into a folder.
 *
 * Everything vendor-shaped lives behind these interfaces. The rule that makes the seam
 * worth having: **nothing in `domain/` may import from `integration/adapters/`, and no
 * adapter type may appear in a contract.** If a vendor field needs to reach the domain, it
 * gets a name in this file first.
 *
 * Failure is explicit. An unconfigured capability throws `IntegrationNotConfiguredError`
 * rather than returning empty data, because a report authored against silently-missing
 * patient context is worse than a report that could not be started.
 */

/** Who the study belongs to, in the customer's own numbering. */
export interface PatientReference {
  /** Medical record number as the hospital uses it. Not a UUID of ours. */
  readonly identifier: string;
  readonly familyName: string | null;
  readonly givenName: string | null;
  /** ISO 8601 date, as the source gives it. Never reformatted into a locale. */
  readonly birthDate: string | null;
}

/** What the order said, enough to start and to print. */
export interface StudyContext {
  readonly studyInstanceUid: string;
  readonly accessionNumber: string | null;
  readonly modality: string;
  readonly patient: PatientReference;
}

/**
 * A source of patient and study context.
 *
 * `ehr` and `pacs` are separate capabilities rather than one, because they are usually
 * separate systems with separate owners, and one of them is usually further behind.
 */
export interface ContextSource {
  /** Stable enough to record on a delivery row: `fhir-r4`, `dicomweb`, `flat-file`. */
  readonly id: string;
  fetchStudy(studyInstanceUid: string): Promise<StudyContext>;
}

/** A signed report, in the shape a sink needs. Deliberately not the API resource. */
export interface FinalReport {
  readonly reportId: string;
  /** The hash the signature attests. Carried so the far end can be reconciled. */
  readonly contentHash: string;
  /** Rendered text, as the signer saw it. */
  readonly text: string;
  readonly signedAt: string;
  readonly author: { readonly identifier: string; readonly displayName: string };
  readonly studyInstanceUid: string;
}

/** What the far end called it. Null is legitimate: not every sink returns an id. */
export interface DeliveryReceipt {
  readonly externalId: string | null;
}

/** Where a signed report goes. */
export interface ReportSink {
  readonly id: string;
  deliver(report: FinalReport): Promise<DeliveryReceipt>;
}

/**
 * Thrown when a capability was asked for and nothing is configured for it.
 *
 * Its own class because it is an operator problem, not a clinical one: it should read as
 * "this deployment is missing config", never as "this report is invalid".
 */
export class IntegrationNotConfiguredError extends Error {
  constructor(readonly capability: string) {
    super(
      `No adapter is configured for ${capability}. Set the adapter and its endpoint, or the ` +
        'capability is unavailable by design rather than by accident.',
    );

    this.name = 'IntegrationNotConfiguredError';
  }
}
