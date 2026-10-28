# AlemHealth Reporting — radiology reporting PWA

An offline-first radiology report editor built on the template library exported from
`connect.alem.health` (427 files → 301 templates + 126 variant versions, 2,381 typed fields).

This repository holds the working prototype, the source template corpus it was derived from, and
the documentation set that carries the project from prototype to production.

## Layout

```
.
├── radiology-pwa/                 Working prototype (no build step, no dependencies)
│   ├── index.html                 App shell
│   ├── css/styles.css             Tokens, layout, widgets, responsive block, print
│   ├── js/                        app · editor · doc · validate · export · store · crypto · ui
│   ├── data/templates.json        Imported library (427 templates, generated)
│   ├── tools/                     import-templates.mjs · test-export.mjs (Node, dev-time only)
│   ├── sw.js                      Service worker — app shell + templates only, never PHI
│   ├── manifest.webmanifest       Installability
│   └── README.md                  Prototype documentation: behaviour, limits, real vs. stubbed
├── packages/                      Production workspace (pnpm + Turborepo) — see below
│   ├── tokens/                    The serialisation boundary (ADR-0005)
│   ├── template-schema/           Manifest contract and provenance classification (ADR-0004)
│   ├── validation/                Severity vocabulary and findings
│   └── contracts/                 Wire contract: resources, problem details, versioning
├── apps/                          web · api · worker — created as each has something to assert
├── alem-reporting-templates/      Source corpus (do not edit — provenance for data/templates.json)
│   ├── AlemHealth/                290 exported templates
│   ├── Publicly Shared/           137 exported templates
│   ├── templates_index.csv        Variant linkage (read by the importer)
│   ├── templates_manifest.json    Per-file metadata and hashes
│   ├── alem_report_templates_raw.json   Raw export from the platform
│   └── TEMPLATES_REPORT.md        Corpus analysis
└── docs/
    ├── Radiology-Report-PWA-Design.md            Requirements, data model, architecture, risks
    ├── Radiology-PWA-Architecture-and-Stack-Plan.md   Greenfield approach and stack rationale
    ├── Radiology-Reporting-PWA-Production-Plan.md     Production plan: integration, co-sign, dictation
    ├── history/                                 Superseded implementations, kept for provenance
    └── qa/                                      QA findings from the prototype build (reports only)
```

## Production workspace

The prototype and the production build live in one repository (ADR-0001). The prototype is frozen
in `radiology-pwa/` and stays runnable; the workspace is where the product is built.

```powershell
corepack enable pnpm      # Node 22 is pinned in .nvmrc
pnpm install --frozen-lockfile
pnpm verify               # lint · format:check · typecheck · test · build
```

| Command | What it covers |
|---|---|
| `pnpm lint` | ESLint flat config, one config at the root |
| `pnpm typecheck` | `tsc --noEmit` per package; a package's dependencies are built first |
| `pnpm test` | Vitest, from the root, resolving workspace packages to source |
| `pnpm corpus` | Regenerate `corpus/` from the frozen export; exits non-zero if any file cannot round-trip |
| `pnpm build` | `tsc` per package via Turborepo, into each package's `dist/` |
| `pnpm verify` | All of the above, in the order CI runs them |

Decisions live in `docs/adr/`. Anything the code does that contradicts an accepted ADR is a bug
until a superseding ADR merges.

## Run the prototype

ES modules, `fetch`, IndexedDB and the service worker all require an HTTP origin — `file://` will
not work.

```powershell
cd radiology-pwa
python -m http.server 8777 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8777/>.

## Verify the baseline

```powershell
cd radiology-pwa
node tools/test-export.mjs          # document model, validation tiers, all exports, PDF structure
node tools/import-templates.mjs     # re-import the corpus; asserts 427/427 round-trip
```

Both pass from a clean checkout. The import tool is the fidelity gate: any template that fails
`render(parse(body)) === body` is quarantined rather than shipped with altered clinical wording.

## Status

The prototype is a **baseline**, not a product. Real: template import and fidelity, library search
and facets, the section-based editor with inline typed fields, three-tier validation, autosave with
journal and crash recovery, text/HTML/FHIR/PDF export, optional AES-GCM draft encryption, offline
shell and installability. Stubbed or absent: authentication, multi-user, server sync, co-signature,
EHR/PACS integration, dictation, server-side audit.

The production plan in `docs/` covers those gaps, the integration architecture, the co-signature
state machine, and the phased roadmap. Read it before extending the prototype — several of its
decisions (signatures as a revision-keyed list, template immutability, offline authoring with online
signing) are expensive to retrofit.

## Conventions

- `main` is the trunk; work happens on short-lived branches and merges through review.
- Every change that touches the template corpus or the importer must keep the 427/427 round-trip
  green — the corpus is the specification, and silent alteration of clinical wording is the one
  failure mode this project cannot accept. In the production workspace that gate is
  `pnpm corpus` plus a CI check that the committed artefacts regenerate byte-identically.
- Generated artifacts (screenshots, packaged ZIPs, sample PDFs) stay out of the tree; `.gitignore`
  covers them and the tools regenerate them on demand.

## Third-party content

The corpus includes 130 templates authored by RSNA and 128 authored by other platform users; 123
of those third-party files sit inside the organisation's own scope, and 168 files carry no author
at all. Licensing for redistribution is unresolved (risk R1 in the production plan; measured
provenance in [ADR-0004](docs/adr/0004-corpus-provenance-and-licensing.md)). Treat
`alem-reporting-templates/` as reference material until that is settled.
