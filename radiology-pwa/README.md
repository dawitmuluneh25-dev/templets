# AlemHealth Reporting — offline-first radiology report editor

A working prototype PWA built on the template library exported from `connect.alem.health`
(427 files → 301 templates + 126 variant versions).

No build step, no dependencies, no framework. Plain ES modules served as static files.

## Run it

```powershell
cd radiology-pwa
python -m http.server 8777 --bind 127.0.0.1
```

Then open <http://127.0.0.1:8777/>.

Serving over `http://localhost` is required: ES modules, `fetch`, IndexedDB and the service
worker are all blocked on `file://`. Any static server works.

## What is real vs. stubbed

| Area | Status |
|---|---|
| Template import (427 files, typed fields, round-trip verified) | **Real** |
| Template library: search, modality/type/scope facets, variant grouping | **Real** |
| Report editor: section-based document with inline typed field widgets | **Real** |
| Three-tier validation with jump links and per-item acknowledgement | **Real** |
| Autosave to IndexedDB + append-only journal + crash recovery | **Real** |
| Export: plain text, standalone HTML, FHIR `DiagnosticReport`, PDF | **Real** |
| Local activity log | **Real** |
| Optional AES-GCM encryption of drafts (passphrase → PBKDF2) | **Real, with caveats below** |
| Service worker offline shell + manifest / installability | **Real** |
| Authentication, server sync, multi-user, co-signature | **Stubbed** (single local user) |
| Server-side export workers, audit hash chain, retention policy | **Not built** |

## Template pipeline

`tools/import-templates.mjs` converts the exported `.md` files into `data/templates.json`:

```
427 .md files ─► header metadata (name, scope, modality, type, author, GUID, status)
              ─► section detection
                   · FREE_TEXT family: UPPERCASE `SECTION:` headings
                   · STRUCTURED family: `## SECTION` markdown headings
              ─► bracket placeholders ─► typed fields
                   enum | number | multislot | dateOrNone | text
              ─► variant linkage from templates_index.csv
              ─► round-trip test: render(parse(body)) === body  (per file)
```

Result: **427/427 files pass the round-trip check, 0 quarantined, 2381 typed fields across
258 templates.** Any file that failed would be quarantined rather than shipped with altered
clinical wording.

Placeholder parsing is depth-aware: the corpus contains nested placeholders such as
`[[with or without]]` and `[[No enhancing lesions / [___] enhancing lesion(s) …]]`. A flat
regex either leaves literal brackets in the report (which would then trip the placeholder-leak
check) or swallows several placeholders into one, so the scanner matches bracket depth.

Two source-data defects are corrected at import and are visible in the diff if you compare
against the raw files:

- literal `\u00a0` / `\u0000` escape sequences that the original HTML export left as text
  (`iterative\u00a0reconstruction`) are decoded to spaces;
- a heading with a space before the colon (`CTA CHEST :`) is preserved verbatim.

## Validation model

Required-ness is per template, never global — 35 templates in the corpus have no IMPRESSION
section and 10 have no FINDINGS, so a global rule would make them unsignable.

| Tier | Behaviour | Examples |
|---|---|---|
| **Hard** | Blocks sign-off | unmodified boilerplate; EXAM/IMPRESSION/FINDINGS empty *when the template has that section*; non-numeric value in a measurement field; literal `[...]` left in the text |
| **Soft** | Signable after one click, recorded in the activity log | COMPARISON empty; structured fields left unset; IMPRESSION without FINDINGS |
| **Nudge** | Advisory only | IMPRESSION under 8 words; FINDINGS suspiciously short; no explicitly normal phrasing |

"Unmodified boilerplate" is deliberately a hard block: the template's default findings describe
a hypothetical patient, and signing them unread is the most dangerous failure mode in this
workflow. It is detected by hashing the rendered report against the hash taken at creation.

## Autosave and recovery

Two independent layers, because they fail differently:

1. **Journal** — written ~150 ms after typing, append-only, keeps the last 50 entries.
2. **Draft** — written 600 ms after typing stops, then on blur.

If the tab dies inside the draft window, the journal still holds the newer document, and
reopening the report shows a recovery banner with **Restore / Discard** instead of silently
loading the stale draft.

Status labels are honest about where the data is: `Saving…`, `Saved 14:02`,
`Offline — saved locally`. A successful IndexedDB write while offline does **not** report
"Saved", because nothing has left the device.

## Exports

All renderers work from the stored document, not the live DOM, so an export is reproducible.

- **Text** — RIS/PACS paste.
- **HTML** — self-contained, inline CSS.
- **FHIR** — `DiagnosticReport` with `presentedForm`, status `preliminary` for drafts,
  `final` once signed.
- **PDF** — hand-written PDF 1.4 writer (Helvetica, A4, multi-page). `verifyPDF()` in
  `js/export.js` checks every xref offset, every stream length and the trailer; the tests
  assert a clean structural pass on both single- and multi-page output.

## Security

- Drafts are encrypted with AES-GCM 256 using a key derived from a passphrase
  (PBKDF2-SHA256, 150 000 iterations). The key is non-extractable and never persisted;
  locking drops it from memory and the drafts become unreadable.
- Without a passphrase, drafts are stored in the clear and the settings screen says so.
- The service worker caches **only** static assets and the template library. No API response
  and no patient data ever enters the HTTP cache.
- **Not production-grade:** the key is not bound to a device secret, there is no step-up
  authentication on sign-off, and there is no server-side signature. See
  `../docs/Radiology-Report-PWA-Design.md` §6.8 for the full control set.

## Responsive layout

Breakpoints are declared once in `css/styles.css` and mirrored by `matchMedia` in
`js/editor.js`; the two must stay in sync.

| Width | Columns | SECTIONS | REVIEW | Top bar |
|---|---|---|---|---|
| ≥ 1440 | 3 (236 / fluid / 316) | column | column | inline nav |
| 1280–1439 | 3 (212 / fluid / 292) | column | column | inline nav |
| 1024–1279 | 2 (200 / fluid) | column | drawer | `Review` toggle |
| 768–1023 | 1 | drawer | drawer | `Sections` + `Review` |
| < 768 | 1 | drawer | drawer | toggles + `☰` menu |

Both sidebars share one metric set (`--rail-w`, `--context-w`, `--drawer-w`,
`--panel-pad`, `--panel-gap`) and one styling rule, so widths, padding rhythm,
heading treatment and scroll behaviour cannot drift apart.

Drawer behaviour:

- A closed drawer is `transform`-hidden **and** `visibility: hidden` **and**
  `inert`, so it leaves the tab order and the accessibility tree rather than
  merely sitting off-screen. Verified by tabbing: no drawer control is reachable
  while closed.
- Each toggle carries `aria-expanded` + `aria-controls`; `Review` also exposes the
  number of items needing attention, so the sign-blocking count is visible
  without opening the panel.
- Escape closes, the scrim closes, and focus returns to the toggle that opened
  the drawer — never to `<body>`.
- Jumping to a section from the outline or a validation entry closes the drawer
  first, so the target is not left behind a panel.

Height and scrolling: the document no longer scrolls the page. `body` is
`overflow: hidden`, `.app-shell` is `100dvh`, and `#main` is the single scroll
container, which keeps the top bar and status line fixed as rows. Drawers are
viewport-fixed and sized `calc(100dvh - var(--topbar-h))` with
`bottom: 0` — bottom-anchored with an explicit height, because a top+bottom
constrained flex container will size to its content and spill above the top bar.
`--topbar-h` is measured at runtime (the bar is 52px on the report route and
~62.8px on library routes), with a `ResizeObserver` keeping it current.

Layout is verified at 1440, 1280, 1100, 900, 768 and 390 px: `scrollWidth ===
clientWidth` at every width, and every panel's `rect.top` equals the top bar's
`rect.bottom` and its `rect.bottom` equals `innerHeight` to within 0 px.

## Accessibility

Dark reading-room theme by default, light theme available; both use AA-contrast pairs.
Full keyboard operation (every field widget is focusable and opens with Enter/Space, Escape
closes the popover), `role="textbox"` + `aria-multiline` on section editors, skip link, focus
trap in dialogs, 44 px minimum touch targets, no horizontal overflow at 390 px
(verified: `scrollWidth === clientWidth`), `prefers-reduced-motion` respected, print stylesheet
for hard-copy rendering.

## Tests

```powershell
node tools/import-templates.mjs   # import + round-trip fidelity across all 427 files
node tools/test-export.mjs        # document model, validation, all four export formats
```

`test-export.mjs` covers: section splitting for both families, empty-report blocking,
placeholder-leak detection, the "no IMPRESSION section ⇒ no IMPRESSION rule" case, text/HTML/FHIR
rendering, PDF structure (single and multi-page), and a render pass over all 427 templates
(~100 ms, 328 K characters).

## File map

```
radiology-pwa/
├── index.html               app shell
├── manifest.webmanifest     installability + shortcuts
├── sw.js                    offline shell (static assets only, never PHI)
├── css/styles.css           tokens, layout, responsive, print
├── js/
│   ├── app.js               routing, library, drafts, activity, settings
│   ├── editor.js            workspace: outline, sections, field widgets, save, sign, export
│   ├── doc.js               report model, rendering, baseline hash
│   ├── validate.js          three-tier rules
│   ├── export.js            text / HTML / FHIR / PDF + PDF verifier
│   ├── store.js             IndexedDB: drafts, journal, activity
│   ├── crypto.js            PBKDF2 + AES-GCM
│   └── ui.js                DOM helpers, toast, modal
├── data/templates.json      generated — do not hand-edit
└── tools/
    ├── import-templates.mjs parser + fidelity test
    └── test-export.mjs      headless test suite
```

## Known limitations

1. **STRUCTURED templates are not yet pick-lists.** Their FINDINGS options are currently plain
   editable text rather than a mutually-exclusive choice control. The design doc specifies the
   pick-list; the packaging heuristic needs template-admin review to avoid mis-grouping, so it
   is deliberately not automated here.
2. **262 compound placeholders** (`[[A / B with [___] …]]`) are treated as a single free-text
   field. They parse without leaking brackets, but the inner blanks are not separately
   addressable until curated.
3. **No server.** Drafts live on one device only; there is no sync, no conflict resolution
   runtime, and no co-signature — those are designed but not implemented.
4. **Single implicit user.** No authentication; the activity log records `local-user`.
5. **Template versioning** is single-version (`versionNo: 1`). The schema and pinning model
   support more, but there is no version-authoring UI yet.

## Data provenance

Templates imported from `connect.alem.health` → Settings → Report Templates.
130 files are authored by RSNA and 127 by other platform users; **licensing for redistribution
inside a product is unresolved** and must be cleared before this prototype is used with real
templates commercially. Patient data is not included: the exports contain template text only.
