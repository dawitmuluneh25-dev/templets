# ADR-0002 — Single-tenant deployment in a customer-controlled VPC

- **Status:** Accepted (profile); cloud vendor **not** decided here
- **Date:** 2026-10-29
- **Deciders:** project owner
- **Relates to:** production plan §12.2, §16, §18.3 (D1, BAA dependency); ADR-0003

## Context

The plan's topology table (§12.2) describes two profiles — cloud-with-BAA and on-prem — and
leaves the choice per customer (D1). That is not a decision a build can be scaffolded
against: it determines tenancy, auth, backup/restore design, upgrade mechanics and what the
SLA says.

Constraints that actually bind:

- The workload is PHI. Any managed service must be covered by a signed agreement.
- SMART-on-FHIR launch means the hospital EHR must be able to reach the application, or the
  application must be reachable over a mutually agreed private path. Either way each site
  needs an app registration and a stable hostname with a certificate.
- One clinical organisation does the reading, for multiple referring hospitals. The
  tenancy boundary that matters is the customer organisation, not the hospital.
- Four engineers cannot operate three topologies well. Operability is a feature.

## Decision

**One deployment per customer organisation**, in a VPC that is dedicated to that customer
and (where the customer requires it) controlled by them. Managed services under a signed
agreement:

| Component | Choice |
|---|---|
| Web + API | Managed container runtime, ≥ 3 AZs, stateless, session in Redis |
| Worker | Separate service, own queue, scales on depth |
| PostgreSQL | Managed HA with PITR; no public endpoint |
| Redis | Managed; queue and cache only, never a source of truth |
| Object storage | Object Lock / immutability enabled — signed PDFs and audit bundles are WORM |
| Secrets | Managed KMS + secrets manager; no secrets in env files in production |
| IdP | Customer's IdP via OIDC; Keycloak only as fallback |

The application image is identical across `local`, `preview`, `staging`, `production`, `dr`.
Only configuration differs. Schema keeps `org_id` and RLS (ADR-0003) so the same image can be
pooled later without a migration.

**Not decided by this ADR:** the cloud vendor. That is procurement, gated on the signed
agreement (§18.3), and the code must not depend on vendor-specific primitives beyond object
storage semantics that MinIO also implements.

**Documented fallback:** a customer that refuses off-site data gets the on-prem profile
(Patroni + MinIO + Vault + Keycloak on Kubernetes). This is a second product to operate. It
is priced and scheduled separately, not absorbed silently into the same release train.

## Consequences

**Accepted:**

- Per-customer upgrades. A real release and rollback procedure is needed by P4 — tagged
  images, forward-only migrations, a rehearsed rollback that does not require a restore.
- No cross-customer analytics without a separate, consented aggregate pipeline.
- Backups, DR drills and the RPO/RTO in §16 become contractual per deployment, not an
  internal aspiration.
- SMART launch requires one app registration and one certificate per site, and a stable
  hostname that does not change between releases. This is a P4 lead item; discovering it
  late is the classic integration slip.
- Blast radius is one customer. Per-customer operational cost is higher than pooled.

**Made harder:**

- Anything that assumes a single global database — cross-tenant reporting, shared template
  curation, global feature flags — needs an explicit design.
- Support needs a way to reach a customer's instance without a standing credential
  (break-glass with time-boxed access and an audit record).

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Pooled multi-tenant SaaS at launch | Highest compliance surface and the customer conversation is "where is our data", not "how cheap". Revisit only if per-deployment ops cost dominates. |
| On-prem per hospital as the primary profile | Patroni + MinIO + Vault + Keycloak is a second product, and hospital IT availability is a dependency that cannot be scheduled. |
| Kubernetes everywhere | Managed container runtime with three AZs meets the requirement at this size; Kubernetes adds a control plane to operate per deployment. |

## Revisit triggers

- More than ~10 customer deployments and per-deployment ops cost dominates → revisit pooled
  with per-tenant KMS keys. RLS (ADR-0003) is what makes that a configuration change.
- A customer contract requires data residency in a jurisdiction where the chosen vendor has
  no region.
- The fallback on-prem profile is requested by more than one customer → promote it to a
  supported SKU with its own timeline.
