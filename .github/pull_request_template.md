## What and why

<!-- What changes, and the reason. If the reason is "the plan says so", name the section. -->

## Decision impact

- [ ] Contradicts no accepted ADR in [`docs/adr/`](../docs/adr/README.md)
- [ ] Or: needs ADR-nnnn, and that ADR is in this PR

## Verification

- [ ] `pnpm verify` passes locally
- [ ] If the corpus, the importer or `packages/tokens` changed: the 427/427 round-trip is green
- [ ] If a schema or migration changed: it has been run against a real PostgreSQL instance

## PHI and corpus

- [ ] No real patient data, in code, tests, fixtures or commit messages
- [ ] No logging, telemetry or error payload that could carry free text
- [ ] `alem-reporting-templates/` untouched (it is the specification, not a working directory)
