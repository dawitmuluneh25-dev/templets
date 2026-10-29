import { FhirContextSource, FhirReportSink, type HttpTransport } from './fhir.js';
import {
  IntegrationNotConfiguredError,
  type ContextSource,
  type DeliveryReceipt,
  type ReportSink,
  type StudyContext,
} from './ports.js';

/**
 * Which adapter answers for which capability.
 *
 * Configuration names an adapter; the registry builds it once, at startup, and fails there
 * if the name is unknown. A typo in an env var should stop a deployment, not surface as a
 * 500 on the first delivery at 2 a.m.
 *
 * A capability that is simply *not configured* is different from one that is misconfigured:
 * it resolves to an adapter that throws `IntegrationNotConfiguredError` when used. That keeps
 * the wiring honest — the API starts on a workstation with no hospital behind it — while
 * still refusing to pretend the delivery happened.
 */

type AdapterName = 'fhir-r4';

export interface EndpointConfig {
  readonly adapter: AdapterName;
  readonly baseUrl: string;
  readonly token?: string;
}

export interface IntegrationConfig {
  /** Patient and order context. */
  readonly ehr?: EndpointConfig;
  /** Study and imaging context. */
  readonly pacs?: EndpointConfig;
  /** Where the signed report goes. */
  readonly reportSink?: EndpointConfig;
}

export interface Integration {
  readonly ehr: ContextSource;
  readonly pacs: ContextSource;
  readonly reportSink: ReportSink;
}

/** Stands in for a capability nobody configured. Every call fails, loudly and by name. */
class UnconfiguredContextSource implements ContextSource {
  constructor(
    readonly id: string,
    private readonly capability: string,
  ) {}

  async fetchStudy(): Promise<StudyContext> {
    throw new IntegrationNotConfiguredError(this.capability);
  }
}

class UnconfiguredReportSink implements ReportSink {
  readonly id = 'unconfigured';

  async deliver(): Promise<DeliveryReceipt> {
    throw new IntegrationNotConfiguredError('report delivery');
  }
}

function contextSource(
  capability: string,
  endpoint: EndpointConfig | undefined,
  transport: HttpTransport,
): ContextSource {
  if (endpoint === undefined) return new UnconfiguredContextSource('unconfigured', capability);

  switch (endpoint.adapter) {
    case 'fhir-r4':
      return new FhirContextSource(
        {
          baseUrl: endpoint.baseUrl,
          ...(endpoint.token === undefined ? {} : { token: endpoint.token }),
        },
        transport,
      );
    default: {
      const exhaustive: never = endpoint.adapter;

      throw new Error(`Unknown ${capability} adapter: ${String(exhaustive)}`);
    }
  }
}

export function createIntegration(
  config: IntegrationConfig,
  transport: HttpTransport,
): Integration {
  return {
    ehr: contextSource('EHR context', config.ehr, transport),
    pacs: contextSource('PACS context', config.pacs, transport),
    reportSink:
      config.reportSink === undefined
        ? new UnconfiguredReportSink()
        : new FhirReportSink(
            {
              baseUrl: config.reportSink.baseUrl,
              ...(config.reportSink.token === undefined ? {} : { token: config.reportSink.token }),
            },
            transport,
          ),
  };
}

/**
 * Configuration from the environment, so a deployment does not need code to point at a
 * different hospital. Unset means unconfigured, which is a valid state.
 */
export function configFromEnv(env: NodeJS.ProcessEnv): IntegrationConfig {
  const endpoint = (prefix: string): EndpointConfig | undefined => {
    const baseUrl = env[`${prefix}_BASE_URL`];

    if (baseUrl === undefined || baseUrl === '') return undefined;

    const adapter = env[`${prefix}_ADAPTER`] ?? 'fhir-r4';

    if (adapter !== 'fhir-r4') {
      throw new Error(`Unknown adapter "${adapter}" for ${prefix}.`);
    }

    const token = env[`${prefix}_TOKEN`];

    return { adapter, baseUrl, ...(token === undefined ? {} : { token }) };
  };

  const ehr = endpoint('INTEGRATION_EHR');
  const pacs = endpoint('INTEGRATION_PACS');
  const reportSink = endpoint('INTEGRATION_REPORT_SINK');

  return {
    ...(ehr === undefined ? {} : { ehr }),
    ...(pacs === undefined ? {} : { pacs }),
    ...(reportSink === undefined ? {} : { reportSink }),
  };
}
