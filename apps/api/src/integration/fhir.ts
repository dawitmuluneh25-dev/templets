import {
  type ContextSource,
  type DeliveryReceipt,
  type FinalReport,
  type PatientReference,
  type ReportSink,
  type StudyContext,
} from './ports.js';

/**
 * FHIR R4 adapters — one context source, one report sink.
 *
 * This is the reference implementation of the seam, not a claim that any particular site is
 * integrated: nothing here has been run against a vendor sandbox. What it does buy is that
 * the *mapping* is written down and tested, which is the part that is expensive to discover
 * late, and that a second vendor is a new file rather than a new branch in the domain.
 *
 * Two rules the mapping follows:
 *
 * - **Send what we signed, and say so.** `contentHash` travels in an extension rather than
 *   being folded into the narrative, so the far end can tell which version it holds.
 * - **Never invent patient identity.** A missing name stays missing; a synthesised one is a
 *   wrong record in someone else's system.
 */

/** Injected so the mapping and the request shape are testable without a server. */
export type HttpTransport = (request: {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}) => Promise<{ readonly status: number; readonly body: string }>;

function headers(token: string | undefined): Record<string, string> {
  const base: Record<string, string> = {
    accept: 'application/fhir+json',
    'content-type': 'application/fhir+json',
  };

  return token === undefined ? base : { ...base, authorization: `Bearer ${token}` };
}

export interface FhirConfig {
  readonly baseUrl: string;
  readonly token?: string;
}

/**
 * The resource this product produces.
 *
 * `status: final` is doing real work: a provisional DiagnosticReport in an EHR is a clinical
 * statement, and nothing here is allowed to make one.
 */
export function toFhirDiagnosticReport(report: FinalReport): Record<string, unknown> {
  return {
    resourceType: 'DiagnosticReport',
    status: 'final',
    category: [
      {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/v2-0074',
            code: 'RAD',
            display: 'Radiology',
          },
        ],
      },
    ],
    code: {
      coding: [
        {
          system: 'http://loinc.org',
          code: '18748-4',
          display: 'Diagnostic imaging study',
        },
      ],
    },
    subject: { reference: `Patient/${report.reportId}` },
    issued: report.signedAt,
    effectiveDateTime: report.signedAt,
    conclusion: report.text,
    performer: [{ display: report.author.displayName }],
    extension: [
      {
        url: 'urn:alemhealth:reporting:content-hash',
        valueString: report.contentHash,
      },
      {
        url: 'urn:alemhealth:reporting:study-instance-uid',
        valueString: report.studyInstanceUid,
      },
    ],
  };
}

/** Reads patient and study context from an EHR's FHIR surface. */
export class FhirContextSource implements ContextSource {
  readonly id = 'fhir-r4';

  constructor(
    private readonly config: FhirConfig,
    private readonly transport: HttpTransport,
  ) {}

  async fetchStudy(studyInstanceUid: string): Promise<StudyContext> {
    const url = `${this.config.baseUrl}/ImagingStudy?identifier=${encodeURIComponent(studyInstanceUid)}`;
    const response = await this.transport({
      method: 'GET',
      url,
      headers: headers(this.config.token),
    });

    if (response.status !== 200) {
      throw new Error(`FHIR ImagingStudy lookup failed with ${response.status}.`);
    }

    const bundle = JSON.parse(response.body) as {
      entry?: readonly { resource?: Record<string, unknown> }[];
    };

    const study = bundle.entry?.[0]?.resource;

    if (study === undefined) {
      throw new Error(`FHIR has no ImagingStudy for ${studyInstanceUid}.`);
    }

    return {
      studyInstanceUid,
      accessionNumber: typeof study.identifier === 'string' ? study.identifier : null,
      modality: typeof study.modality === 'string' ? study.modality : 'UNKNOWN',
      patient: toPatientReference(study.subject),
    };
  }
}

/**
 * Patient identity from whatever the resource carried. Absent stays absent: a name is not
 * something to improve on the way through.
 */
function toPatientReference(subject: unknown): PatientReference {
  const resource = (subject as { resource?: Record<string, unknown> } | undefined)?.resource;

  return {
    identifier: typeof resource?.id === 'string' ? resource.id : '',
    familyName: null,
    givenName: null,
    birthDate: typeof resource?.birthDate === 'string' ? resource.birthDate : null,
  };
}

/** Writes the signed report as a DiagnosticReport. */
export class FhirReportSink implements ReportSink {
  readonly id = 'fhir-r4';

  constructor(
    private readonly config: FhirConfig,
    private readonly transport: HttpTransport,
  ) {}

  async deliver(report: FinalReport): Promise<DeliveryReceipt> {
    const response = await this.transport({
      method: 'POST',
      url: `${this.config.baseUrl}/DiagnosticReport`,
      headers: headers(this.config.token),
      body: JSON.stringify(toFhirDiagnosticReport(report)),
    });

    if (response.status >= 300) {
      // The body is the far end's explanation and belongs in the delivery row, not in a
      // stack trace, because that is what an integration engineer will read.
      throw new Error(
        `FHIR DiagnosticReport write failed with ${response.status}: ${response.body.slice(0, 500)}`,
      );
    }

    const created = JSON.parse(response.body) as { id?: unknown };

    return { externalId: typeof created.id === 'string' ? created.id : null };
  }
}
