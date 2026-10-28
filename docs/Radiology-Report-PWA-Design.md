# Radiologist Reporting PWA — Product & Technical Design

**Status:** Design proposal for review · **Version:** 1.0 · **Date:** 2026-10-28
**Source of truth for templates:** `alem-reporting-templates/` (exported from https://connect.alem.health/ > Settings > Report Templates)
**Audience:** product, clinical informatics, engineering, security/compliance, radiology leads

---

## 0. Summary of decisions

| Decision | Choice | Rationale |
|---|---|---|
| Delivery model | Installable PWA, offline-first (local-first data layer), not a native app | Single codebase, instant updates, works on hospital desktops and personal phones/tablets |
| Template model | Immutable versioned templates; reports pin an exact `template_version_id` | Templates change; signed reports must remain reproducible forever |
| Field model | Derived from the template text itself — bracket placeholders become typed fields, everything else is preserved verbatim | Preserves original wording/structure of the 427-file corpus instead of rewriting it |
| Validation | Three tiers: hard block, soft warning, quality nudge | Radiology findings are frequently "normal but atypical"; blocking on completeness causes workarounds |
| Draft persistence | Dual: encrypted local journal + server autosave, outbox queue for offline | Recovery must survive tab crash, device loss, and network loss independently |
| Export | Server-side render workers producing PDF (PDF/A), DOCX, plain text, FHIR `DiagnosticReport` JSON, HL7 ORU; client-side plain text for RIS paste | Fidelity and archival need server rendering; fast paste needs local |
| Signing | Step-up authentication + cryptographic signature record | Report sign-off is a legal act |

---

## 1. Scope, evidence base, and constraints

### 1.1 What the source corpus actually contains

Measured directly from the 427 exported files and the index (`templates_index.csv`):

| Property | Value |
|---|---|
| Files exported | 427 (301 distinct templates + 126 variant versions) |
| Distinct templates | 301 — AlemHealth scope 167, Publicly Shared 134 |
| Template types | **FREE_TEXT 294**, **STRUCTURED 133** |
| Modalities | XR 123, CT 86, MR 77, US 58, DX 32, NM 18, CTA 13, RF 10, MRA 6, PT 2, MRV 1, unset 1 |
| Status | Active 425, Inactive 2 |
| Templates containing bracket placeholders | 258 of 427 (60%) |
| Placeholders per template | median 2, p90 17, max 156 |
| Distinct placeholder strings | 1,111 |
| Body length | median 702 chars, max 4,852 |
| Authors | RSNA 130, other platform users 127, blank 168, AlemHealth 1 |
| Variant parents | 27 templates carry child variants |

**Canonical section coverage** (case-sensitive headings, both formats):

| Section | Templates | % |
|---|---|---|
| EXAM | 426 | 99.8% |
| COMPARISON | 426 | 99.8% |
| FINDINGS | 417 | 97.7% |
| IMPRESSION | 392 | 91.8% |
| CLINICAL HISTORY | 292 | 68.4% |
| TECHNIQUE | 157 | 36.8% |
| CONTRAST | 74 | 17.3% |
| CLINICAL INFORMATION | 43 | 10.1% |

Beyond these, FREE_TEXT templates use **466 distinct organ/system sub-headings** inside FINDINGS — BONES (128), SOFT TISSUES (115), JOINTS (49), ALIGNMENT (34), LUNGS (23), PLEURAL SPACES (18), LYMPH NODES (16), VERTEBRAL BODIES (16), VASCULATURE (15), BOWEL (15), LIVER (14), CARTILAGE (13), PANCREAS (13), and a long tail.

### 1.2 Two structural families — the single most important design constraint

The corpus is **not** homogeneous. It splits into two rendering models, and the editor must handle both without a "lowest common denominator" compromise:

**Family A — FREE_TEXT (294).** Plain prose with UPPERCASE `SECTION:` headings and inline bracketed hints:

```
EXAM:
MR Brain [with or without] Intravenous Contrast.

TECHNIQUE:
Magnetic resonance images of the brain [with or without] intravenous contrast in multiple planes.

FINDINGS:
BRAIN:
No restricted diffusion to indicate acute infarction. ...

IMPRESSION:
Unremarkable brain MRI.
```

**Family B — STRUCTURED (133).** Markdown `##` headings where FINDINGS is a list of **mutually exclusive pick-options** (grading/staging templates), e.g. `AAST Liver Injury Grade` lists the seven injury grades as separate lines. Here the radiologist **selects one option**, not free-types. These are all authored by RSNA or public contributors and are the templates where structured data capture (registries, QA, decision support) actually pays off.

### 1.3 Placeholder grammar (drives the field type system)

1,111 distinct placeholder strings collapse into five machine-detectable classes:

| Class | Examples | Count examples | Field type |
|---|---|---|---|
| Binary / ternary choice | `[with or without]`, `[left/right]`, `[present/absent]`, `[right/left/bilateral]`, `[none]` | 103, 97, 13, 12, 17 | `enum` (single-select chips) |
| Graded choice | `[mild/moderate/severe]`, `[moderate/severe]`, `[small/moderate/large]` | 10, 9, 7 | `enum` ordered |
| Measurement blank | `[__ mm]`, `[__ cm]`, `[__ x __ x __ cm]`, `[__ degrees]` | 55, 23, 9, 7 | `number` + unit, multi-slot |
| Underscore blank | `[___]`, `[_ _]`, `[]` | 64, 16, 37 | `text` (inline) |
| Semantic free text | `[insert history]`, `[location]`, `[generic]`, `[generic bone]`, `[number]` | 19, 24, 24, 13, 14 | `text` (with autocomplete from prior reports) |
| Date / prior study | `[none / prior study dated ___]`, `[comparison date]` | 110, 7 | `dateOrNone` |

Detection rule (deterministic, no LLM required at import time): a bracket token whose inner text contains `/` and whose segments are all short (≤ 24 chars) with no sentence punctuation → `enum`; inner text matching `^_+$` or containing `__` → `number` when a unit token (`mm|cm|degrees|%|HU|ml`) follows, else `text`; inner text containing `dated` → `dateOrNone`; otherwise `text`.

An LLM pass is used **only** as a review assist to propose better labels/types, always as a suggestion the template admin accepts or rejects — never silently applied to the 427 imported templates.

### 1.4 Implications → derived requirements

| Finding | Requirement |
|---|---|
| 60% of templates have placeholders; median 2 but p90 17 | Placeholder-to-field rendering must be automatic and fast, but the **majority typing experience is still free prose** — do not force a form UI |
| 427 files, 301 distinct, 126 variants | Template library needs variants grouping, search, and a "distinct template" concept separate from "file" |
| 12 modalities, uneven distribution | Modality-first navigation and personal "recent/favourite" ranking matter more than taxonomy browsing |
| 130 RSNA-authored, 127 third-party-authored | **Licensing/attribution is an open legal question** (see §11). Import must store `author`, `license`, `source_guid` per template |
| 2 templates are Inactive | Need lifecycle states beyond active/inactive: `draft`, `published`, `deprecated`, `retired` |
| Body max 4,852 chars | A report fits in memory comfortably; whole-document local persistence is feasible |
| 35 templates lack IMPRESSION, 10 lack FINDINGS | Required-field rules **cannot be global** — they must be per-template and per-section |
| Author field exposes raw Auth0 subject IDs in the export | Data minimisation: never carry internal subject IDs into the PWA; resolve to display names or `null` |

### 1.5 Out of scope (v1)

PACS/DICOM image viewing, worklist ingestion from modalities, billing/coding, speech-model training, native mobile apps, multi-tenant SaaS billing. Integration points are specified but not built.

---

## 2. Primary user flows and key use cases

### 2.1 Personas

| Persona | Context | Primary need |
|---|---|---|
| **Consultant radiologist** (primary) | Dual-monitor reading room, dictation mic, 3–8 min per study | Start from template, dictate, sign, move on. Zero friction. |
| **Resident / trainee** | Shared workstation, rotating, lower authority | Draft fully, submit for co-sign, see supervisor edits |
| **On-call radiologist** | Laptop/phone, unstable network, after hours | Work offline, autosave, never lose a report |
| **Reporting admin** | Office hours, desktop | Maintain template library, versions, required fields |
| **QA / clinical governance** | Periodic review | Audit trails, report search, discrepancy review |
| **IT / security** | Occasional | Access control, retention, incident response |

### 2.2 Flow A — New report from template (happy path, target < 4 min)

```
Login (session resumed)
  └─ Study list  ──[select study]──►  Report workspace
        │                                  │
        │                                  ├─ Template auto-suggested (modality + body part)
        │                                  │     └─ accept / search / browse
        │                                  ▼
        │                            Template applied → sections rendered
        │                                  │
        │                            Placeholders become inline fields (chips/inputs)
        │                                  │
        │                            Dictate or type per section
        │                                  │  autosave every 2s idle / 10s max
        │                                  ▼
        │                            "Review" → validation panel
        │                                  │  hard errors block · warnings allow override
        │                                  ▼
        │                            "Sign" → step-up auth → signed + audit event
        │                                  │
        └──────────────────────────────────┴─► Export (PDF / DOCX / text / FHIR)
```

**Critical sub-behaviours**
- Template suggestion is a *dismissible* banner, never a modal.
- Applying a template **pre-fills** the required skeleton but never overwrites text already typed (see §3.2 merge rules).
- Autosave is invisible; a status chip shows `Saved · 14:02` / `Offline — saved locally` / `Sync failed — retrying`.

### Flow B — Offline reporting (on-call)

1. App shell + template library + assigned study metadata are precached during last online session.
2. Network drops. Status chip shows **Offline**, everything remains editable.
3. Every field change lands in the encrypted local journal (< 50 ms), and in the outbox as a compact patch.
4. On reconnect: outbox flushes with idempotency keys; server returns per-patch accept/conflict.
5. Conflicts (only possible if the same report was edited on another device) are surfaced as a **field-level diff card**, not a whole-document overwrite.

**Hard rule:** signing is never possible offline. Signing requires a live server round-trip; if offline, the action is queued as *"sign request"* but the signature is only asserted after confirmed server acceptance, with the timestamp reflecting server time.

### Flow C — Draft recovery

| Failure | Recovery path |
|---|---|
| Tab crash / accidental close | On reopen, local journal replays the last 50 patches; banner: "Recovered unsaved changes from 14:31 — Review / Discard" |
| Device battery death | Same, from server-side draft revision (≤ 10 s loss) |
| Device lost / replaced | Server drafts are the record; new device restores drafts, **not** local PHI cache |
| Corrupted local DB | App detects checksum failure, quarantines the DB, re-hydrates from server, logs an incident event |
| Version skew (app updated mid-edit) | Editor refuses to load a schema it cannot write; offers read-only view + export-to-text escape hatch |

### Flow D — Validation & sign-off

```
Draft ──► Pre-sign check
            ├─ Hard errors (required empty, invalid number, unresolved placeholder)
            │     └─ cannot sign; jump-to-field links
            ├─ Warnings (IMPRESSION shorter than FINDINGS, no comparison cited,
            │            placeholder text left verbatim, laterality mismatch)
            │     └─ sign allowed with per-warning acknowledgement
            └─ Clean ──► Step-up auth (re-auth ≤ 5 min window)
                          └─► Sign → immutable revision + audit event + hash
```

### Flow E — Export

Export is a job, not a button-and-wait. The user picks a format, the server renders, the artifact appears in an **Exports** drawer with download + share-link (time-limited). Bulk export (a day's reports) runs as a background job with email/in-app completion notice.

### 2.3 Use case register

| ID | Actor | Trigger | Outcome | Primary failure mode |
|---|---|---|---|---|
| UC-01 | Radiologist | New study assigned | Report created from auto-suggested template | No template matches modality → blank + search |
| UC-02 | Radiologist | Chooses different template mid-report | Sections merged, typed text preserved | Destructive merge → blocked by confirm + diff |
| UC-03 | Radiologist | Types/dictates | Autosaved draft | Quota exceeded → oldest local revisions evicted |
| UC-04 | Radiologist | Signs report | Signed, immutable, audited | Stale template version → warning + pin notice |
| UC-05 | Radiologist | Edits a signed report | Addendum revision, original preserved | Unauthorised user → 403 + audit |
| UC-06 | Resident | Finishes draft | Submitted for co-sign | Supervisor unavailable → queue visible to all supervisors |
| UC-07 | Radiologist | Network loss mid-report | Continues offline, syncs later | Conflicting edit → field-level diff |
| UC-08 | Radiologist | Requests export | Artifact rendered and downloadable | Render failure → retry + text fallback |
| UC-09 | Admin | Edits a template | New immutable version published | In-use reports → stay pinned to old version |
| UC-10 | Admin | Retires a template | Hidden from picker, still openable by pinned reports | Accidental retire → soft-delete only |
| UC-11 | Auditor | Investigates a report | Full chronological event trail with field diffs | Missing events → hash-chain verification alarm |
| UC-12 | Radiologist | Searches own reports | Results within 300 ms (local index) | Large result set → server-side search fallback |

---

## 3. Core features and interaction details

### 3.1 Template library and selection

**Search-first, not browse-first.** A radiologist knows they want "CT abdomen" — not the taxonomy.

- Single search box matching: template name, modality, body part, section headings, author, and full text (local index over the 427 exported files).
- Facets: modality (12 values, multi-select), scope (`AlemHealth` / `Publicly Shared` / `My organisation` / `My private`), type (`FREE_TEXT` / `STRUCTURED`), body region. Facet counts are live.
- **Ranking:** modality+body-part exact match → personal usage frequency (last 90 days) → recency → scope (organisation before public) → name.
- **Variant handling:** a parent template shows as one card with a `4 variants` badge; expanding lists variants with their distinguishing free-text differences highlighted. Variants never pollute top-level search results.
- **Preview before commit:** slide-over panel rendering the full template read-only, with a section outline and "what you'll need to fill" summary (field count by type). This is cheap and prevents wrong-template churn.
- **Keyboard:** `Ctrl/Cmd+K` opens the picker; typing filters; `Enter` applies; `↑/↓` navigate; `Esc` closes. Full keyboard operation is non-negotiable — this user population lives on the keyboard.
- **Empty state:** if a study's modality has no template, show the 5 most-used templates in the organisation plus "Start blank report".

### 3.2 Report editor

**Layout: section-based document, not a form.**

```
┌─────────────────────────┬────────────────────────────────────────────┐
│ SECTION OUTLINE         │  EXAM                                      │
│ ● EXAM                  │  MR Brain [with][without] Intravenous ...  │
│ ○ CLINICAL HISTORY      │                                            │
│ ○ TECHNIQUE             │  FINDINGS                                  │
│ ○ COMPARISON            │  BRAIN:                                    │
│ ○ FINDINGS       3 ⚠    │  No restricted diffusion ...               │
│   ├ BRAIN               │  [Addendum note…]                          │
│   ├ VENTRICLES          │                                            │
│   └ ORBITS              │  IMPRESSION                                │
│ ○ IMPRESSION      ●     │  Unremarkable brain MRI.                   │
│                         │                                  Saved 14:02│
└─────────────────────────┴────────────────────────────────────────────┘
```

**Rendering rules that preserve the corpus verbatim**
1. Template body text is stored as a **structured token stream**, not a sanitised HTML blob: `[text] [field:id] [section:name]` sequences. Round-tripping back to the original text is a required, unit-tested property (`render(parse(t)) ≡ t` modulo whitespace).
2. Section headings keep their **original casing and punctuation** (`CLINICAL HISTORY:` stays uppercase with colon in FREE_TEXT; `## EXAM` stays a heading in STRUCTURED). No normalisation, no title-casing.
3. Placeholder brackets are **removed from the rendered text and replaced by the field control**, so the report reads as prose the moment it is filled. An unfilled field renders as a subtle dotted underline with the hint text dimmed, e.g. `with / without` — never as a red error until validation is requested.
4. Filling a field types the chosen text **inline into the sentence**, matching the original spacing. `[with or without]` → clicking `with` yields "MR Brain with Intravenous Contrast."
5. Untouched prose is fully editable — this is a text editor with structured islands, not a locked form. Radiologists routinely rewrite boilerplate.

**Field control mapping**

| Field type | Control | Keyboard | Notes |
|---|---|---|---|
| `enum` (2–4 options) | Inline segmented chips | `Tab` to field, `1..9` to pick, `←/→` | Selection inserts text inline |
| `enum` (> 4 options, e.g. AAST grades) | Popover listbox with descriptions | `↓` + `Enter` | Used by STRUCTURED FINDINGS |
| `number` | Inline input, `inputmode="decimal"`, unit suffix shown | Type digits | Validates range plausibility per unit |
| `text` (short) | Inline input, autocomplete from the last 5 reports for the same template+field | Type | Suggestion, never auto-insert |
| `dateOrNone` | Two-chip choice: `None` / `Prior dated…` → date picker | `N` / `D` | Very high-frequency (110 occurrences) |

**Template switching mid-report** (UC-02): merge is additive and never destructive.
- Text typed into a section that still exists → kept.
- Text typed into a section absent from the new template → appended under `ADDITIONAL` with a notice.
- Filled fields whose IDs match by semantic key → carried over.
- Unfilled prose from the old template → replaced.
- A dry-run diff card is shown before applying: `+3 sections, ~1 section removed (content preserved), 2 fields carried`.

**Dictation.** Two modes: (a) system-level dictation (OS/third-party) works because the editor is a real focusable text surface; (b) built-in push-to-talk using the Web Speech API as a low-fidelity fallback, clearly labelled as such. Server-side medical ASR can be plugged in behind the same interface. Dictated numbers are normalised (`four by three centimetres` → `4 x 3 cm`) and the user confirms the conversion inline.

**Command palette.** `Ctrl/Cmd+K` variants: apply template, insert normal-findings block, jump to section, mark section normal, sign, export. Every command is reachable without a mouse.

### 3.3 Customisable fields

Customisation happens at three levels, deliberately separated so that clinical guardrails survive local preference:

| Level | Who | What | Scope |
|---|---|---|---|
| **Template defaults** | Reporting admin | Field type, options, required flag, help text, default value | All users of that template version |
| **User field defaults** | Individual radiologist | Preferred option for a given field, e.g. always `without contrast` | That user only, applied as pre-selection (not a lock) |
| **Ad-hoc insertion** | Radiologist at report time | Add a free-text paragraph, add a custom section, add a measurement field | That report only |

User defaults are stored as `user_field_default(user_id, template_field_key, value)` and are *pre-selections* shown with a "your default" affordance so they are never invisible auto-fill of clinical content. Guardrail: a user default cannot satisfy a `required` field's sign-off check without being visibly confirmed once per report — this prevents 400 identical reports signing off with an unread pre-filled finding.

### 3.4 Required-field validation

Three tiers, each independently configurable per template version and per section:

| Tier | Definition | Behaviour | Default examples |
|---|---|---|---|
| **Hard** | Must be satisfied to sign | Blocks sign; error summary at top with jump links | `EXAM` non-empty; `IMPRESSION` non-empty when template has that section; `number` fields parseable and in plausible range |
| **Soft** | Should be satisfied | Sign allowed after one-click acknowledgement, recorded in audit | `COMPARISON` mentions a date when a prior exists; laterality chosen when template has `[left/right]` |
| **Nudge** | Quality signal | Non-blocking advisory, dismissible | IMPRESSION shorter than 15 words; "no acute" phrasing without a stated limitation; leftover placeholder hint text |

Rules, explicitly:
- Required-ness is **per template version**, because 35 templates have no IMPRESSION and 10 have no FINDINGS. A global "IMPRESSION required" rule would make those impossible to sign.
- Validation runs (1) on demand via "Review", (2) continuously in the outline as counts, never (3) as a blocking modal.
- Error messages name the field and the fix: "IMPRESSION is empty. Templates in this group usually state the main finding and a recommendation." Not "Required field missing."
- Placeholder leakage detection: any residual `[` … `]` in rendered output is a hard error — this is the single highest-value check, because it catches unfilled fields that a fast radiologist would otherwise sign.

### 3.5 Draft autosave and recovery

**Two independent persistence layers** — this is the whole point.

| Layer | Mechanism | Cadence | Survives |
|---|---|---|---|
| Local journal | Append-only patch log in encrypted IndexedDB/OPFS (WASM SQLite) | Every keystroke batch, debounced 400 ms | Tab crash, network loss, refresh |
| Server draft | `PUT /reports/{id}/draft` with patch + `base_revision` | 2 s after typing stops, 10 s hard cap, and on blur/navigate | Device loss, browser data clear |

- Autosave status is always visible but quiet: `Saving…` → `Saved 14:02` → `Offline, saved locally 14:03` → `Sync failed, retrying (3)`.
- Each save carries an `Idempotency-Key`; retries are safe.
- The local journal keeps a rolling 10-minute window of patches plus the last 20 full snapshots; older entries evicted first when storage pressure exceeds 80% of quota.
- On load, if `local_journal.head > server.revision`, show the recovery banner with a **side-by-side diff** of local vs server, not a blind "restore?" prompt.
- Explicit "Discard draft" requires typing the study accession — a deliberate friction point on a destructive action.

### 3.6 Export

| Format | Produced by | Use |
|---|---|---|
| PDF (PDF/A-3) | Server render worker (headless Chromium) | Archival, referring physician, medico-legal |
| DOCX | Server (`docx` templating, styles mapped to house style) | Editing by non-radiologists, tumour board packs |
| Plain text | Client (instant) and server | Paste into RIS/PACS, SMS/email body |
| FHIR R4 `DiagnosticReport` (JSON) | Server, with `presentedForm` pointing at the PDF | Interop with EHR |
| HL7 v2 ORU^R01 | Server, configurable segment mapping | Legacy RIS interface |
| HTML (self-contained) | Server | Web viewing without a viewer |

Export rules:
- Exports always render from a **specific revision**, never from "current draft" — a signed report's PDF is byte-stable for the same revision + template version.
- Every exported artifact stores `report_revision_id`, `template_version_id`, renderer version, and a SHA-256 of the bytes. Re-exporting a signed report years later reproduces the same document or the mismatch is reported.
- Patient identifiers in exports follow a policy toggle (`full`, `pseudonymised`, `redacted`) so the same report can go to a tumour board without identifiers.
- Artifacts are served via short-lived signed URLs (5 min), never public object-storage paths.

### 3.7 Collaboration and co-signature

- Resident signs → state `PENDING_COSIGN`, visible in a supervisor queue with age badge.
- Supervisor can (a) co-sign unchanged, (b) edit then co-sign (creates a revision attributed to the supervisor with the resident's draft preserved in history), (c) return with a comment.
- Concurrent editing: presence indicator (avatar + cursor) over WebSocket; the sync model is field-level last-write-wins **with both versions retained in the event log** and a conflict banner if two users typed into the same field within 60 s. No silent data loss, ever.
- Comments are anchored to a section and are never rendered into the exported report.

---

## 4. Screen and navigation structure

### 4.1 Information architecture

```
/                          → Study list (home)
/reports/:id               → Report workspace (editor)
/reports/:id/review        → Validation panel (also a right-rail on desktop)
/templates                 → Template library
/templates/:id             → Template detail / preview
/templates/:id/edit        → Template editor (admin)
/drafts                    → All my drafts (recovery hub)
/exports                   → Export artifacts
/audit                     → Audit search (governance/admin)
/settings                  → Profile, defaults, offline cache, accessibility
/admin                     → Org, users, roles, retention (org admin)
```

### 4.2 Desktop (≥ 1200 px) — three-column reading-room layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ≡  AlemHealth Reporting        [⌘K Search templates, reports, actions]   ◐ ⚙ │
├────────────┬───────────────────────────────────────────┬─────────────────────┤
│ STUDY LIST │  REPORT WORKSPACE                          │  CONTEXT RAIL       │
│            │                                            │                     │
│ Today (12) │  XR Chest  ·  ACC 2026-48211  ·  56F       │  Study              │
│ ▸ Chest    │  Template: XR Chest  v3   [change]         │  Accession, modality│
│ ▸ CT Abd   │  ──────────────────────────────────────    │  Clinical indication│
│ ▸ MR Brain │                                            │  Prior comparison   │
│            │  [section outline | prose editor]          │  ─────────────────  │
│ My drafts  │                                            │  Validation   2 ⚠   │
│ 3 unsaved  │                                            │  ─────────────────  │
│            │                                            │  History  12 revs   │
│ Filters    │                                            │  Export           ▾ │
│  modality  │                                            │  [ Sign report ]    │
├────────────┴───────────────────────────────────────────┴─────────────────────┤
│ Autosaved 14:02 · Online · 6 of 9 fields · 2 warnings                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

Design notes for the reading room:
- Fixed left rail (collapsible to icons, remembers per user), editor centre with max-width ~72 ch for legibility, right rail collapsible.
- **Dark theme is a first-class default** — reading rooms are dim and bright white panels cause glare. Contrast must pass AA in both themes.
- Nothing scrolls horizontally at 1024 px; the left rail auto-collapses below 1280 px.
- Sign button is anchored, never scrolled away; it is the one saturated accent colour on screen.

### 4.3 Tablet (768–1199 px)

Left rail becomes an overlay drawer (`☰`). Context rail becomes a bottom sheet with tabs: Study · Validation · History · Export. Editor takes full width with a 60 ch measure. Sign becomes a persistent bottom bar action.

### 4.4 Mobile (< 768 px) — review and quick-edit, not full authoring

```
┌───────────────────────────┐        ┌───────────────────────────┐
│ ☰   XR Chest        ⋮     │        │ ← Report                  │
├───────────────────────────┤        ├───────────────────────────┤
│ ACC 2026-48211 · 56F      │        │ ▸ EXAM                    │
│ ● Draft · saved 14:02     │        │ ▸ CLINICAL HISTORY        │
│                           │   →    │ ▸ TECHNIQUE               │
│ [ EXAM            3/3 ]   │        │ ▾ FINDINGS       3 ⚠      │
│ [ FINDINGS        9/12]   │        │   Lungs        [ normal ] │
│ [ IMPRESSION      0/1 ]   │        │   Heart        [ normal ] │
│                           │        │   Bones        [ edit  ]  │
│  ⚠ 2 issues  →            │        │                           │
│                           │        │ ┌───────────────────────┐ │
│ ┌───────────────────────┐ │        │ │ Sign report           │ │
│ │ Sign report           │ │        │ └───────────────────────┘ │
│ └───────────────────────┘ │        └───────────────────────────┘
└───────────────────────────┘
        Study card                        Section accordion
```

- Mobile is optimised for **on-call review, amendment, and sign-off of short reports** (XR, US). Long structured templates get a warning: "This template has 156 fields. Full editing is recommended on a larger screen" — advisory, not blocking.
- Accordion sections, one expanded at a time, with completion counts. Field controls become full-width but keep inline semantics.
- Bottom action bar: `Save state` + `Sign`. Sticky, 56 px tall, respects safe-area insets.
- All touch targets ≥ 44 × 44 px; no hover-only affordances; swipe actions are always duplicated by a visible button.

### 4.5 Navigation rules (both)

- One primary action per screen; destructive actions require typed confirmation.
- Browser back/forward maps to the route table above; the editor warns on unload only if the local journal has unsynced patches.
- URL is shareable and restores exact state (report id + section anchor), so a colleague can be sent a deep link.
- PWA shortcuts in the manifest: **New report**, **My drafts**, **Template library**.

### 4.6 Screen inventory

| Screen | Key elements | States to design |
|---|---|---|
| Study list | Filters, list, row metadata, bulk actions | Empty, loading (skeleton), offline-cached, error |
| Report workspace | Outline, editor, rail, status bar | New, draft, syncing, offline, conflict, signed, addendum, read-only |
| Template picker | Search, facets, cards, preview slide-over | No results, loading, offline (cached subset) |
| Template preview | Read-only render, field inventory, "Use" | Draft version, retired version |
| Template editor (admin) | Section list, field inspector, live preview, version actions | Unsaved changes, validation of template itself, publish confirm |
| Validation panel | Error/warning list, jump links, acknowledgements | All-clean, blocked, warnings-only |
| Drafts hub | Draft cards with age, study, completion | Stale (> 7 days), orphaned (study gone) |
| Exports | Job status, artifact list, share links | Queued, rendering, failed, expired link |
| Audit | Filters, event timeline, diff viewer | No results, verifying hash chain |
| Settings | Defaults, offline cache size, accessibility prefs | — |

---

## 5. Data model

### 5.1 Entity overview

```
organization ─┬─ user ─┬─ user_role
              │        └─ user_field_default
              ├─ template ◄── imported_from (source_guid, source_system)
              │     └─ template_version ─┬─ template_section
              │                           └─ template_field ─ template_field_option
              └─ study ── report ─┬─ report_revision ─┬─ report_section_content
                                  │                   └─ report_field_value
                                  ├─ draft (mutable head)
                                  ├─ report_comment
                                  ├─ export_job ─ export_artifact
                                  └─ audit_event
device ─ local_journal (client-only, encrypted)
```

Key principle: **templates and reports are versioned immutably; the mutable "current draft" is a thin head pointer over an append-only revision history.**

### 5.2 Templates

```sql
CREATE TABLE template (
  id                 uuid PRIMARY KEY,
  organization_id    uuid NULL,              -- NULL = global/public library
  name               text NOT NULL,          -- verbatim site display name
  modality           text NOT NULL,          -- XR|CT|MR|US|DX|NM|CTA|RF|MRA|PT|MRV
  body_region        text,
  template_type      text NOT NULL,          -- FREE_TEXT | STRUCTURED
  variant_group_id   uuid NULL,              -- groups parent + variants
  variant_label      text,                   -- e.g. "(2)", human label from source
  scope              text NOT NULL,          -- alemhealth | public | organisation | private
  author_display     text,                   -- 'RSNA' | named user | NULL
  license            text,                   -- SPDX-ish or free text; NULL = unknown
  source_system      text,                   -- 'alembhealth-connect'
  source_guid        text,                   -- original template GUID (traceability)
  lifecycle          text NOT NULL,          -- draft|published|deprecated|retired
  current_version_id uuid,
  created_at         timestamptz NOT NULL,
  UNIQUE (organization_id, source_guid)
);

CREATE TABLE template_version (
  id             uuid PRIMARY KEY,
  template_id    uuid NOT NULL REFERENCES template(id),
  version_no     integer NOT NULL,           -- 1..n, monotonic per template
  semantic_label text,                       -- 'v3', admin-editable, not parsed
  body_tokens    jsonb NOT NULL,             -- token stream (see 5.3)
  body_plain     text NOT NULL,              -- canonical plain text, for search + diff
  content_hash   text NOT NULL,              -- sha256(body_plain) — drift detection
  created_by     uuid REFERENCES "user"(id),
  created_at     timestamptz NOT NULL,
  published_at   timestamptz,
  change_note    text,
  UNIQUE (template_id, version_no)
);

CREATE TABLE template_section (
  id                  uuid PRIMARY KEY,
  template_version_id uuid NOT NULL REFERENCES template_version(id),
  ordinal             integer NOT NULL,
  heading             text NOT NULL,         -- verbatim casing/punctuation
  render_level        smallint NOT NULL,     -- 1 = '## X', 2 = 'X:', 3 = 'X:' inside FINDINGS
  requiredness        text NOT NULL,         -- hard | soft | nudge | none
  help_text           text,
  UNIQUE (template_version_id, ordinal)
);

CREATE TABLE template_field (
  id                  uuid PRIMARY KEY,
  template_version_id uuid NOT NULL REFERENCES template_version(id),
  section_id          uuid REFERENCES template_section(id),
  field_key           text NOT NULL,         -- stable semantic key, e.g. 'contrast_mode'
  ordinal             integer NOT NULL,
  raw_placeholder     text NOT NULL,         -- verbatim 'with or without'
  label               text NOT NULL,         -- display label
  field_type          text NOT NULL,         -- enum|number|text|dateOrNone|multislot
  unit                text,                  -- mm|cm|%|HU|ml|degrees
  slot_count          smallint DEFAULT 1,    -- for '[__ x __ x __ cm]'
  requiredness        text NOT NULL DEFAULT 'none',
  default_value       jsonb,
  constraints         jsonb,                 -- {"min":0,"max":400,"step":0.1}
  UNIQUE (template_version_id, field_key)
);

CREATE TABLE template_field_option (
  id               uuid PRIMARY KEY,
  template_field_id uuid NOT NULL REFERENCES template_field(id),
  ordinal          smallint NOT NULL,
  value            text NOT NULL,            -- verbatim 'with'
  insert_text      text NOT NULL,            -- text inserted into the sentence
  description      text                      -- for STRUCTURED pick-lists
);
```

### 5.3 Token stream (the round-trip contract)

```json
{
  "type": "template_version",
  "id": "tv_01H...",
  "template_id": "tpl_mr_brain",
  "version_no": 1,
  "tokens": [
    {"t":"heading","level":1,"text":"EXAM"},
    {"t":"text","text":"MR Brain "},
    {"t":"field","field_key":"contrast_mode","placeholder":"with or without","type":"enum"},
    {"t":"text","text":" Intravenous Contrast.\n\n"},
    {"t":"heading","level":1,"text":"CLINICAL HISTORY"},
    {"t":"text","text":"\n"},
    {"t":"heading","level":1,"text":"TECHNIQUE"},
    {"t":"text","text":"Magnetic resonance images of the brain "},
    {"t":"field","field_key":"contrast_mode_2","placeholder":"with or without","type":"enum"},
    {"t":"text","text":" intravenous contrast in multiple planes.\n\n"},
    {"t":"heading","level":1,"text":"FINDINGS"},
    {"t":"text","text":"BRAIN:\nNo restricted diffusion to indicate acute infarction. ...\n\n"},
    {"t":"heading","level":1,"text":"IMPRESSION"},
    {"t":"text","text":"\nUnremarkable brain MRI.\n"}
  ]
}
```

Rules: tokens are the only editable representation; `body_plain` is derived and used for search/diff; `content_hash` lets the importer detect that a re-import from connect.alem.health has changed content for the same `source_guid`.

**Structured-family variant**: FINDINGS options become one `enum` field with N options carrying `description`, so selecting the grade inserts that option's full sentence — preserving the exact AAST wording while capturing a discrete code.

### 5.4 Reports, revisions, field values

```sql
CREATE TABLE study (
  id             uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  accession      text NOT NULL,
  modality       text,
  body_part      text,
  study_date     timestamptz,
  patient_ref    text NOT NULL,              -- pseudonymous key; demographics in EHR only
  indication     text,
  UNIQUE (organization_id, accession)
);

CREATE TABLE report (
  id                   uuid PRIMARY KEY,
  study_id             uuid NOT NULL REFERENCES study(id),
  author_id            uuid NOT NULL REFERENCES "user"(id),
  template_id          uuid REFERENCES template(id),
  template_version_id  uuid REFERENCES template_version(id),   -- pinned forever
  state                text NOT NULL,        -- draft|in_review|pending_cosign|signed|amended|withdrawn
  head_revision_id     uuid,
  signed_at            timestamptz,
  signed_by            uuid REFERENCES "user"(id),
  cosign_required      boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL
);

CREATE TABLE report_revision (
  id                  uuid PRIMARY KEY,
  report_id           uuid NOT NULL REFERENCES report(id),
  revision_no         integer NOT NULL,
  parent_revision_id  uuid REFERENCES report_revision(id),
  author_id           uuid NOT NULL,
  kind                text NOT NULL,         -- autosave|manual|sign|amend|cosign|admin_repair
  body_plain          text NOT NULL,         -- snapshot at this revision
  content_hash        text NOT NULL,
  template_version_id uuid,                  -- pinned (may differ after template change)
  created_at          timestamptz NOT NULL,
  UNIQUE (report_id, revision_no)
);

CREATE TABLE report_field_value (
  report_revision_id uuid NOT NULL REFERENCES report_revision(id),
  field_key          text NOT NULL,
  value_json         jsonb NOT NULL,         -- {"choice":"with"} | {"number":1.4,"unit":"cm"} | {"text":"..."}
  rendered_text      text,                   -- exactly what appears in the document
  PRIMARY KEY (report_revision_id, field_key)
);

CREATE TABLE report_section_content (
  report_revision_id uuid NOT NULL REFERENCES report_revision(id),
  section_id         uuid NOT NULL,          -- template_section.id at that version
  heading            text NOT NULL,
  content_plain      text NOT NULL,
  content_format     text NOT NULL DEFAULT 'plain',
  PRIMARY KEY (report_revision_id, section_id)
);
```

`report_field_value` exists alongside prose content deliberately: the prose is the medico-legal record, the field values are the **structured dataset** for registries, QA, decision support and analytics. Population of the latter must never alter the former.

### 5.5 Users, roles, drafts, exports, audit

```sql
CREATE TABLE "user" (
  id             uuid PRIMARY KEY,
  email          text UNIQUE NOT NULL,
  display_name   text NOT NULL,
  credential     text,                       -- 'MD' | 'FRCR' etc. display only
  license_no     text,                       -- encrypted at rest
  mfa_enrolled   boolean NOT NULL DEFAULT false,
  locale         text DEFAULT 'en',
  timezone       text,
  status         text NOT NULL DEFAULT 'active'   -- active|suspended|departed
);

CREATE TABLE user_role (
  user_id uuid NOT NULL REFERENCES "user"(id),
  role    text NOT NULL,      -- radiologist|resident|cosigner|template_admin|org_admin|auditor|integration
  organization_id uuid NOT NULL,
  scope_filter jsonb,         -- {"modalities":["CT","MR"],"sites":["..."]}
  PRIMARY KEY (user_id, role, organization_id)
);

CREATE TABLE draft (                        -- server-side mutable head
  report_id        uuid PRIMARY KEY REFERENCES report(id),
  base_revision_id uuid NOT NULL,
  patch            jsonb NOT NULL,          -- accumulated ops since base
  last_patch_seq   bigint NOT NULL,
  device_id        uuid,
  client_mtime     timestamptz NOT NULL,    -- for skew detection
  server_mtime     timestamptz NOT NULL,
  autosaved_at     timestamptz NOT NULL
);

CREATE TABLE export_job (
  id             uuid PRIMARY KEY,
  report_id      uuid NOT NULL,
  revision_id    uuid NOT NULL REFERENCES report_revision(id),
  format         text NOT NULL,             -- pdf|docx|txt|fhir|hl7|html
  options        jsonb,                     -- {"identifiers":"pseudonymised","paper":"A4"}
  status         text NOT NULL,             -- queued|rendering|ready|failed|expired
  requested_by   uuid NOT NULL,
  requested_at   timestamptz NOT NULL,
  error_code     text
);

CREATE TABLE export_artifact (
  id             uuid PRIMARY KEY,
  export_job_id  uuid NOT NULL REFERENCES export_job(id),
  object_key     text NOT NULL,
  byte_size      bigint NOT NULL,
  sha256         text NOT NULL,
  renderer_version text NOT NULL,
  expires_at     timestamptz
);

CREATE TABLE audit_event (                  -- append-only, no UPDATE/DELETE grants
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL,
  actor_id       uuid,
  actor_ip_hash  text,                      -- hashed, not raw
  action         text NOT NULL,             -- report.sign, template.publish, export.download, ...
  subject_type   text NOT NULL,
  subject_id     uuid NOT NULL,
  before_hash    text,
  after_hash     text,
  diff           jsonb,                     -- field-level, PHI-aware redaction applied
  request_id     text,
  prev_event_hash text NOT NULL,            -- hash chain
  event_hash     text NOT NULL
);
```

### 5.6 Client-side store

| Store | Contents | Encryption | Eviction |
|---|---|---|---|
| `app-shell` (Cache API) | HTML/JS/CSS/fonts/icons, renderer assets | n/a (no PHI) | on version change |
| `templates` (IndexedDB) | Published template versions + token streams | n/a (no PHI) | LRU beyond 400 versions |
| `studies` (IndexedDB) | Whitelisted study metadata for offline queue | AES-GCM, key in WebCrypto non-extractable | on sign/24 h |
| `journal` (OPFS + SQLite WASM) | Patch log, snapshots, outbox | SQLCipher or app-level AES-GCM | rolling 10 min + 20 snapshots |
| `exports-local` | Client-generated plain text only | ephemeral | on logout |

**Never cached:** any `/reports`, `/patients`, `/exports` HTTP response via the Service Worker. PHI reaches the client only through authenticated `fetch` written directly into the encrypted local store. This prevents the classic PWA leak where PHI sits in a plaintext HTTP cache readable by any script or forensic tool.

---

## 6. Technical architecture

### 6.1 Stack

| Layer | Choice | Why |
|---|---|---|
| App shell | React 19 + TypeScript, Vite, Workbox-generated Service Worker | Mature SSR-free PWA tooling, tree-shaken bundles |
| Editor core | ProseMirror (or Lexical) with a custom schema for `field` and `heading` nodes | Real text editing with structured islands, undo/redo, IME, accessible text semantics |
| Local store | IndexedDB (Dexie) + OPFS-backed SQLite WASM for the journal | Transactional patches, no size cliff |
| Crypto | WebCrypto AES-GCM 256, non-extractable keys, key wrapped by device-bound secret | PHI at rest on device |
| API | Node/TypeScript (Fastify) or Go, REST + JSON Patch, OpenAPI 3.1 generated clients | Simple, cacheable, testable |
| Realtime | WebSocket (per-report room) for presence + patch fan-out | Co-sign and conflict detection |
| DB | PostgreSQL 16 with `jsonb` for tokens/patches; row-level security | Single store for relational + document shapes |
| Object storage | S3-compatible with SSE-KMS, versioning on | Export artifacts, attachments |
| Export workers | Queue (SQS/Redis) → headless Chromium for PDF, `docx` templating for DOCX | Deterministic rendering, retryable |
| Search | Postgres full-text for v1; OpenSearch when report volume > ~500k | Local index first — most search is local anyway |
| Observability | OpenTelemetry traces/metrics/logs; **no PHI in telemetry** | Forensics without privacy debt |

### 6.2 Deployment view

```
                    ┌──────────────┐
   Browser (PWA) ──►│  CDN / Edge  │  static shell, immutable, no PHI
        │           └──────────────┘
        │  HTTPS (TLS 1.3), HSTS, mTLS optional for managed devices
        ▼
   ┌─────────────┐     ┌──────────────┐     ┌────────────────┐
   │ API Gateway │────►│  App service │────►│  PostgreSQL    │
   │ (WAF, rate) │     │  (stateless) │     │  (RLS, KMS)    │
   └─────────────┘     └──────┬───────┘     └────────────────┘
        │                     │
        │                     ├──► Redis (presence, sessions, idempotency)
        │                     ├──► Queue ──► Export workers ──► Object store (SSE-KMS)
        │                     └──► Audit log sink (append-only, WORM bucket)
        ▼
   Identity Provider (OIDC, MFA, step-up)   EHR/RIS (HL7/FHIR)   PACS (DICOMweb, later)
```

### 6.3 PWA capabilities

```json
{
  "name": "AlemHealth Reporting",
  "short_name": "Reporting",
  "start_url": "/?source=pwa",
  "display": "standalone",
  "display_override": ["window-controls-overlay", "standalone"],
  "background_color": "#0e1116",
  "theme_color": "#0e1116",
  "orientation": "any",
  "categories": ["medical", "productivity"],
  "shortcuts": [
    {"name": "New report", "url": "/reports/new"},
    {"name": "My drafts", "url": "/drafts"},
    {"name": "Templates", "url": "/templates"}
  ],
  "file_handlers": [],
  "share_target": null,
  "launch_handler": {"client_mode": "focus-existing"}
}
```

| Capability | Used for | Notes |
|---|---|---|
| Service Worker | App shell precache, navigation fallback, background sync | **Network-only for all PHI routes** |
| Web App Manifest | Install, shortcuts, theme | Installable on Windows/macOS desktop and Android |
| Background Sync / Periodic Sync | Outbox flush after reconnect | Periodic Sync is not universally supported — treat as progressive enhancement, never a dependency |
| File System Access API | Save export locally / open attachment | Chromium-only; always offer download fallback |
| Web Share | Share text export | Mobile only |
| Push (optional) | Co-sign requests, export ready | Requires Web Push endpoint; not used for PHI content, only "you have a task" |
| Storage Manager | Request persistent storage, surface quota | Must warn before quota exhaustion |
| Web Speech API | Fallback dictation | Labelled low-fidelity; not for primary use |

**Explicit non-goals:** no `Cache.put()` of API responses; no PHI in `localStorage`, `sessionStorage`, or IndexedDB unencrypted; no `importScripts` of remote code; no dynamic `eval`.

### 6.4 Offline behaviour matrix

| Feature | Online | Offline |
|---|---|---|
| Open assigned study (precached) | Yes | Yes |
| Create/edit report | Yes | Yes |
| Browse/apply templates | Yes (full) | Yes — cached published set |
| Autosave | Server + local | Local only, queued |
| Validate | Yes | Yes (rules are client-side, deterministic) |
| Sign | Yes | **No** — queued as intent, blocked with clear message |
| Export PDF/DOCX | Yes | No (plain text only, generated locally) |
| Search reports | Full | Local subset |
| Template admin | Yes | Read-only |
| Co-sign | Yes | No |

Offline read scope is deliberately **whitelisted**: only studies explicitly assigned to the user and pre-cached (or opened in the last 24 h) are available offline. This is a least-privilege decision — a lost laptop must not contain the department's worklist.

### 6.5 Synchronisation model

**Client-authoritative for text, server-authoritative for history.**

```
Client                                         Server
  keystroke ─► local journal (patch p_n)
           ─► debounce 2s ─► POST /reports/:id/patches
                             {base_revision, seq, patch, idempotency_key}
                                        │
                              ┌─────────┴─────────┐
                        base == head          base < head
                              │                    │
                     apply, new revision     three-way merge per field
                     return {revision}          │
                                          ┌─────┴──────┐
                                     clean merge    conflict
                                          │             │
                                    new revision   return 409 + both sides
                                                        │
                                              client shows field-level diff
```

- Patches are **operations on the token stream** (`insert_text`, `replace_range`, `set_field`, `add_section`), not whole-document writes. This makes merge tractable and payloads small (a keystroke batch is typically < 400 bytes).
- `base_revision` mismatch triggers a server-side three-way merge: `merge(base, server_head, client_patch)` at field/section granularity. If any region conflicts, the server returns the conflict set and does **not** guess.
- Conflict resolution UI: side-by-side for the conflicting field only, `Keep mine` / `Keep theirs` / `Edit` — never a whole-report overwrite.
- Clock skew: server stamps all times; client times are advisory only. If `|client_mtime − server_mtime| > 5 min`, the client is told its clock is off (a real cause of confusing "unsaved" states on hospital VMs).
- Sync state machine per report: `LOCAL_ONLY → SYNCING → SYNCED → DIRTY → CONFLICT → FAILED(retryable) → FAILED(blocking)`.

### 6.6 Authentication

- **OIDC Authorization Code + PKCE**, no implicit flow, no password storage in-app.
- Access token lifetime 10 min, refresh 8 h; refresh rotation with reuse detection (a reused refresh token kills the session family).
- **MFA required** for all clinical roles; hardware key (WebAuthn) preferred, TOTP acceptable.
- **Step-up authentication** for signing: re-auth within a 5-minute freshness window, satisfied by WebAuthn assertion (biometric/PIN) or IdP re-prompt. Signing is bound to the step-up event ID in the audit record.
- Session idle timeout 15 min (configurable per org), absolute 12 h; logout clears local PHI stores synchronously before navigation.
- Managed-device context (optional): device certificate via mTLS for hospital-issued laptops; personal devices get reduced offline scope.

### 6.7 Authorization

**RBAC for capability, ABAC for data scope.** Both enforced server-side; the client's UI restrictions are cosmetics only.

| Role | Capabilities |
|---|---|
| `radiologist` | Create/edit own drafts, sign, amend own signed reports, export, search own + assigned |
| `resident` | As radiologist, but sign produces `PENDING_COSIGN` |
| `cosigner` | Sign/cosign reports in assigned scope, return with comments |
| `template_admin` | CRUD templates, publish/deprecate versions; **cannot** read patient reports |
| `org_admin` | Users, roles, retention, template policy; no clinical content by default |
| `auditor` | Read-only audit search + report read with a logged justification |
| `integration` | Machine-to-machine, scoped to specific endpoints, no UI |

ABAC attributes: `organization_id`, `site`, `modality`, `subspecialty`, `assignment (study assigned to user)`, `report_state`. Policy expressed as OPA/Rego or Postgres RLS predicates:

```sql
-- row-level security example
CREATE POLICY report_read ON report FOR SELECT USING (
  organization_id = current_setting('app.org_id')::uuid
  AND (
    current_setting('app.roles') LIKE '%org_admin%'
    OR author_id = current_setting('app.user_id')::uuid
    OR EXISTS (SELECT 1 FROM report_assignment ra
               WHERE ra.report_id = report.id
                 AND ra.user_id = current_setting('app.user_id')::uuid)
  )
);
```

Two additional rules worth stating explicitly:
- **Break-glass access** exists for emergencies: it grants temporary read, requires a free-text reason, notifies the org admin and the data subject's care team, and is permanently flagged in audit.
- **Segregation of duties:** a user cannot both author and co-sign the same report; a `template_admin` cannot alter a template version pinned to a signed report.

### 6.8 Security and PHI handling

| Concern | Control |
|---|---|
| Transport | TLS 1.3 (1.2 minimum), HSTS preload, certificate pinning not required but recommended for managed devices |
| At rest (server) | Postgres TDE/KMS envelope encryption; object store SSE-KMS; encrypted backups with separate key |
| At rest (client) | AES-GCM 256 via WebCrypto; key material never persisted in plaintext; wrapped key bound to device secret; wiped on logout/idle |
| XSS | Strict CSP (`script-src 'self' 'nonce-…'`), no `unsafe-inline`, Trusted Types enforced, DOMPurify on any imported HTML |
| CSRF | SameSite=Strict cookies for session, CSRF token for state-changing requests, or bearer-only API |
| Injection | Parameterised queries, RLS, no string-built SQL; template content is data, never executed |
| Template content | Imported HTML sanitised to an allowlist at import time and re-sanitised at render; token stream is the storage format precisely so HTML is not reintroduced |
| Prompt injection via template text | Template bodies and dictation are untrusted input. Any LLM assist (field labelling, summarisation) runs with no tool access, output is advisory, and never auto-applies to a report |
| Authorisation bypass | Every endpoint re-checks scope; no "trusted client" paths; IDOR tests in CI |
| Secrets | No secrets in the bundle; runtime config endpoint; rotation via KMS |
| Dependency risk | SCA in CI, lockfiles, signed builds, SBOM per release |
| Logging | PHI-redacting logger; patient_ref and report_id only; IP hashed with a rotating salt |
| Retention | Configurable per org; signed reports typically 7–10 years or local statutory minimum; local cache TTL always shorter than server |
| Backup/DR | PITR, cross-region replica, quarterly restore drill including an "export a 3-year-old signed report byte-identically" test |
| Threat model | STRIDE documented; specific attention to stolen laptop (local PHI), shared workstation (session bleed), and malicious insider (break-glass abuse) |

**Data minimisation due to the source system.** The AlemHealth export includes raw identity-provider subject IDs in the author field and internal template GUIDs. These are internal identifiers, not clinical data, but they must not be carried into the new system: map `source_guid` (needed for traceability and drift detection) but drop author subject IDs, replacing them with resolved display names or `null`.

### 6.9 Accessibility

Target: **WCAG 2.2 AA**, with the following radiology-specific additions.

| Area | Requirement |
|---|---|
| Keyboard | 100% of functionality operable by keyboard. Documented key map. Visible focus ring ≥ 2 px with 3:1 contrast against both themes |
| Reading-room context | Dark theme default; glare-safe palette; no pure-white surfaces; both themes independently audited for AA |
| Text scaling | Layout remains usable at 200% zoom and 400% via reflow (single column); user-adjustable editor font size 12–24 px persisted per user |
| Voice/dictation | Dictation is an input method, not an accessibility afterthought, but every dictation action has a keyboard equivalent |
| Screen readers | Editor exposes a text-editor role with proper `aria-multiline`, live regions announce autosave and validation counts politely (`aria-live="polite"`), errors announced assertively once |
| Forms | Every field has a programmatic label derived from its sentence context; `aria-describedby` for help text; units announced (`"1.4 centimetres"`) |
| Errors | Error summary at top with links to each field; inline messages tied via `aria-describedby`; never colour-only |
| Targets | 44 × 44 px minimum, 8 px spacing between adjacent targets |
| Motion | `prefers-reduced-motion` honoured; no transitions on the editor cursor/status |
| Timing | No time limits on editing. Session timeout warns 2 min before with a "stay signed in" action that does not lose content |
| Testing | Automated axe-core in CI (zero critical), plus manual screen-reader passes (NVDA + VoiceOver) and a moderated study with assistive-tech users |

### 6.10 Performance budgets

| Metric | Budget |
|---|---|
| First Contentful Paint (cold, 4G) | < 1.8 s |
| Time to Interactive on report editor | < 2.5 s |
| Route chunk (per screen) | < 180 KB gzip |
| Keystroke → paint in editor | < 50 ms p95 (large 4,852-char report) |
| Local journal write | < 20 ms p95 |
| Template search (local, 427 items) | < 30 ms |
| Autosave round-trip | < 400 ms p95 |
| Editor memory (largest template) | < 120 MB |

### 6.11 Scalability

- **Stateless app tier** behind a load balancer; all state in Postgres/Redis/object store. Horizontal scale is linear to DB capacity.
- **Template reads are the hottest path and are immutable** → cache aggressively: CDN for published template versions keyed by `template_version_id + content_hash`, ETag-based revalidation, 1 h TTL, purge on publish. Template edits never invalidate a report's rendering.
- **Report writes are partitioned by organization** (hash or schema-per-tenant for the largest customers). At 10k reports/day with ~6 patches each, the write load is ~0.7 patches/s average — trivially handled; bursts (morning read-out) are the real shape, so queue depth and connection pooling matter more than raw throughput.
- **Realtime rooms** are per-report and short-lived; cap concurrent sockets per node (e.g. 10k) and scale horizontally with a Redis pub/sub fan-out.
- **Export workers scale independently** — export is bursty (end-of-day batches) and CPU-heavy; keep it off the request path entirely.
- **Storage growth:** PDF ~150–400 KB per report; at 10k/day that is ~1–4 GB/day, ~1.4 TB/year. Lifecycle to infrequent-access after 90 days, Glacier-class after 2 years. Audit events are small but high-volume — partition monthly, retain hot 12 months.
- **Search:** local index handles personal search indefinitely; server search moves to OpenSearch at ~500k reports with per-org indices.
- **Multi-tenancy:** every table carries `organization_id`; RLS enforces isolation; a single deployment serves many hospitals without code forks.
- **Cost lever:** the PWA's offline behaviour means most reads happen once and are then local — server read load scales with *new* studies, not with clinician screen time.

---

## 7. Recommendations — template versioning

1. **Immutable versions, mutable pointers.** Editing a template never mutates a version; it creates `version_no + 1`. `template.current_version_id` moves. Reports reference `template_version_id` forever.
2. **Content hash as the real version identity.** `sha256(body_plain)` is the canonical fingerprint. Two admins publishing the same text produce the same hash and no new version. This also detects drift when re-importing from connect.alem.health: same `source_guid`, different hash → a review task is created, not a silent overwrite.
3. **Stable field keys across versions.** Field identity is `field_key` (semantic, e.g. `contrast_mode`), not ordinal. When a field is removed from version N+1, it is *retired*, not deleted, so old reports still resolve it. When renamed, a `rename_map` carries the value forward.
4. **Lifecycle states** `draft → published → deprecated → retired`, with rules:
   - `deprecated`: still usable for new reports, shows a notice, admin sees it on a cleanup dashboard.
   - `retired`: hidden from the picker, still fully renderable for pinned reports. **Never hard-delete.**
5. **Diff before publish.** A version diff view at section and field level: `+1 section`, `-2 fields`, `changed: requiredness of IMPRESSION (soft→hard)`. Publishing with a requiredness increase shows an estimate: "37 open drafts use this template; 4 will gain a new hard error."
6. **Report-level drift warning.** If a template has a newer published version than the one a report is pinned to, the editor shows: "This report uses XR Chest v3. v4 is published (added: IMPRESSION guidance). Reports stay on v3; change template?" — never silent migration.
7. **Import provenance.** Every imported template keeps `source_system`, `source_guid`, `author_display`, `license`, `imported_at`, and the raw original text. Re-import is a diff-and-review workflow, not a bulk replace.
8. **Semantic labels are cosmetic.** `semantic_label` (`v3`, `2026-11 release`) is editable text; ordering is by `version_no`. Do not parse version strings.

## 8. Recommendations — audit trails

1. **Append-only, hash-chained.** Each `audit_event` embeds `prev_event_hash`; a nightly job verifies the chain and alarms on breaks. Revoke `UPDATE`/`DELETE` grants from the application role; write via a dedicated sink to a WORM bucket.
2. **Log the clinical verbs, not just HTTP verbs.** Required actions: `report.create`, `report.patch`, `report.sign`, `report.cosign`, `report.amend`, `report.withdraw`, `report.view` (read access to PHI is itself auditable), `report.export`, `export.download`, `template.publish`, `template.retire`, `user.role_change`, `access.break_glass`, `sync.conflict`, `local.recover`.
3. **Field-level diffs, not whole documents.** Store `{field_key, before, after}` triples plus a content hash. This keeps the trail small and makes "who changed the impression" answerable in one query.
4. **Separate the clinical record from the audit record.** The report revision is the clinical truth; the audit event is the accountability truth. Never derive one from the other.
5. **Correlated identifiers.** Every event carries `request_id` and, where relevant, `step_up_auth_id`, `device_id`, `session_id` — so an incident review can reconstruct the exact chain without reading PHI.
6. **PHI-aware redaction in the trail.** Diffs are stored with a configurable redaction policy: for `auditor` views, patient names are masked; the raw diff remains available only to a compliance role with its own audit entry.
7. **Retention and immutability.** Audit retention ≥ report retention (typically 10 years or statutory minimum). Export to a signed archive at end of life rather than deletion.
8. **Verification UX.** The audit search screen shows a chain-verification status banner (`verified through 2026-10-27 23:59`) so governance can see integrity at a glance rather than taking it on trust.

## 9. Recommendations — error handling

**Principle: never lose the clinician's text, always tell them what state it is in.**

| Failure class | Detection | User-facing behaviour | Engineering behaviour |
|---|---|---|---|
| Network loss | `navigator.onLine`, fetch failure, WS close | Status chip `Offline — saved locally`; no modal | Queue patches; exponential backoff 1→30 s with jitter; resume on `online` |
| Autosave conflict (409) | `base_revision` mismatch | Field-level diff card, both versions visible | Server returns conflict set; never auto-resolves |
| Validation block | Client rule engine | Error summary with jump links, sign disabled with reason | Deterministic; same rules run server-side before sign |
| Export failure | Worker error / timeout | "Export failed — retry" + "get plain text" fallback | 3 retries with backoff, then DLQ + alert; artifact marked `failed` with `error_code` |
| Template retired/pinned mismatch | Version lookup | Notice + "read-only, export available" | Report remains renderable via stored token stream (no dependency on live template) |
| Local storage full | `QuotaExceededError` | Banner: "Local storage full — sync now or free space"; sign still allowed if online | Evict oldest journal entries first; never evict unsynced outbox |
| Corrupt local DB | Hash/integrity check on open | "Recovered from server" banner | Quarantine DB, re-hydrate, log `local.recover` |
| Clock skew > 5 min | Server vs client time | Subtle notice in settings | All timestamps server-authoritative |
| Session expiry mid-edit | 401 on save | "Signed out — your work is saved locally. Sign in to continue" | Refresh-token rotation; local journal intact; resume at same caret |
| Step-up auth failure | WebAuthn assertion failure | "Could not verify — try again or use another method" | No sign; 5 attempts then re-login |
| Render mismatch on re-export | `sha256` differs from stored | Warning in export drawer | Investigate renderer version change; do not silently replace |
| 5xx / upstream | Status code | "Service problem — retrying" | Circuit breaker, DLQ, no data loss |

Error taxonomy for the client: `Retryable` (transient, auto-retry), `Blocking` (needs user decision), `Fatal` (needs reload/support). Every error surface includes: what happened, what was preserved, and the single next action.

## 10. Recommendations — usability testing

### 10.1 Study design

| Wave | Participants | Focus | Method |
|---|---|---|---|
| W1 — formative | 8–10 radiologists (mixed seniority, 3 sites) + 2 residents | Template selection, editing, validation comprehension | Moderated think-aloud, in the reading room, 45 min |
| W2 — offline | 6 on-call radiologists | Offline flow, draft recovery, reconnect | Simulated network throttling/airplane mode; task-based |
| W3 — accessibility | 5 participants incl. 2 screen-reader users, 1 with motor impairment | Full task completion with AT | Moderated, NVDA/VoiceOver, keyboard-only |
| W4 — summative | 30+ radiologists | Benchmark against current workflow | Unmoderated + instrumented, A/B against legacy tool |

### 10.2 Task script (W1 core, ~6 tasks)

1. "A chest X-ray is on your list. Produce and sign a report." → measure time-to-sign, template-pick time, keystrokes.
2. "The template offered is wrong. Switch to *CT Abdomen* without losing what you typed."
3. "You need a prior study date in COMPARISON. Where does it go?" → placeholder discoverability.
4. "You have an unsigned report with a warning. What does the app want from you?" → validation comprehension.
5. "Your Wi-Fi drops mid-report. Finish it." → offline affordance.
6. "Export this signed report as a PDF for the referring physician."

### 10.3 Metrics

| Metric | Target |
|---|---|
| Time to sign, simple XR report (median) | ≤ 90 s, and ≤ legacy tool |
| Template-pick accuracy (right template first try) | ≥ 95% |
| Task success without assistance | ≥ 90% |
| Validation error comprehension ("what do I fix?") | ≥ 95% |
| Offline task success | 100% (no data loss tolerated) |
| Placeholder-leakage rate in signed reports | 0 (measured in production too) |
| System Usability Scale | ≥ 80 |
| NASA-TLX mental demand | ≤ legacy tool |
| Screen-reader task completion | ≥ 90% |

### 10.4 Instrumentation to build before testing

- Time-to-first-keystroke, time-to-sign, template-pick latency, template-change count per report.
- Validation: blocks encountered, warnings dismissed without reading (dwell < 1 s), overrides.
- Recovery events: journal replays, conflicts, resyncs.
- Accessibility: keyboard-only session share, focus-trap escapes.
- All telemetry PHI-free by construction (IDs and timings only).

### 10.5 Specific hypotheses worth testing (from the corpus)

- **H1:** Inline chips are faster than a side-panel form for 2–3-option placeholders (`[with or without]`, 103 occurrences) — because the sentence stays readable.
- **H2:** A 156-field template is unusable as a flat form and must be section-collapsed; test whether section completion counts improve completion.
- **H3:** Radiologists will edit boilerplate prose even in STRUCTURED templates; if they do, the "STRUCTURED == locked form" assumption is wrong and the pick-list must coexist with free text.
- **H4:** Showing a drift notice ("v4 published") does not distract; measure dismissal rate.
- **H5:** Variant grouping (126 variant files → 27 groups) reduces wrong-template picks versus flat listing.

## 11. Risks and open questions

| # | Risk / question | Impact | Recommendation |
|---|---|---|---|
| R1 | **Licensing of the template corpus.** 130 templates are authored by RSNA, 127 by other platform users, 168 have no author. Redistribution inside a product may require permission. | Legal blocker for launch | Obtain written rights clearance or restrict the initial library to org-authored templates; store `license` per template; ship with an attribution screen |
| R2 | Template fidelity after parsing | Clinical wording errors are serious | Enforce the `render(parse(t)) ≡ t` round-trip property test on all 427 files in CI; diff every import |
| R3 | Placeholder detection misclassifies 1,111 distinct strings | Wrong control for a field | Human review queue for all fields flagged low-confidence; the 20 highest-frequency placeholders cover most usage, review those first |
| R4 | Offline PHI on shared workstations | Privacy incident | Disable offline on non-managed devices via policy; wipe on idle; short local TTL |
| R5 | 2 Inactive templates in the source | Confusing library | Import but keep in `deprecated`; never publish silently |
| R6 | Auth0 subject IDs leaked in source export | Minor privacy / hygiene | Map to display names; drop raw IDs; note in the data-handling record |
| R7 | Regulatory classification (medical device / clinical software) | May constrain features like auto-suggested findings | Confirm with regulatory affairs before shipping decision-support features; the editor itself is documentation, not diagnosis |
| R8 | Retention law in the operating jurisdiction | Compliance | Define with legal; make it configuration, not code |
| R9 | Duplicate/near-duplicate templates (301 distinct from 427 files, many similar names) | Picker noise | Add a "duplicate candidate" detector on `content_hash` similarity and let admins merge |
| R10 | Dictation accuracy for numbers/units | Wrong measurements | Require explicit confirmation of normalised numbers; never auto-commit |

## 12. Appendix

### A. Import pipeline for the 427 files

```
427 .md files ──► parser
   ├─ header block (Template Name, Scope, Modality, Type, Author, Status, GUID) → template metadata
   ├─ classify: '## ' headings present → STRUCTURED, else FREE_TEXT
   ├─ split sections by heading form ('## X' | 'X:' at col 0 | 'X:' inside FINDINGS)
   ├─ extract bracket tokens → template_field (+ options via '/')
   ├─ assign field_key: slug(section) + '_' + slug(hint) + ordinal-disambiguator
   └─ emit template_version with token stream
        └─ round-trip test: render(tokens) == original body
             └─ FAIL → quarantine list for manual review
```

Variant linkage: files named `X - variant X (2).md` and index rows whose `variants` field is non-empty are grouped under a `variant_group_id` derived from the base `source_guid`.

### B. Field type decision table

| Condition (on bracket inner text) | Type |
|---|---|
| Contains `/`, all segments ≤ 24 chars, no terminal punctuation | `enum` |
| Contains `dated` | `dateOrNone` |
| Matches `^[_ ]+$` and unit token follows | `number` |
| Contains ` x ` between underscores and unit follows | `multislot` (`slot_count=3`) |
| Numeric word set (`[number]`, `[_number_]`) | `number` (unitless) |
| Otherwise | `text` |

### C. Glossary

**Pinned version** — the `template_version_id` a report renders from, fixed at creation.
**Token stream** — the canonical, editable representation of a template body (text/heading/field nodes).
**Hard error / soft warning / nudge** — the three validation tiers (§3.4).
**Head revision** — the newest `report_revision`; drafts are patches against it.
**Break-glass** — audited emergency access grant.
**Patch** — a small operation applied to the token stream, the unit of sync.

---

*Prepared from an analysis of the 427 templates exported from connect.alem.health (Settings > Report Templates). All corpus statistics in §1.1 and §1.4 were measured directly from the exported files and `templates_index.csv`.*
