# Radiology Reporting PWA — Production Build Plan

**Status:** Draft for review · **Version:** 1.0 · **Date:** 2026-10-29
**Supersedes:** greenfield notes in `Radiology-PWA-Architecture-and-Stack-Plan.md` (which this consolidates and extends)
**Audience:** engineering, clinical leadership, informatics/IT security, compliance, procurement

---

## 0. How this document is organised

| § | Content | Primary reader |
|---|---|---|
| 1 | Product requirements, goals, non-goals, NFRs | Product, clinical |
| 2 | Roles, permissions, workflows (incl. co-signature state machine) | Clinical, product, engineering |
| 3 | System architecture | Engineering |
| 4 | Technology stack | Engineering, IT |
| 5 | Integration strategy (EHR, PACS, dictation) | Engineering, informatics |
| 6 | Data model | Engineering, DBA |
| 7 | Security and compliance | Security, compliance |
| 8 | API design | Engineering, integration partners |
| 9 | Responsive UX and accessibility | Design, clinical |
| 10 | Testing strategy | Engineering, QA |
| 11 | CI/CD | Engineering, DevOps |
| 12 | Infrastructure and environments | DevOps |
| 13 | Observability | DevOps, on-call |
| 14 | Release management and cutover | Product, IT ops |
| 15 | Scalability and capacity | Engineering, finance |
| 16 | Disaster recovery | IT ops, clinical |
| 17 | Phased roadmap | All |
| 18 | Assumptions, risks, dependencies, open decisions | All |

**Inherited decisions** (settled in the previous phase; not reopened here unless flagged):
immutable report snapshots pinned to a template version · per-template requiredness · three-tier
validation · unmodified boilerplate as a hard block · local-first authoring with server-authoritative
signature · modular monolith · PostgreSQL · buy authentication · server-side archival PDF · offline
authoring with online signing · version control from commit one.

**Newly confirmed scope** (this document is built around them):
**S1** EHR/PACS integration required · **S2** solo signing *and* resident+attending co-signature,
including data model, permissions, audit and workflow · **S3** dictation required, in-app microphone
*and* third-party dictation clients.

Each of these three changes the architecture in a way that is expensive to retrofit, so they are
treated as first-class constraints rather than features. §5, §2.4 and §6.5 exist because of them.

---

## 1. Product requirements

### 1.1 Problem statement

Radiologists author reports in tools that either cannot be used during downtime, force free-text
entry into structured templates, or produce output that the downstream record cannot ingest without
manual handling. The result is measurable: addenda, transcription turnaround, and reports whose
structure is lost the moment they leave the reporting application.

The product is a reporting workbench that (a) preserves the structure of the organisation's actual
template library, (b) keeps working when the network does not, (c) produces a signed, immutable,
standards-conformant report that the EHR and PACS can ingest without a human in the middle, and
(d) supports the real signing hierarchy of a teaching hospital.

### 1.2 Goals (measurable)

| ID | Goal | Target | Measured by |
|---|---|---|---|
| G1 | Reduce time from open to signed report | −25% vs. baseline | Instrumented median, per modality |
| G2 | Eliminate transcription re-entry for templated studies | 0 re-entry steps | Workflow audit |
| G3 | Downtime reporting capability | Author + queue, sign on restore | Downtime drill (quarterly) |
| G4 | Template fidelity | 100% round-trip, 0 silent alterations | CI golden corpus |
| G5 | Structured output to EHR/PACS | ≥98% first-attempt acceptance | Integration error rate |
| G6 | Co-signature turnaround | Median < 4 h for routine, < 1 h for urgent | Workflow analytics |
| G7 | Accessibility | WCAG 2.2 AA, verified | axe in CI + manual audit |

### 1.3 Non-goals (scope boundary, worth protecting)

- **No image interpretation, CAD, or AI-generated findings.** The product structures, validates and
  transmits physician-authored text. This boundary is what keeps the regulatory position defensible
  (§7.1) and must be re-reviewed before any feature that suggests clinical content.
- **No PACS archive or viewer replacement.** We read study context and write reports; we do not store
  pixel data beyond a transient preview thumbnail where contractually permitted.
- **No billing, scheduling, or order entry.**
- **No transcriptionist pool management** in v1 (third-party dictation is integrated, not replaced).
- **No multi-tenant SaaS in v1** — single-tenant per organisation deployment is the v1 target;
  the schema is tenancy-ready (§6.2) so this is not a rewrite later.
- **No mobile phone authoring of full reports.** Phone is read/approve/co-sign only; authoring is
  tablet and above (§9.2).

### 1.4 Personas

| Persona | Context | What they need | What breaks them |
|---|---|---|---|
| **Attending radiologist** (primary) | 2–3 monitors, dark room, 60–120 studies/shift, dictates | Fast template retrieval, keyboard-first, dictation that lands in the right field, sign in one action | Any modal that steals focus; a save indicator that lies |
| **Resident / fellow** | Authors, cannot finalise without co-sign | Clear "who signs next", ability to send back with comment, visibility of attending edits | Ambiguity about whether the report is submitted |
| **Attending as co-signer** | Reviews a queue between cases | Diff of resident edits vs. template, one-key approve, batch where safe | Having to re-read the whole report to find the change |
| **Modality lead / template owner** | Curates templates | Versioning, deprecation, usage analytics, dry-run preview | Editing a template that silently changes historical reports |
| **Informatics admin** | Owns integration and access | Endpoint health, mapping errors, role assignment, audit export | Failures that surface only as clinician complaints |
| **IT security / compliance** | Reviews the system | Evidence: audit chain, access logs, retention, SBOM, pen-test report | Any PHI in a log or a third-party origin |
| **Referring clinician** (indirect) | Consumes the report | Structured, complete, correctly linked to the study | Reports that arrive without an impression |

### 1.5 Functional requirements

Priorities: **M** = must (v1), **S** = should (v1.x), **C** = could (v2).

**Templates and authoring**

| ID | Requirement | Pri |
|---|---|---|
| FR-1 | Import the organisation's template library; every file round-trips byte-for-byte or is quarantined | M |
| FR-2 | Template versioning: append-only versions, content hash, deprecation without deletion | M |
| FR-3 | Search and facet by modality, body system, type (free-text/structured), scope, author | M |
| FR-4 | Open a report from a pinned template version; snapshot at creation | M |
| FR-5 | Edit section bodies (constrained rich text) and typed fields inline | M |
| FR-6 | Typed fields: enum, number+unit, multislot, date-or-none, free text; 2,381 in the current corpus | M |
| FR-7 | Compound placeholders decomposed into sub-fields, admin-reviewed | S |
| FR-8 | Macros / auto-text per user and per organisation, with expansion audit | S |
| FR-9 | Template authoring UI in-app (create/edit from scratch) | C |
| FR-10 | Compare two template versions, with a migration preview affecting only draft reports | S |

**Validation and signing**

| ID | Requirement | Pri |
|---|---|---|
| FR-11 | Three-tier validation (hard block, soft acknowledge, advisory nudge) | M |
| FR-12 | Per-template requiredness derived from section presence, not global rules | M |
| FR-13 | Unmodified template boilerplate is a hard block | M |
| FR-14 | Solo sign: single attributed signature, immutable, timestamped | M |
| FR-15 | Co-signature: resident submits → attending approves / edits-and-approves / returns | M |
| FR-16 | Delegation with expiry (attending A backs up attending B for a window) | S |
| FR-17 | Addendum after signature, linked to the original, never mutating it | M |
| FR-18 | Signature verification endpoint/UI ("verify this report") | S |

**Dictation** (§5.4)

| ID | Requirement | Pri |
|---|---|---|
| FR-19 | In-app microphone dictation into a targeted section or field, with live partial transcript | M |
| FR-20 | Voice commands: "next section", "insert template phrase", "strike that" | S |
| FR-21 | Third-party dictation client compatibility (OS-level text injection into the focused editor) | M |
| FR-22 | Dictation session audit: which sections used dictation, duration, engine | M |
| FR-23 | Offline dictation degradation: clear affordance when the ASR service is unreachable | M |

**Drafts, offline, exports**

| ID | Requirement | Pri |
|---|---|---|
| FR-24 | Autosave to local store; append-only journal; crash recovery with Restore/Discard | M |
| FR-25 | Offline authoring of drafts, with explicit queued-for-sign state | M |
| FR-26 | Export: text, standalone HTML, FHIR `DiagnosticReport`, PDF | M |
| FR-27 | Server-rendered archival PDF with checksum, stored WORM | M |
| FR-28 | Conflict detection when the same report is open in two tabs or two devices | M |

**Integration** (§5)

| ID | Requirement | Pri |
|---|---|---|
| FR-29 | SMART on FHIR launch: open from EHR with patient/encounter/study context | M |
| FR-30 | Write `DiagnosticReport` + `DocumentReference` back to the EHR FHIR endpoint | M |
| FR-31 | PACS study context via DICOMweb (QIDO-RS/WADO-RS metadata), thumbnail optional | M |
| FR-32 | Outbound HL7 v2 ORU^R01 to legacy interfaces where FHIR is unavailable | M |
| FR-33 | DICOM SR (TID 2000-shaped) export for structured consumers | S |
| FR-34 | Prelim → final status lifecycle reflected downstream, incl. addenda | M |
| FR-35 | Integration adapter health dashboard and replay of failed deliveries | M |

**Admin and audit**

| ID | Requirement | Pri |
|---|---|---|
| FR-36 | Role assignment via IdP groups; per-organisation policy overrides | M |
| FR-37 | Append-only, hash-chained audit of every clinical state change | M |
| FR-38 | Audit export to SIEM, filterable by patient/report/user/date | M |
| FR-39 | Usage analytics (template effectiveness, time per section) without PHI | S |
| FR-40 | Data retention and deletion policy with recorded deletion events | M |

### 1.6 Non-functional requirements

| ID | Requirement | Target |
|---|---|---|
| NFR-1 | Editor keystroke latency on a 5-year-old reference laptop | p95 < 16 ms, p99 < 50 ms |
| NFR-2 | Cold start to usable library | < 2.5 s LCP on reference hardware; shell JS ≤ 300 KB gzip |
| NFR-3 | API latency (report read, draft save) | p95 < 200 ms server-side, p99 < 500 ms |
| NFR-4 | Availability, authoring path | 99.9% monthly (43 min) |
| NFR-5 | Availability, signing path | 99.95% monthly (22 min) |
| NFR-6 | Durability of signed reports | RPO 0 (synchronous, replicated before ack) |
| NFR-7 | Durability of drafts | RPO ≤ 2 s local, ≤ 60 s server |
| NFR-8 | Recovery time, authoring | RTO 1 h (offline mode covers the gap) |
| NFR-9 | Recovery time, read/sign | RTO 4 h |
| NFR-10 | Accessibility | WCAG 2.2 AA |
| NFR-11 | Browser support | Evergreen Chromium (managed), Safari current for read/co-sign; documented floor per deployment |
| NFR-12 | Data residency | Configurable per deployment; no cross-border PHI by default |
| NFR-13 | Audit retention | 7 years minimum, configurable to 10+ per jurisdiction |
| NFR-14 | Concurrency, per 100 active radiologists | 25 concurrent editors, 40 rps peak API |
| NFR-15 | Report size ceiling | 40 sections / 12,000 words / 2 MB document |

---

## 2. Roles, permissions and workflows

### 2.1 Role model

Roles are **capability bundles**, not people. Assignment comes from IdP groups (§5.2) and is
evaluated server-side on every request; the client's view is a rendering of server decisions, never
the authority.

| Role | Author | Submit | Sign | Co-sign | Addendum | Amend template | Admin | Audit read |
|---|---|---|---|---|---|---|---|---|
| `rad.author` (resident) | ✔ | ✔ | — | — | — | — | — | — |
| `rad.attending` | ✔ | ✔ | ✔ | ✔ | ✔ | — | — | — |
| `rad.attending.backup` | ✔ | ✔ | ✔ (delegated scope only) | ✔ | ✔ | — | — | — |
| `rad.trainee.unverified` | ✔ (draft only) | — | — | — | — | — | — | — |
| `template.owner` | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ (own scope) | — | — |
| `informatics.admin` | — | — | — | — | — | ✔ (dry-run + promote) | ✔ | ✔ |
| `security.auditor` | — | — | — | — | — | — | — | ✔ |
| `service.integration` (machine) | — | — | — | — | — | — | — | delivery logs only |

Separation-of-duties rules enforced in the API, not the UI:

- An author cannot co-sign their own report (except `rad.attending` solo-signing their own).
- `template.owner` edits to a template are **never** applied retroactively to signed reports.
- `informatics.admin` cannot sign reports; `security.auditor` cannot write anything.
- Delegation is time-boxed, scoped (by modality or by list), and logged as its own audit event.

### 2.2 Permission decisions that need server evaluation (not UI hiding)

| Action | Rule |
|---|---|
| Open a report | Author, current signer, delegated signer, or auditor (read) |
| Edit | Author while `DRAFT`/`RETURNED`; attending while `PENDING_COSIGN` only by explicit "edit and approve" |
| Sign | Attending with active credential; not expired; step-up auth in last 15 min |
| Addendum | Any attending with study access after `SIGNED`; creates a new version, links to parent |
| Reassign | Author's attending-of-record, or admin with reason code |
| Export PHI | Requires explicit user action; logged with report id + format + destination |

### 2.3 The report lifecycle state machine

This is the core of S2. Every transition is an audit event with actor, timestamp, reason, and the
content hash before/after.

```
                 ┌──────────── return(reason) ────────────┐
                 ▼                                        │
 DRAFT ──submit──► PENDING_COSIGN ──approve──► SIGNED ──addendum──► AMENDED
   │                   │  │                                          │
   │                   │  └──edit_and_approve────────────────────────┤
   │                   │                                             │
   └──discard──► VOID  └──reassign──► PENDING_COSIGN(new signer)      │
                                                                     │
 SIGNED/AMENDED ──retract(rare, admin+attending, reason)──► RETRACTED
```

| State | Who may act | Allowed transitions | Notes |
|---|---|---|---|
| `DRAFT` | author | `submit`, `discard` | Autosaves locally + server; not visible downstream |
| `PENDING_COSIGN` | author (withdraw), co-signer (approve/return/edit-and-approve), admin (reassign) | `approve`, `return`, `edit_and_approve`, `reassign` | Locked against author edits while pending, but author may `withdraw` |
| `SIGNED` | attending | `addendum`, `retract` | Immutable; hash + signature sealed; exported downstream |
| `AMENDED` | attending | further `addendum` | Parent chain preserved; downstream gets a corrected status |
| `RETURNED` | author | `submit` | Carries the co-signer's structured reason + optional inline comments |
| `VOID` | — | terminal | Never submitted; retained per policy for audit, not for clinical use |
| `RETRACTED` | — | terminal | Requires reason code; triggers downstream retraction message |

**Timers and escalation:** `PENDING_COSIGN` older than the configured SLA (default 4 h routine,
1 h urgent flag) raises an escalation event to the attending's queue and, optionally, a supervisor
notification. Escalation is an operational signal, never an automatic signature.

### 2.4 Solo signing

For a radiologist with solo authority (private practice, night hawk, or an attending working alone):

1. Open report from worklist or EHR launch (patient/study context pre-filled).
2. Author; validation runs at three tiers; hard issues disable the sign control with the reason
   visible inline (not a toast).
3. Step-up re-authentication if the session's auth is older than 15 minutes.
4. Sign → server writes `signature` + `audit_event` + sealed PDF in **one transaction**, then
   publishes `DiagnosticReport.status = final` to the EHR and issues ORU where applicable.
5. Confirmation shows the signature id, timestamp, and delivery state per downstream target
   (delivered / queued / failed with reason). "Signed" and "delivered" are never conflated.

### 2.5 Resident-plus-attending co-signature

The workflow the data model is shaped around. Six steps, each with an explicit failure path:

1. **Author (resident)** completes the report. Validation tiers apply identically to solo.
2. **Submit** → state `PENDING_COSIGN`; author is locked out of content edits (prevents racing an
   approval) but may `withdraw` to `DRAFT`. A `submission` record captures the exact content hash the
   attending will be asked to approve.
3. **Assign** → attending-of-record resolved from the study/service rule; if none, falls to the
   on-service attending for the modality. Assignment is logged.
4. **Review (attending)** sees a diff against the *template baseline*, not just the final text — this
   is what makes review fast and is the main UX investment for S2. Inline comments are possible;
   comments are never part of the clinical text.
5. **Decide**:
   - `approve` → attending signature; resident remains attributed as author; state `SIGNED`.
   - `edit_and_approve` → the attending's edits create a new revision; both authorship and approval
     are recorded with distinct roles and hashes; state `SIGNED`.
   - `return(reason)` → state `RETURNED`; resident notified; reason codes are structured
     (`incomplete`, `wrong_template`, `needs_repeat`, `other`+text) so analytics can find systemic
     problems.
6. **Downstream** → only after `SIGNED`. Both signatures appear in the exported document and in the
   FHIR `DiagnosticReport` (`resultsInterpreter` for the attending, `author` for the resident), and
   in the DICOM SR verification fields where that export is enabled.

**Reassignment and absence** are handled by delegation (`rad.attending.backup`), not by editing the
assignment record: the original assignment stays visible, the delegate's signature records
`on_behalf_of`, and the audit shows both. This matters in a malpractice review.

### 2.6 Dictation workflow

Two paths, deliberately different, because they have different trust properties:

**Path A — in-app microphone (FR-19/FR-23).** A streaming session scoped to the focused section or
field. Audio goes to a configured ASR service over an authenticated WebSocket; partial transcripts
render into a preview region, not directly into the document, and are committed on pause or on
explicit "insert". Reasons for the preview-then-commit model: it makes correction cheap, it prevents
a mis-recognition from silently entering the clinical text, and it keeps the audit honest about what
was machine-transcribed versus typed.

**Path B — third-party dictation client (FR-21).** Dragon Medical One, Windows Voice Access, macOS
dictation and similar tools generally act as **OS-level text injection** into whatever has focus.
The application's obligation is therefore to be a *cooperative text sink*, which is an architectural
requirement, not a footnote:

- the editor must accept `beforeinput`/`input` with `inputType: insertText|insertCompositionText`;
- IME composition must be supported (composition events not swallowed by re-render);
- the editor must not re-render the focused node on every keystroke (this is why the document store
  is the single writer and the view is diffed);
- no focus stealing from toasts, validation panels, or background saves;
- field widgets must be reachable by keyboard and must not trap injected text;
- a "dictation in progress" indicator that does not steal focus.

Both paths must work in the same session, which is why the editor engine choice (§4.3) has a
conformance test suite for injected text.

### 2.7 Downtime workflow

Radiology downtime is a clinical process, not an error state:

1. Detection: the app shows a persistent, non-blocking banner; authoring continues from the local
   store; the library and templates are already cached.
2. Authoring offline produces `DRAFT` reports locally with a `queued` marker.
3. Signing is **blocked offline** (a signature requires server authority, a trusted timestamp and an
   audit record). The UI says so explicitly and offers "queue for signature on restore".
4. On restore: a reconciliation pass pushes queued drafts, resolves conflicts by report id, and
   surfaces anything that could not be auto-merged for human decision. Nothing is silently
   overwritten.
5. Print/bridge fallback: a downtime export (plain text + a structured bundle) can be produced to a
   local printer or a shared folder, matching the hospital's existing downtime procedure.

---

## 3. System architecture

### 3.1 Shape

A **modular monolith** with three deployable processes and one integration edge. Chosen because the
domain has three natural modules (authoring, signing, integration) and one team: microservices would
add distributed-transaction problems to a system whose central requirement is *exactly one*
atomic write (signature + audit + sealed document).

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Browser (PWA)                                                            │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐  │
│  │ Library      │ │ Editor       │ │ Review/Co-   │ │ Admin            │  │
│  │ (server-     │ │ (client      │ │ sign (client)│ │ (server-         │  │
│  │  rendered)   │ │  island)     │ │              │ │  rendered)       │  │
│  └──────────────┘ └──────┬───────┘ └──────────────┘ └──────────────────┘  │
│   Dexie (drafts, journal) │ outbox (queued mutations)   SW: shell+templates│
└───────────────────────────┼───────────────────────────────────────────────┘
                            │ HTTPS / JSON + SSE(dictation, review presence)
┌───────────────────────────▼───────────────────────────────────────────────┐
│  API (Fastify, Node/TS)                                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────┐  │
│  │templates │ │ reports  │ │signatures│ │  audit   │ │  exports        │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └────────┬────────┘  │
│  ┌──────────────────────────────────────────────────────────┐ │           │
│  │ integration (adapters: FHIR, DICOMweb, HL7v2, ASR relay)  │ │           │
│  └───────┬──────────────────┬──────────────────┬────────────┘ │           │
└──────────┼──────────────────┼──────────────────┼──────────────┼───────────┘
           │                  │                  │              │
     ┌─────▼─────┐      ┌─────▼─────┐      ┌─────▼─────┐  ┌─────▼──────┐
     │PostgreSQL │      │  Redis    │      │ Object    │  │ Worker     │
     │+ PITR     │      │queue+cache│      │ storage   │  │ (BullMQ)   │
     │           │      │           │      │ WORM PDFs │  │ export,    │
     └───────────┘      └───────────┘      └───────────┘  │ delivery,  │
                                                          │ audit seal │
     External: EHR FHIR (SMART launch) · PACS DICOMweb ·   └────────────┘
               HL7 v2 interface engine · ASR service · IdP (OIDC)
```

### 3.2 Modules and responsibilities

| Module | Owns | Explicitly does not |
|---|---|---|
| `templates` | Template + version records, content hash, deprecation, import pipeline | Render reports; it only supplies versioned content |
| `reports` | Report lifecycle state, sections, field values, conflict detection | Decide who may sign (that is `signatures` + policy) |
| `signatures` | Signature records, step-up enforcement, co-sign chain, delegation | Produce documents (it triggers `exports`) |
| `audit` | Append-only events, hash chain, export to SIEM | Serve as the source of truth for state (state lives in domain tables; audit is evidence) |
| `exports` | Text/HTML/FHIR/PDF/DICOM SR renderers, checksums, WORM write | Deliver to external systems (that is `integration`) |
| `integration` | Adapters, retries, idempotency, delivery receipts, health | Contain clinical rules |
| `identity` | OIDC session, role mapping from groups, tenancy | Store credentials |

### 3.3 The signing transaction (the one that must not fail half-way)

```
BEGIN
  SELECT report FOR UPDATE                     -- pessimistic, per report
  assert state = PENDING_COSIGN
  assert content_hash = submission.content_hash (or record an edit_and_approve revision)
  insert signature(actor, role, method, ts, hash, on_behalf_of?)
  update report.state = SIGNED, report.signed_at, report.current_hash
  insert audit_event(action='report.sign', prev_hash, hash)
  insert outbox_job(kind='export.pdf'), outbox_job(kind='deliver.ehr')
COMMIT
```

Everything after `COMMIT` is asynchronous, idempotent and retried. The consequence: a delivered PDF
can lag a signature by seconds, but a signature can never exist without its audit record, and a
report can never be signed twice (unique constraint on `(report_id, revision, role)`).

### 3.4 Client-side architecture

| Concern | Owner |
|---|---|
| Document state (tokens, field values, dirty flag, undo stack) | Redux Toolkit store, single writer |
| Server/cache state (templates, drafts list, queues) | TanStack Query with persisted cache |
| Ephemeral UI (drawer, active section, popover anchor) | Zustand slices |
| Local persistence | Dexie (`drafts`, `journal`, `outbox`, `meta`) with schema migrations |
| Sync | Outbox pattern: mutations append to `outbox`, replay on `online`/visibility, ordered per report, idempotent by client-generated `mutation_id` |
| Offline detection | `navigator.onLine` **plus** a 15 s heartbeat to `/health/ready` (event-only detection lies on captive portals) |

**Why the outbox and not Background Sync:** the Background Sync API is not dependable across the
browsers and policies found in hospital fleets, and it offers no control over ordering or conflict
resolution. An explicit outbox is more code and strictly more predictable. This is a decision to
revisit only if the supported browser matrix narrows to managed Chromium *and* the operational team
wants replay while the tab is closed.

### 3.5 Key architectural decisions for the new scope

| Decision | Choice | Why now |
|---|---|---|
| **Integration topology** | Adapter layer inside the monolith, one adapter per external system, communicating over a *canonical internal model* | Prevents vendor FHIR quirks from leaking into clinical code; lets a new EHR be a new adapter, not a fork |
| **Delivery semantics** | At-least-once with idempotency keys; delivery state visible to the clinician | "We sent it" must be provable; at-most-once silently loses reports |
| **Co-sign data shape** | Signatures as a *list* with role and revision, not two nullable columns | Generalises to delegation, multi-party approval, and addenda without a migration |
| **Dictation boundary** | ASR is an external service behind an internal relay; no vendor SDK in the browser | Keeps PHI inside the BAA boundary, allows engine swap, allows offline degradation |
| **Editor engine** | ProseMirror, constrained schema, field nodes atomic | Injected text (§2.6), IME, paste sanitisation, deterministic serialisation |
| **PDF** | Server-side, pinned renderer, checksum, WORM | Archival artifact must be byte-stable and tamper-evident |
| **Clock** | Server-authoritative timestamps; client clock never trusted for signature time | Clock skew across clinical workstations is routine |

---

## 4. Technology stack

| Layer | Choice | Rationale | Documented alternative |
|---|---|---|---|
| Language | TypeScript, strict, `noUncheckedIndexedAccess` | Token model is a discriminated union; compiler is the cheapest validator | — |
| UI framework | React + Next.js App Router (self-hosted) | SSR for library/admin/audit; client island for the editor | Vite + React SPA behind nginx if no Node runtime is permitted |
| Editor | **ProseMirror** with constrained schema | Atomic field nodes, IME, paste sanitisation, deterministic serialisation | Lexical (smaller, less mature schema tooling) |
| Styling | Tailwind + Radix primitives on CSS-variable tokens | Accessible primitives not hand-rolled; one source of spacing/width truth | Vanilla CSS modules (slower to build a system) |
| State | Redux Toolkit (document) · TanStack Query (server) · Zustand (UI) | Three state kinds, three failure modes; command log gives undo + edit trail | Zustand everywhere (weaker audit/undo) |
| Forms/schema | React Hook Form + Zod, shared client/server | Field types enforced once | JSON Schema + AJV (weaker TS inference) |
| API | Fastify + Zod, OpenAPI generated | Schema-first boundary, low overhead, good plugin model | NestJS if team > 4 engineers |
| Jobs | BullMQ + Redis | Export, delivery, audit sealing are not request work | Temporal (overkill at this scale, revisit at multi-region) |
| DB | PostgreSQL + JSONB (token streams), RLS for tenancy | Transactions, constraints, PITR, on-prem maturity | — (MongoDB rejected: no reliable multi-table transaction for sign+audit) |
| ORM | Drizzle (SQL-first, typed) | Invariants stay in the database; migrations reviewable as SQL | Prisma (fine; less transparent SQL) |
| Object storage | S3 with Object Lock, or MinIO on-prem | WORM for signed PDFs and audit bundles | Azure Blob with immutability policy |
| Auth | OIDC against hospital IdP; Auth.js for the web session | Never build credentials; joiner/leaver already solved | Keycloak self-hosted if no IdP |
| PDF | Server-side renderer in a pinned container (headless Chromium or Typst) | Byte-stable archive, no font drift | pdf-lib for structured, layout-light documents |
| ASR | Configured streaming service via internal relay (BAA-covered vendor or self-hosted) | Keeps PHI in-boundary; swappable | On-prem Whisper-class model for full offline |
| Testing | Vitest · Testing Library · Playwright (6 viewports) · axe · fast-check · k6 | See §10 | — |
| PWA | Serwist/Workbox (allowlist), Dexie, WebCrypto, manifest | Offline shell that never caches PHI | Hand-rolled SW (fine, but re-implements precache) |
| IaC / deploy | Terraform, Docker, Kubernetes or ECS | Portability between cloud-with-BAA and on-prem | Compose for single-node hospital deployments |
| CI/CD | GitHub Actions or GitLab CI; cosign + Syft SBOM + Trivy | Procurement increasingly requires provenance | — |
| Observability | OpenTelemetry, pino with redaction, Prometheus + Grafana or managed equivalent | PHI-safe telemetry is a design constraint, not a config toggle | — |

**Rejected across the board:** any frontend PaaS without a BAA for PHI workloads; third-party CDNs or
web-font hosts for the shell; session replay on any screen that can display PHI; a document DB;
microservices at this size; building authentication.

---

## 5. Integration strategy

S1 makes integration a product surface, not a backend chore. The strategy is: **one canonical
internal model, one adapter per external system, an anti-corruption layer at every boundary, and a
conformance suite per adapter.** No vendor's FHIR profile reaches the clinical code.

### 5.1 Canonical model

```
Study      { studyInstanceUid, accession, modality, bodyPart, performedAt, patientRef, priorStudies[] }
PatientRef { fhirId?, mrn, birthDate, sex, nameHash }        // minimal by design
Encounter  { fhirId?, class, locationId? }
Report     { id, studyRef, templateVersionId, sections[], fields{}, state, revisions[] }
Signature  { id, actorId, role, method, timestamp, contentHash, onBehalfOf? }
Delivery   { target, kind, idempotencyKey, state, attempts[], receipt }
```

Only what the workflow needs. Demographics are referenced, not duplicated — every field not stored
is a field that cannot leak (§7.3).

### 5.2 EHR integration

| Concern | Approach |
|---|---|
| Launch | **SMART on FHIR** app launch (EHR launch + standalone launch). The EHR passes `iss`, `launch`, and the app exchanges for a token with `patient`, `encounter`, `user` context. Target a currently-published SMART App Launch release; confirm the exact version each customer's EHR supports during discovery — implementations lag the specification by years |
| Read | `Patient`, `Encounter`, `ServiceRequest`/`ImagingStudy`, `DiagnosticReport` (priors), `Practitioner`, `PractitionerRole` |
| Write | `DiagnosticReport` (`status`: `preliminary` → `final` → `corrected`/`appended`), with `presentedForm` (PDF) and `resultsInterpreter`/`author` referencing practitioners; plus `DocumentReference` where the EHR prefers documents over reports |
| Auth model | Per-launch token, narrowly scoped; backend service credentials for asynchronous delivery (client-credentials grant, separately provisioned) |
| Versioning | Parse tolerantly, validate strictly against the *customer's* CapabilityStatement at onboarding; store the profile version per tenant |
| Failure | Delivery is queued and retried with exponential backoff; after N attempts the report shows "delivered: failed" with the upstream error, and an admin can replay. A signed report is never held hostage by a downstream outage |

### 5.3 PACS integration

| Concern | Approach |
|---|---|
| Study lookup | **DICOMweb QIDO-RS** for study/series metadata; WADO-RS only for a thumbnail where contractually allowed |
| Auth | Per-connection credentials in the secrets manager; DICOMweb over TLS with mTLS where the PACS requires it |
| Patient/study linkage | `studyInstanceUid` is the join key; accession is the fallback. A report without a resolvable study cannot be submitted |
| Write-back | Primary path is the EHR. Where the PACS is the record, **DICOM SR** (TID 1500-shaped report content, TID 2000-compatible structure where the customer's viewer expects it) plus a `KOS`/PDF object; verify per-vendor rendering, because SR rendering varies substantially |
| Priors | Read-only list of prior studies for comparison-section auto-fill ("Prior study dated …") |
| Failure | Reporting must remain possible with the PACS unavailable — study context is cached at open; a warning is shown, and the report can still be authored and signed with a flagged "study context unverified" note |

### 5.4 Dictation integration

| Path | Mechanism | Trust / PHI statement |
|---|---|---|
| **In-app microphone** | `MediaRecorder`/`AudioWorklet` → authenticated WebSocket → internal **ASR relay** → streaming ASR (BAA-covered vendor or self-hosted) → partial transcripts back over SSE/WS | Audio leaves the browser only to our relay; the vendor never sees the browser directly; relay strips identifiers, enforces session tokens, and logs duration but never audio |
| **Browser-native `SpeechRecognition`** | Available in Chromium-family browsers | **Not used for PHI by default.** In Chromium the implementation may route audio to a vendor service outside our control, and behaviour differs by build and enterprise policy; treat as unavailable unless a customer deployment explicitly accepts it after a DPIA. Verify per browser version before enabling any flag |
| **Third-party clients** (Dragon Medical One, OS dictation, Voice Access) | OS-level text injection into the focused editor | The application is a cooperative text sink (§2.6); we record that a dictation client was active only if the customer's client exposes it — otherwise the audit says "text input" and does not claim provenance it cannot prove |
| **Commands** | Recognised after transcription in-app: `next section`, `strike that`, `insert macro <name>`, `sign` (sign requires confirmation, never voice-only) | Voice never triggers an irreversible action without a confirmation step |

**Offline:** in-app dictation requires the relay, so it is unavailable offline — the UI says so and
keeps the microphone control disabled rather than failing silently. Third-party OS dictation
generally still works offline, which is a genuine argument for supporting it well.

### 5.5 Interoperability conformance

| Test | Method |
|---|---|
| FHIR payload validity | Validator against the customer's declared profile + US Core-style constraints where applicable |
| SMART launch | Scripted launch against a reference EHR sandbox per major vendor, recorded as a contract test |
| DICOMweb | Against a reference PACS sandbox and one customer system before go-live |
| HL7 v2 ORU | Message-level golden files + an interface-engine round trip |
| DICOM SR | Round-trip through the customer's viewer, signed off by the customer, not by us |
| Information blocking | Document that exports and APIs are available without special effort; keep a written position (§7.1) |

**Assumption to validate early:** each customer's FHIR surface is narrower than the specification.
Budget discovery time per site — this is the single most common source of schedule slip in clinical
integrations.

---

## 6. Data model

### 6.1 Principles

1. **Clinical rows are append-only.** Reports move through revisions; nothing in place is mutated
   after signature. Updates to drafts are allowed but produce a revision record on transition.
2. **Every state change carries its evidence.** The audit event is written in the same transaction.
3. **Referential integrity is enforced in the database**, not only in the ORM.
4. **PHI is stored narrowly.** Demographics referenced by id, not copied; free text is the only
   unavoidable PHI and it is the only thing the encryption story needs to protect.
5. **Tenancy is a column, not a deployment.** `org_id` on every clinical table, protected by RLS.

### 6.2 Entities

| Table | Key columns | Notes |
|---|---|---|
| `org` | `id`, `name`, `timezone`, `settings jsonb` | Tenant root |
| `user` | `id`, `org_id`, `idp_subject`, `display_name`, `roles text[]`, `active` | Mirrors IdP; no credentials stored |
| `user_credential` | `user_id`, `type` (medical_license/DEA/none), `identifier_hash`, `expires_at` | Signing eligibility, not identity |
| `template` | `id`, `org_id`, `name`, `scope`, `modality`, `body_system`, `type`, `current_version_id`, `status`, `provenance` | `provenance` records authorship/licence source — required for the licensing risk (§7.6) |
| `template_version` | `id`, `template_id`, `version`, `body text`, `token_stream jsonb`, `fields jsonb`, `content_hash`, `created_by`, `created_at` | **Immutable**; unique `(template_id, content_hash)` |
| `study` | `id`, `org_id`, `study_instance_uid`, `accession`, `modality`, `body_part`, `performed_at`, `patient_id` | Join key to PACS/EHR |
| `patient_ref` | `id`, `org_id`, `mrn_hash`, `birth_date`, `sex`, `fhir_id` | Minimal; `mrn` stored hashed + separately encrypted if lookup requires it |
| `report` | `id`, `org_id`, `study_id`, `template_version_id`, `state`, `author_id`, `assigned_signer_id`, `current_hash`, `created_at`, `signed_at`, `urgent`, `parent_report_id` (addendum) | `template_version_id` pins the snapshot |
| `report_revision` | `id`, `report_id`, `revision`, `sections jsonb`, `field_values jsonb`, `content_hash`, `author_id`, `reason`, `created_at` | Append-only; `reason ∈ draft_save, submitted, edited_and_approved, returned, addendum` |
| `signature` | `id`, `report_id`, `revision_id`, `actor_id`, `role` (`author`/`approver`/`delegate`), `method` (`password_step_up`/`sso_step_up`/`hardware_key`), `content_hash`, `signed_at`, `on_behalf_of`, `auth_context jsonb` | Unique `(report_id, revision_id, role)` |
| `cosign_assignment` | `id`, `report_id`, `from_user_id`, `to_user_id`, `reason`, `created_at`, `resolved_at` | Keeps reassignment history visible |
| `validation_ack` | `id`, `report_id`, `revision_id`, `issue_id`, `acked_by`, `acked_at` | Soft-tier acknowledgements are evidence |
| `delivery` | `id`, `report_id`, `target` (`ehr`/`pacs`/`hl7`), `kind`, `idempotency_key`, `state`, `attempts int`, `last_error`, `receipt jsonb` | At-least-once with idempotency |
| `export_artifact` | `id`, `report_id`, `format`, `storage_key`, `sha256`, `bytes`, `created_at`, `worm` | Sealed only for signed reports |
| `audit_event` | `id`, `org_id`, `at`, `actor_id`, `actor_role`, `action`, `subject_type`, `subject_id`, `before_hash`, `after_hash`, `prev_hash`, `hash`, `meta jsonb` (no PHI) | Hash chain per org |
| `dictation_session` | `id`, `report_id`, `user_id`, `section_key`, `engine`, `started_at`, `ended_at`, `chars_committed`, `deleted_unchanged` | Metadata only — never audio, never transcripts |
| `delegation` | `id`, `org_id`, `delegate_id`, `on_behalf_of_id`, `scope jsonb`, `starts_at`, `ends_at`, `created_by` | Time-boxed, scoped |
| `outbox` | `id`, `aggregate`, `payload jsonb`, `available_at`, `attempts` | Server-side job dispatch |

### 6.3 Invariants worth writing as constraints

| Invariant | Enforcement |
|---|---|
| A report references exactly one immutable template version | FK, no update path on `template_version` |
| A report cannot be `SIGNED` without ≥1 `signature` for its latest revision | Deferred constraint + service check; test asserts both |
| `signature.content_hash` equals `report_revision.content_hash` at signing time | Service check + DB trigger |
| Co-sign requires distinct `actor_id` for `author` and `approver` roles | Unique index + service rule |
| Audit chain is contiguous per org | `hash = sha256(prev_hash ‖ canonical(event))`; nightly verification job |
| Signed artifacts are immutable | Object Lock / WORM + no delete grant |
| Field values only for fields declared by the pinned template version | Service validation + `field_key` FK into `template_version.fields` |
| Deleting a template is impossible while any report references it | FK with `ON DELETE RESTRICT`; deprecate instead |

### 6.4 Indexing and volume (per 400-radiologist org, year one)

| Table | Rows/yr (est.) | Index strategy |
|---|---|---|
| `report` | ~300,000 | `(org_id, state, assigned_signer_id, created_at)`, `(study_id)` |
| `report_revision` | ~1.2 M | `(report_id, revision)` unique |
| `audit_event` | ~6–10 M | `(org_id, at)` BRIN + `(subject_id, subject_type)`; partition monthly |
| `export_artifact` | ~300,000 | `(report_id)`; blobs in object storage, not in PG |
| `delivery` | ~900,000 | `(state, available_at)` partial index on pending |

`audit_event` is partitioned by month with a retention job that detaches and archives partitions to
WORM storage — the practical way to hold 7+ years without unbounded index growth.

### 6.5 Co-signature data shape (S2)

```
report 1 ─── n report_revision ─── n signature
                    │                 └── role: author | approver | delegate
                    └── reason: draft_save | submitted | edited_and_approved | returned | addendum
```

Three properties this buys, and why they matter:

- **Solo vs. co-sign is a query, not a schema difference.** A solo-signed report has one `approver`
  (or `author` where policy permits self-sign). No nullable column pair, no `is_cosigned` flag.
- **Edit-and-approve is representable.** The attending's edit is a new revision with
  `reason = edited_and_approved`, and their signature points at *that* revision — so the content they
  approved is provably the content that was signed.
- **Delegation and addenda are additive.** `on_behalf_of` and `parent_report_id` need no migration.

---

## 7. Security and compliance

### 7.1 Regulatory positioning (needs counsel sign-off, not engineering judgement)

- **Device/SaMD position.** The product documents physician-authored content and does not interpret
  images or recommend diagnoses. That boundary supports a "documentation tool" position in the US and
  a non-device or low-risk classification argument in the EU, but the classification is a legal
  determination that must be made per market *before* the first customer, and re-reviewed whenever a
  feature touches clinical content generation. If any AI-suggestion feature is added later, expect
  the analysis to change and plan the QMS work accordingly.
- **HIPAA (US).** Business Associate Agreements with every subcontractor that can touch PHI,
  including the ASR vendor and the object-storage provider. Administrative, physical and technical
  safeguard documentation maintained as living artefacts, not a one-time binder.
- **Information blocking (US).** The app is a consumer and producer of EHI. The working position:
  exports (FHIR, PDF, text) are available without special effort, APIs are documented, and no
  contractual or technical barrier is placed on EHI access. Keep a written, current position
  statement — and note that the regulatory landscape here is actively changing, so date every claim.
- **GDPR / UK GDPR (EU/UK).** Lawful basis, DPIA per deployment, data minimisation (this is why
  demographics are referenced, not copied), processor agreements, and a data-residency option.
- **Audit-trail expectations.** Signatures and audit should be defensible against the questions a
  malpractice review actually asks: who wrote which words, who approved them, on what device, with
  what authentication strength, and can the record have been altered afterwards.

### 7.2 Threat model (STRIDE, abbreviated to what is specific here)

| Threat | Vector | Control |
|---|---|---|
| **Spoofing** | Stolen session signs a report | Short-lived tokens, step-up re-auth (≤15 min) before sign, device/session binding where the IdP supports it, signature bound to `auth_context` |
| **Tampering** | A signed report is altered in the DB or the artifact is swapped | Hash chain + `signature.content_hash` + WORM artifacts + nightly chain verification |
| **Repudiation** | "I never approved that" | Co-signature records actor, role, revision, hash, timestamp, auth method; delegation records both parties |
| **Information disclosure** | PHI in logs/traces/caches/exports/clipboard | Log redaction by field path, no PHI in span attributes, SW allowlist, no third-party origins, no session replay, export destination logged, clipboard action explicit |
| **Denial of service** | Editor unusable at shift change | Load-shedding on non-critical endpoints, queue isolation for exports, offline authoring as the natural fallback |
| **Elevation of privilege** | Resident self-approves | Server-side separation of duties; self-approval impossible except where policy explicitly allows solo sign |
| **Supply chain** | Malicious dependency in a PHI app | Pinned versions, lockfile review, SBOM, Trivy gate, signed images, no post-install scripts |

Two threats that are usually missed and are specific to this design:

- **The dictation relay** is a PHI egress point. It must not persist audio, must authenticate per
  session, must bound session length, and must be in the same trust boundary as the API.
- **The service worker** is a durable cache next to PHI. Its allowlist must be a constant in the
  codebase with a test that asserts no PHI-bearing route can be matched by it.

### 7.3 Data protection in depth

| Layer | Control |
|---|---|
| Transport | TLS 1.3 preferred, 1.2 floor; HSTS; mTLS to on-prem PACS/IdP where supported |
| At rest (disk) | Provider/volume encryption |
| At rest (application) | AES-256-GCM envelope encryption for free-text PHI columns via KMS data keys; per-org key hierarchy |
| At rest (device) | Local drafts optionally encrypted with a non-extractable WebCrypto key; prefer OS-level full-disk encryption as the primary control and treat app-level encryption as defence in depth |
| Keys | KMS with rotation, separated by environment; no keys in the repo, ever; envelope keys re-wrapped on rotation without re-encrypting blobs |
| Access | RLS + service-level authorization; break-glass read requires a reason code and notifies the security channel |
| Retention | Configurable; deletion is a recorded event with a tombstone, executed by a job, verified by a report |

### 7.4 Identity and session

- OIDC authorization code + PKCE against the hospital IdP; no local passwords.
- Role mapping from IdP groups, with an org-level override table for exceptions (auditable).
- Session: 30-minute idle for authoring, 15-minute freshness requirement for signing, absolute
  session cap 12 h; refresh token rotation with reuse detection.
- Signing additionally requires the credential record to be current (`user_credential.expires_at`),
  which is a real operational issue: expired licences must surface *before* someone tries to sign at
  2 a.m.

### 7.5 Security programme (ongoing, not a phase)

| Activity | Cadence |
|---|---|
| Dependency and container scanning | Every build; block on high/critical with a fix path |
| SAST (Semgrep ruleset for the codebase) | Every PR |
| DAST against staging | Weekly |
| External penetration test | Pre-launch, then annually, plus after any auth change |
| Threat-model review | Per major feature |
| Access review (who has prod) | Quarterly |
| Incident response tabletop | Twice yearly, including a PHI-breach scenario with notification timelines |
| Backup restore drill | Quarterly (§16.4) |
| Audit-chain verification | Nightly automated; alert on break |

### 7.6 Template licensing (blocks launch, not engineering)

130 of the 427 files are RSNA-authored and 127 come from other platform users. Before any customer,
establish: which templates may be redistributed, which must be replaced with org-authored
equivalents, and what `provenance` each carries. The data model already has the column; the legal
work is the dependency.

---

## 8. API design

### 8.1 Conventions

- REST over HTTPS, JSON, `snake_case` in payloads (matches DB and avoids two naming vocabularies).
- Versioned path: `/v1/...`. Breaking changes require `/v2`; additive changes are allowed in place
  and announced in the changelog.
- OpenAPI 3.1 generated from the Zod schemas — the spec is an artefact of the code, never hand-kept.
- Errors use RFC 9457 `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`,
  and a stable `code` for clients to branch on.
- Idempotency: `Idempotency-Key` on all POST/PATCH that create or transition state; server stores
  the key for 24 h with the response.
- Pagination: cursor-based (`?cursor=&limit=`), `limit` default 25, max 100.
- Concurrency: `If-Match` with the report's `current_hash` on content updates; a mismatch returns
  `409` with the current state so the client can offer a merge.
- Rate limits: per user and per endpoint class, returned in `RateLimit-*` headers.

### 8.2 Resources and endpoints (abridged to the load-bearing ones)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/templates?modality=&type=&scope=&q=` | Library browse/search |
| `GET` | `/v1/templates/{id}/versions/{v}` | Pinned version (token stream + fields) |
| `POST` | `/v1/templates/{id}/versions` | New version (template owner; never mutates existing) |
| `POST` | `/v1/reports` | Create from `{study_id, template_version_id}` — captures baseline hash |
| `GET` | `/v1/reports/{id}` | Report + latest revision + signatures + validation summary |
| `PATCH` | `/v1/reports/{id}` | Save draft (sections/fields) — `If-Match` required |
| `POST` | `/v1/reports/{id}:submit` | `DRAFT` → `PENDING_COSIGN`; records submission hash |
| `POST` | `/v1/reports/{id}:return` | `{reason_code, comment?}` → `RETURNED` |
| `POST` | `/v1/reports/{id}:sign` | Solo approve (`{method, step_up_token}`) |
| `POST` | `/v1/reports/{id}:cosign` | Approve or edit-and-approve (`{revision?, method, step_up_token}`) |
| `POST` | `/v1/reports/{id}:addendum` | New revision on a signed report |
| `POST` | `/v1/reports/{id}:retract` | Reason-code gated; admin + attending |
| `GET` | `/v1/reports/{id}/diff?against=baseline\|revision` | Structured diff for review UI |
| `POST` | `/v1/reports/{id}/exports` | `{format}` → job id; returns artifact when ready |
| `GET` | `/v1/reports/{id}/artifacts/{artifactId}` | Presigned, short-lived, access-logged |
| `GET` | `/v1/queues/cosign?assignee=me` | Co-sign worklist with SLA age |
| `POST` | `/v1/delegations` | Create time-boxed delegation |
| `GET` | `/v1/audit?subject_id=&from=&to=` | Auditor role only |
| `POST` | `/v1/integration/{target}/replay` | Replay a failed delivery (admin) |
| `GET` | `/v1/health/live`, `/v1/health/ready` | Probes |
| `GET` | `/v1/.well-known/configuration` | Client bootstrap (features, limits, ASR availability) |

### 8.3 Example: co-sign

```http
POST /v1/reports/8f2c...:cosign
If-Match: "sha256:4b1e9c..."
Idempotency-Key: 0b6f7a3e-...
Authorization: Bearer <access token>

{
  "decision": "edit_and_approve",
  "draft": { "sections": [ ... ], "field_values": { "lesion_size": "18 mm" } },
  "method": "sso_step_up",
  "step_up_token": "<short-lived, audience-scoped>",
  "comment": "Measurements updated to match the series 4 images."
}
```

```json
201 Created
{
  "report_id": "8f2c...",
  "state": "SIGNED",
  "revision": 4,
  "content_hash": "sha256:9d0a...",
  "signatures": [
    { "role": "author",   "actor": "u_res_118", "revision": 3, "at": "2026-10-29T08:12:04Z" },
    { "role": "approver", "actor": "u_att_042", "revision": 4, "at": "2026-10-29T09:41:17Z",
      "method": "sso_step_up" }
  ],
  "deliveries": [
    { "target": "ehr", "state": "queued", "idempotency_key": "8f2c:4:ehr" },
    { "target": "pacs", "state": "queued", "idempotency_key": "8f2c:4:pacs" }
  ]
}
```

Note what the response does **not** claim: it does not say "delivered". Delivery is a separate,
pollable, replayable state machine (§5.2), because conflating "signed" with "delivered" is how
reports go missing quietly.

### 8.4 Machine-to-machine surface

A separate, narrowly scoped path for the EHR/interface engine: client-credentials OAuth, one
permission per endpoint, no wildcard scopes, request signing (HMAC) for the HL7 bridge, and its own
rate limits so a misconfigured integration cannot starve interactive users. Audit records
`actor_type = service` distinctly.

---

## 9. Responsive UX and accessibility

### 9.1 Layout system

One scroll container, two collapsible panels, and a document column that never fights the panels for
width. The rules below are the ones that survived contact with real browsers; they are specified
here as a contract, not a suggestion.

| Breakpoint | Layout | Panels | Nav |
|---|---|---|---|
| ≥1440 | Three columns: 236 / fluid / 316 | Both visible, sticky, own scroll | Inline |
| 1280–1439 | Three columns: 212 / fluid / 292 | Both visible | Inline |
| 1024–1279 | Two columns: rail + document | Review becomes a right drawer (`Review` button with issue badge) | Inline |
| 768–1023 | One column | Both panels become drawers | Inline |
| <768 | One column | Both drawers, one at a time | Behind `☰` |
| <480 | One column | Drawers full-bleed | `☰`; secondary controls collapse |

Implementation constraints that caused real defects and are now mandatory:

- `body` does not scroll; `#main` is the only scroll container; `.app-shell` is `100dvh`. This makes
  drawers deterministic and avoids URL-bar resize jank on tablets.
- Panel width/padding/gap come from single tokens (`--rail-w`, `--context-w`, `--drawer-w`,
  `--panel-pad`, `--panel-gap`). Two sidebars must never define their own spacing.
- Drawers are bottom-anchored with an **explicit height** `calc(100dvh - var(--topbar-h))`; a
  `top`+`bottom` fixed flex container with `min-height: auto` sizes to content and grows the wrong
  way.
- `--topbar-h` is measured at runtime (`ResizeObserver`), never hard-coded — the bar height differs
  between routes.
- Closed drawers are `inert` + `visibility: hidden`, so they are out of the tab order and the
  accessibility tree, not merely translated off-screen.
- Zero horizontal overflow is an assertion in the E2E suite at every breakpoint, not a review item.

### 9.2 Device-specific behaviour

| Device | Authoring | Signing | Notes |
|---|---|---|---|
| Desktop (primary) | Full | Full | Keyboard-first; command palette; dictation hotkey |
| Laptop 1280 | Full | Full | Review panel as drawer if below threshold |
| Tablet landscape 1024 | Full | Full | On-screen keyboard reduces usable height — the document column must still scroll, panels must close |
| Tablet portrait 768 | Full (with drawers) | Full | Dictation used heavily here; microphone control must be thumb-reachable |
| Phone | **Read/approve only** | Co-sign with step-up | Reduced editor: section list, not full document; explicit "open on desktop to edit" |

### 9.3 Key screens

1. **Worklist / library** — facets, search, recent, templates by modality; infinite scroll with
   cursor pagination; keyboard `j/k` navigation.
2. **Editor** — outline rail (section + field completion), document column, review rail (validation,
   study metadata, export, sign). Status line: save state, field progress, issue counts, section count.
3. **Review diff** — for co-signers: baseline vs. current, changed sections collapsed by default with
   counts; approve/return actions pinned.
4. **Co-sign queue** — SLA-sorted, urgent flagged, bulk-select for low-risk approvals with an explicit
   warning that bulk approval does not skip validation.
5. **Dictation overlay** — live partial transcript, insert/discard, engine indicator, latency hint; never
   covers the target field.
6. **Settings** — security (encryption state), storage, theme, library stats, integration health
   (admin only).
7. **Admin** — template versions + diff + deprecation; role mapping; delivery health; audit export.
8. **Downtime view** — offline banner, queued-for-signature list, downtime export action.

### 9.4 Accessibility (WCAG 2.2 AA, non-negotiable)

- Contrast ≥4.5:1 body, ≥3:1 large/UI; verified for both themes in CI with a token-level check.
- Target size ≥24×24 CSS px (2.2 AA), 44×44 for primary actions in touch layouts.
- Full keyboard operation of every workflow, including signing; visible focus at all times; focus
  returns to the invoking control when a dialog or drawer closes.
- Landmarks + skip link; headings hierarchical; `aria-live` for save state and validation changes
  (polite, never for every keystroke).
- No focus theft: toasts and background saves must not move focus — this is also a dictation
  requirement (§2.6), so the two constraints reinforce each other.
- Reduced motion honoured; no animation that hides state.
- Screen-reader pass on editor, co-sign and sign flows each release; automated axe in CI catches
  regressions but does not replace the manual pass.

### 9.5 Performance budgets

| Budget | Value | Enforcement |
|---|---|---|
| Shell JS (gzip) | ≤300 KB | build-time size check |
| Editor island (gzip, lazy) | ≤450 KB | chunk size assertion |
| LCP, library, reference laptop | ≤2.5 s | Lighthouse CI |
| INP | ≤200 ms | field RUM (sampled, no PHI) |
| Keystroke → paint | p95 ≤16 ms | synthetic trace in CI on a throttled profile |
| Template library payload | 1.7 MB → ≤400 KB via per-modality lazy load | asset budget |

Long documents are the performance risk: the outline is built once and counts are patched in place;
validation is debounced (140 ms) while typing and immediate on discrete actions; the status bar has no
backdrop filter (it repaints on every scroll frame).

---

## 10. Testing strategy

### 10.1 Layers and what each is responsible for proving

| Layer | Tool | Proves | Gate |
|---|---|---|---|
| Type / lint | `tsc --strict`, ESLint, Prettier | Contracts hold | Every PR |
| Unit | Vitest | Token model, validation rules, all renderers, hashing | Every PR |
| Property-based | fast-check | `render(parse(x)) === x` over generated documents; placeholder scanner never emits literal brackets | Every PR |
| Golden corpus | 427 fixtures | Import + serialise + validate produce byte-identical output to the recorded baseline | Every PR (any diff = review) |
| Component | Testing Library | Field widgets, drawers, focus return, `inert` behaviour | Every PR |
| E2E | Playwright, 6 viewport projects | Full workflows: solo sign, co-sign approve/return/edit-and-approve, offline authoring, recovery, dictation injection | Every PR (smoke) + nightly (full) |
| Accessibility | axe-core in Playwright + manual SR pass | WCAG 2.2 AA | Every PR (axe), per release (manual) |
| Visual / geometry | Playwright screenshots + bounding-box assertions | Panel widths, drawer overlap, overflow | Every PR |
| Contract | Pact-style against recorded EHR/PACS sandboxes | Adapter payload shape and error handling | Nightly |
| Interop | FHIR validator, DICOM SR round-trip, HL7 golden messages | Standards conformance | Nightly + per release |
| Load | k6 | NFR-3, NFR-14 | Nightly + pre-release |
| Security | SAST, dependency scan, Trivy, ZAP baseline | No known-bad dependency, no trivial DAST finding | Every PR / weekly |
| Clinical validation | Scripted UAT with radiologists | The workflow is correct, not just functional | Per release candidate |

### 10.2 The tests that would have caught the prototype's worst bugs

These are named explicitly because they are the ones teams skip:

1. **Stale-subscription test** — open report A, navigate to B, type; assert the status line reflects B.
   (The prototype painted A's save time into B.)
2. **Honest-label test** — go offline, edit, wait for autosave; assert the label is "Offline — saved
   locally" and never "Saved".
3. **Drawer geometry assertion** — at each breakpoint, open the drawer and assert
   `rect.top === topbar.bottom` and `rect.bottom === innerHeight` within 1 px, plus
   `document.elementFromPoint(at the top bar) === the top bar`.
4. **Overflow assertion** — `document.scrollWidth === document.clientWidth` at all six viewports.
5. **Focus-return test** — open drawer via button, press Escape, assert focus is on that button.
6. **Inert test** — 8-Tab walk from the toggle reaches no control inside a closed drawer.
7. **Update-during-edit test** — activate a new service worker with a dirty document; assert no data
   loss and that the reload is user-initiated.

### 10.3 Test data

- **No real PHI in any environment below production.** Synthetic patients generated from a fixed
  seed, with realistic edge cases: 120-character names, non-Latin scripts, missing MRN, duplicate
  accession.
- **A fixture per structural pathology:** every template family, a template with no IMPRESSION, one
  with no FINDINGS, one with nested placeholders, one with a space-before-colon heading.
- Production-derived fixtures require an approved de-identification step and are stored separately,
  never in the repo.

### 10.4 Definition of done (per feature)

Code + types · unit and E2E coverage of the happy path *and* the two most likely failure paths ·
a11y check · telemetry event defined · runbook note if it can page someone · docs updated · feature
flag with a documented removal date.

---

## 11. CI/CD

### 11.1 Pipeline

```
PR:      lint → typecheck → unit → property → golden corpus → build → E2E smoke (6 viewports)
         → axe → bundle budget → SAST → dependency audit → preview deploy (synthetic data)

main:    above, plus → E2E full → contract tests → container build → SBOM (Syft) → scan (Trivy)
         → sign (cosign) → push → deploy staging → migrations (dry run) → smoke → manual gate

release: staging soak 24 h → change record → deploy prod (canary 10% → 100%) → smoke
         → post-deploy verification → announce
```

### 11.2 Rules

- **Trunk-based** with short-lived branches (<2 days) and feature flags for anything incomplete.
- **Required checks** are the gate; no "merge and fix CI later". A red main is a team-stopping event.
- **Migrations are forward-only**, reviewed as SQL, tested against a production-shaped snapshot, and
  must be backward-compatible with the *previous* application version (so a rollback does not require
  a down-migration).
- **No secrets in CI logs**; environment-scoped secrets with least privilege; production deploys
  require a second approver.
- **Release train** weekly for routine changes, on-demand for hotfixes; a hotfix still runs the full
  security gate.
- **Rollback** is a first-class button: previous image + previous service-worker version, exercised
  in staging every release.

### 11.3 Branching for the corpus

Templates and the golden fixtures live in the repo. A template change is a reviewed PR with a diff,
and CI re-runs the 427-file round-trip. This is the only way the clinical library stays under version
control at all.

---

## 12. Infrastructure and environments

### 12.1 Environment matrix

| Env | Purpose | Data | Access | Lifespan |
|---|---|---|---|---|
| `local` | Development | Synthetic | Developer | Persistent |
| `preview` | Per-PR review | Synthetic | Team | PR lifetime |
| `staging` | Integration + UAT + load | Synthetic, production-shaped | Team + clinical validators | Persistent |
| `production` | Live | PHI | Break-glass only | Persistent |
| `dr` | Failover target | Replicated PHI | Break-glass | Persistent, warm |

### 12.2 Topology (per deployment profile)

| Component | Cloud-with-BAA profile | On-prem profile |
|---|---|---|
| Web + API | Managed container service, 3+ AZs | Kubernetes (3 control-plane, 3+ workers) |
| Worker | Separate service, own queue | Same cluster, separate namespace |
| PostgreSQL | Managed HA (multi-AZ), PITR | Patroni + etcd, streaming replica, WAL to object storage |
| Redis | Managed | Sentinel or cluster |
| Object storage | S3 + Object Lock | MinIO with versioning + immutability |
| Ingress | Managed LB + WAF | nginx/HAProxy + hospital WAF |
| IdP | Entra ID / Okta | Keycloak or ADFS |
| Secrets | Managed KMS/Secrets Manager | Vault |
| Observability | OTel → managed backend | OTel → self-hosted Prometheus/Loki/Tempo |

### 12.3 Sizing per 400-radiologist organisation

| Component | Baseline | Peak headroom | Notes |
|---|---|---|---|
| API | 2 × 2 vCPU / 4 GB | 6 replicas (HPA on p95 latency + CPU) | Stateless; session in Redis |
| Worker | 1 × 2 vCPU / 4 GB | 3 | Export is CPU-bound; scale on queue depth |
| PostgreSQL | 4 vCPU / 16 GB, 500 GB SSD | Vertical + 1 read replica for reporting | Audit partition pruning keeps the working set small |
| Redis | 1 GB | 4 GB | Queue + cache; not a source of truth |
| Object storage | 200 GB/yr (PDFs ~600 KB avg) | — | Lifecycle to cold tier at 90 days |

### 12.4 Network and hardening

Private subnets for data services; no public database endpoint; egress allowlist (EHR, PACS, IdP,
ASR relay only); read-only container filesystems; non-root users; seccomp/AppArmor profiles; network
policies denying pod-to-pod by default; admin endpoints behind a separate listener and IP allowlist.

---

## 13. Observability

### 13.1 Three signals, one rule

**Rule: no PHI in telemetry.** Names, MRNs, DOB, free text and report content never enter metrics,
traces or logs. Report identifiers are opaque UUIDs; if a trace needs correlation to a patient, it
carries the internal `study_id`, which is meaningless outside the system. Redaction is implemented as
an allowlist of loggable fields, not a denylist of forbidden ones.

### 13.2 SLIs and SLOs

| SLI | SLO | Alert burn |
|---|---|---|
| Signing availability | 99.95% / 30 d | Multi-window burn rate (1h/6h/3d) |
| Authoring availability | 99.9% / 30 d | Same |
| Sign latency (p95) | < 800 ms | 1h window |
| Draft save latency (p95) | < 300 ms | 1h window |
| Delivery success within 5 min | ≥99% per target | 30 min window |
| Co-sign queue age (p90) | < SLA | Daily digest, escalating |
| Client error rate | < 0.5% of sessions | 15 min window |
| Service worker update adoption | >90% within 24 h | Daily |

### 13.3 Dashboards

1. **Clinical operations** — reports authored/signed per hour, drafts stuck >24 h, co-sign queue age by service, escalation count.
2. **Integration health** — delivery success by target, error codes, retry depth, adapter latency.
3. **Platform** — latency, saturation, DB connections, queue depth, error budget remaining.
4. **Security** — failed step-ups, break-glass reads, audit-chain verification result, denied requests by user.

### 13.4 Alerting policy

Page only for: signing path down or degraded, signature/audit write failure, delivery failure above
threshold for >15 min, audit-chain verification failure, database failover, storage >85%. Everything
else is a ticket. A pager that fires for dashboards is a pager people ignore by month three.

### 13.5 Audit vs. observability

These are different systems with different retention, access and integrity requirements. Audit is a
clinical-legal record (append-only, hash-chained, 7+ years, SIEM-exported). Observability is
operational telemetry (30–90 days, sampled, no PHI). Conflating them is a common and expensive
mistake — audit must survive a logging-backend migration.

---

## 14. Release management, environments and cutover

| Stage | Entry criteria | Exit criteria |
|---|---|---|
| Internal alpha | Vertical slice working | Team uses it daily for a week |
| Clinical alpha | Solo sign + co-sign + dictation working | 2–3 radiologists complete scripted cases in staging |
| Shadow mode | Integration live in staging against real sandbox | 200+ reports produced in parallel; parity reviewed |
| Pilot | Shadow parity acceptable | One modality, one site, 2–4 weeks, downtime drill passed |
| General rollout | Pilot exit criteria met | All target sites live, rollback rehearsed |

**Cutover mechanics:** dual-run (old system remains authoritative) until parity is signed off by the
clinical lead; a documented freeze window; on-call staffed for 72 hours post-cutover; a printed
downtime procedure shipped with the app rather than in a wiki nobody opens at 3 a.m.

**Change management:** every production change has a record (what, why, risk, rollback, verification);
clinical-facing changes (validation rules, template updates, workflow defaults) require clinical
sign-off, not just engineering review.

---

## 15. Scalability and capacity

### 15.1 Load model (design point, per 100 active radiologists)

| Metric | Value |
|---|---|
| Reports/day | ~300 (≈0.75/radiologist/shift-hour peak factor 3) |
| Peak API rps | ~40 |
| Peak concurrent editors | ~25 |
| Autosave writes/min per editor | 6 (debounced) |
| Journal writes/min per editor | 40 (local only, not server) |
| Peak export jobs/hour | ~30 |
| Report document size | p50 8 KB, p99 120 KB, ceiling 2 MB |

### 15.2 Scaling approach

| Dimension | Strategy |
|---|---|
| Stateless API | Horizontal; HPA on p95 latency and CPU; sticky-free (session in Redis) |
| Exports | Queue-depth autoscaling; separate worker pool so a PDF spike cannot starve signing |
| Database | Vertical first (cheap to 32 vCPU), then read replica for analytics; partition `audit_event` monthly; keep hot tables narrow |
| Audit volume | Partition + archive to WORM; never queried by the UI beyond a bounded window |
| Object storage | Effectively unbounded; lifecycle tiering |
| Multi-tenancy | `org_id` + RLS from day one; v1 deploys single-tenant, so the first SaaS tenant needs no schema change |
| Client cost | Lazy per-modality template loading; document rendered incrementally for 40-section reports |

### 15.3 Cost sketch (order of magnitude, cloud-with-BAA)

Compute ~USD 900–1,500/month, managed Postgres ~400–800, storage ~50, observability ~300, IdP
licensing per user (customer's), ASR per audio-minute (the variable that actually grows). ASR is the
cost driver to model carefully: a busy radiologist dictating 90 minutes a shift is 30+ hours of audio
per month per user.

### 15.4 What breaks first (and the fix)

1. **ASR cost and latency** → contract minimums, on-prem fallback, per-modality routing.
2. **Co-sign queue contention** at shift change → assignment smoothing, batch review, read replica for
   queue queries.
3. **Export backlog** during month-end reporting → separate queue with its own concurrency, and
   priority for interactive exports over batch.
4. **Audit table growth** → partitioning (already designed) and archive; this is predictable, so there
   is no excuse for being surprised.

---

## 16. Disaster recovery

### 16.1 Targets

| Data | RPO | RTO | Mechanism |
|---|---|---|---|
| Signed reports + signatures + audit | 0 | 4 h | Synchronous replica ack before commit; PITR; WORM artifacts |
| Drafts | ≤60 s | 1 h | Autosave + append-only journal; local copies on client |
| Templates | 0 | 1 h | Version-controlled in git + DB; both recoverable |
| Configuration / IaC | 0 | 1 h | Git is the source of truth |
| Telemetry | 24 h | n/a | Acceptable loss |

### 16.2 Scenarios and responses

| Scenario | Response |
|---|---|
| Single AZ failure | Automatic failover; no action; verify SLO |
| Database corruption | PITR to a point before the corrupting event; replay the delta from audit + local drafts |
| Region loss | Promote `dr`; DNS switch; verify signature chain integrity before accepting writes |
| Ransomware / destructive insider | Immutable backups are the control; WORM artifacts cannot be encrypted by an attacker with app credentials; rebuild from IaC + last clean backup |
| Third-party outage (EHR/PACS/ASR) | Degrade gracefully: authoring continues, delivery queues, dictation disabled with a visible reason |
| Client data loss | Local drafts only exist client-side; recovery relies on server autosave — hence the 60 s RPO, and hence the journal |

### 16.3 The clinical downtime procedure (product feature, not IT policy)

Offline authoring + queued signatures + a printable downtime export exist precisely so the answer to
"the system is down" is a procedure the radiologists already know, not an improvised one. The
procedure is tested in a drill that includes: network cut, cache cleared, restore, reconciliation of
queued drafts.

### 16.4 Test cadence

| Test | Cadence | Success criterion |
|---|---|---|
| Restore from backup into a clean environment | Quarterly | Data matches within RPO; audit chain verifies |
| Region failover game day | Twice yearly | RTO met; clinical smoke passes on `dr` |
| Downtime drill (clinical) | Quarterly | Radiologists complete the procedure unaided |
| Ransomware tabletop | Yearly | Named owners, notification timelines understood |
| Audit-chain verification | Nightly automated | Continuous, alerting |

---

## 17. Phased implementation roadmap

Nine phases, ~34–40 weeks to general availability with a team of four engineers plus design and a
clinical champion. Durations assume no procurement stalls; integration discovery is the usual source
of slip and is scheduled explicitly rather than assumed away.

| Phase | Weeks | Scope | Exit criteria |
|---|---|---|---|
| **P0 Discovery & compliance framing** | 1–2 | Scope statement, PHI inventory, regulatory position, template licensing, deployment profile, integration discovery per target EHR/PACS | Written positions signed off; integration surface documented per vendor |
| **P1 Foundation** | 2–4 | Git + CI, TypeScript, token model, corpus import with round-trip CI, template versioning, schema | 427/427 in CI; ADRs for stack; preview environments |
| **P2 Authoring core** | 4–9 | Editor (ProseMirror), field widgets, validation tiers, drafts + journal + recovery, library search | A radiologist completes a report in staging unaided |
| **P3 Signing & co-signature** | 9–14 | Signature model, step-up auth, state machine, diff review UI, queue, delegation, audit chain | Solo + co-sign + return + edit-and-approve pass E2E and UAT; audit verifies |
| **P4 Integration** | 12–20 | Adapters: SMART launch, FHIR read/write, DICOMweb, HL7 ORU, delivery state machine, replay | End-to-end in a vendor sandbox: launch → author → sign → `DiagnosticReport final` |
| **P5 Dictation** | 14–19 | ASR relay, streaming UX, command grammar, third-party client conformance | Injected-text conformance suite passes in Chromium + Safari; latency budget met |
| **P6 Offline & resilience** | 18–23 | Outbox sync, conflict handling, downtime view, recovery drills, SW update strategy | Downtime drill passes; no data loss in kill-tests |
| **P7 Hardening** | 22–27 | Performance budgets, a11y audit, pen test, load test, DR game day, SBOM/signing | Pen-test criticals closed; SLOs demonstrated under load |
| **P8 Pilot** | 26–32 | Shadow mode, one modality, training, on-call, rollback rehearsal | Parity signed off; pilot exit criteria met |
| **P9 GA & iterate** | 32–40 | Rollout to remaining sites, template authoring UI, DICOM SR, analytics | All sites live; operational runbooks in use |

**Parallelisation:** P4 (integration) can start as soon as the canonical model exists (early P2),
because adapters depend on the model, not on the UI. P5 depends on the editor from P2. P7 is not a
phase at the end so much as a ratchet — the budgets and tests are added as features land, then the
phase is where they are proven.

**Team:** 1 tech lead/full-stack, 1 frontend (editor/UX), 1 backend (integration-heavy), 1
platform/DevOps (shared), 0.5 designer, 0.2 clinical informaticist, clinical champion ~2 h/week,
security reviewer at gates.

---

## 18. Assumptions, risks, dependencies, open decisions

### 18.1 Assumptions to validate before P1 exits

| # | Assumption | Validate by |
|---|---|---|
| A1 | The hospital's EHR exposes a usable FHIR endpoint with SMART launch for third-party apps | Discovery call + sandbox test |
| A2 | The PACS exposes DICOMweb (QIDO/WADO), not only DIMSE | Discovery + one query test |
| A3 | BAA-able ASR is available at acceptable latency and cost in the customer's region | Vendor evaluation + latency test |
| A4 | Template licensing permits the current corpus | Legal review (§7.6) |
| A5 | Reference hardware can run the editor within the keystroke budget | Perf spike on real hardware, not a VM |
| A6 | Radiologists will accept preview-then-commit dictation | Usability test in P5 |
| A7 | IdP can supply role groups and a step-up/claims mechanism | IdP configuration review |
| A8 | 7-year audit retention is sufficient for all target jurisdictions | Compliance confirmation |

### 18.2 Risk register

| ID | Risk | L | I | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | Template licensing blocks corpus use | H | H | Legal review in P0; org-authored replacement path; `provenance` column ready | Product + legal |
| R2 | EHR FHIR surface is narrower than assumed | H | H | Per-site discovery; adapter isolation; HL7 v2 fallback already scoped | Integration lead |
| R3 | Co-sign workflow does not match the real authority model (e.g. multiple attendings, teaching-file rules) | M | H | Workflow observation before P3; signatures-as-list model absorbs variants | Clinical informaticist |
| R4 | Dictation accuracy unacceptable for pathology/measurement terms | M | H | Site-specific vocabulary; macro library; measurement fields stay typed, not dictated | Clinical champion |
| R5 | Third-party dictation clients fight the editor (caret jumps, duplicate inserts) | M | M | Injected-text conformance suite; cooperative text-sink rules (§2.6) | Frontend |
| R6 | Latency budget missed on hospital hardware | M | M | Perf spikes on real devices; render only visible sections; no per-keystroke re-render | Frontend |
| R7 | Regulatory classification changes once integration/DICOM SR lands | M | H | Re-review at each feature boundary; keep the non-goals list current | Compliance |
| R8 | ASR cost exceeds model | M | M | Contract minimums; per-modality routing; on-prem model option | Product + finance |
| R9 | Audit volume outgrows the database | L | M | Monthly partitioning + WORM archive from day one | Backend |
| R10 | Service worker caches something it should not | L | H | Allowlist constant + test that asserts non-match for PHI routes; review gate on SW changes | Frontend + security |
| R11 | Signing outage during peak | L | H | Redundant signing path, queue isolation, SLO alerting, downtime procedure | Platform |
| R12 | Key-person dependency on the editor engine | M | M | Documented schema + ADRs; pair rotation; second engineer on editor by P4 | Tech lead |

### 18.3 Dependencies (external, dates matter)

| Dependency | Needed by | Impact if late |
|---|---|---|
| Signed BAA(s) — cloud, ASR, any SaaS | P4 | Blocks integration and any PHI handling |
| EHR sandbox + app registration (client id, scopes, launch URL) | P4 start | Integration slips; UI work unaffected |
| PACS test account with DICOMweb enabled | P4 | Write-back path unproven until late |
| IdP group structure + step-up mechanism | P3 | Signing cannot be built as designed |
| Clinical champion time (2 h/week, protected) | P3 through P8 | UAT and workflow corrections slip |
| Legal: template licence position | P1 exit | Cannot ship any customer |
| Security review slot (pen test vendor booked) | P7 | GA date slips; easy to underestimate lead time |
| ASR vendor contract + data-processing terms | P5 | Dictation cannot go to pilot |

### 18.4 Decisions still requiring validation (not yet mine to make)

| # | Decision | Options | Decider | Needed by |
|---|---|---|---|---|
| D1 | Deployment profile per customer | Cloud-with-BAA vs. on-prem | Customer IT + us | P0 |
| D2 | Solo-sign policy | Attending-only vs. configurable per service | Clinical governance | P3 |
| D3 | Multi-attending approval (more than one approver) | Single co-sign vs. N-of-M | Clinical governance | P3 |
| D4 | Addendum vs. corrected report semantics downstream | `DiagnosticReport.status = appended` vs. `corrected` | EHR integration owner | P4 |
| D5 | DICOM SR in v1 or v1.1 | Scope now vs. later | Product + customer | P4 |
| D6 | ASR engine | BAA vendor vs. self-hosted model | Security + finance | P4 |
| D7 | Offline signing | Blocked (current recommendation) vs. deferred signature with later attestation | Compliance + clinical | P6 |
| D8 | Dictation transcript provenance in audit | "text input" vs. engine-attributed | Compliance | P5 |
| D9 | Retention per jurisdiction | 7 / 10 / 20 years | Customer compliance | P2 |
| D10 | Phone authoring | Read-only (recommendation) vs. full | Clinical | P2 |
| D11 | Template authoring in-app | v1 vs. v1.1 | Product | P9 |
| D12 | Bulk co-sign | Allow with warnings vs. disallow | Clinical governance | P3 |

### 18.5 What would make me stop and re-plan

Three signals that the plan is wrong rather than merely late: (a) the EHR cannot supply patient
context at launch, which turns integration from an adapter into a manual workflow; (b) co-sign
authority turns out to be N-of-M with cross-cover rules, which changes the state machine, not just a
query; (c) dictation accuracy in the customer's own vocabulary is unusable, which makes the dictation
requirement a different product (a transcription service) rather than a feature.

---

## Appendix A — Decision log (this document)

| ID | Decision | § |
|---|---|---|
| A1 | Modular monolith, three processes (web/api/worker) | 3.1 |
| A2 | Canonical internal model + one adapter per external system | 3.5 |
| A3 | At-least-once delivery with idempotency keys and visible delivery state | 3.5 |
| A4 | Signatures as a role-tagged list keyed to revisions, not nullable columns | 6.5 |
| A5 | Signing transaction is atomic; exports and delivery are asynchronous | 3.3 |
| A6 | Outbox sync instead of Background Sync API | 3.4 |
| A7 | ProseMirror with constrained schema; field nodes atomic | 4 |
| A8 | No `SpeechRecognition` for PHI by default; ASR behind an internal relay | 5.4 |
| A9 | Third-party dictation supported as OS-level text injection (cooperative text sink) | 2.6 |
| A10 | Offline authoring, online signing | 2.7 |
| A11 | Audit and observability separated (retention, access, integrity) | 13.5 |
| A12 | Single-tenant deployments, tenancy-ready schema | 1.3 / 15.2 |
| A13 | Phone is read/approve only | 9.2 |
| A14 | `PENDING_COSIGN` escalates but never auto-signs | 2.3 |

## Appendix B — Glossary

**Accession** — the order/study identifier from the RIS. **Addendum** — a linked report that corrects
or extends a signed report without mutating it. **Co-sign** — a second, role-distinct approval
signature. **DICOMweb** — RESTful DICOM (QIDO-RS query, WADO-RS retrieve, STOW-RS store).
**DICOM SR** — DICOM Structured Report, a tree-structured clinical document. **EHI** — electronic
health information. **MRRT** — IHE profile for managing radiology report templates. **PHI** — protected
health information. **SMART on FHIR** — OAuth2-based app launch and authorization for FHIR. **TID** —
DICOM template identifier (e.g. TID 1500 for imaging report content). **WORM** — write-once,
read-many storage.
