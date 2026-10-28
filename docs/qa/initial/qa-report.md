# QA Verification Report — AlemHealth Reporting PWA (http://127.0.0.1:8777/)

> **Note (2026-10-29):** the screenshot files referenced below were removed during repository
> cleanup. They are regenerable from the running app with a Playwright capture; the findings,
> measurements and verdicts in this report are unchanged.


Date: 2026-10-28 · Browser: user Chrome tab (extension/CDP), viewport 1440x900 desktop, then mobile emulation.
Mode: read-only (no project files touched; UI interaction + screenshots only).

---

## 1. Console / errors / network — HIGHEST PRIORITY

| Check | Result |
|---|---|
| `browser_console` captured messages (all levels), across 3 page loads + library→report→library navigation + field-popover edit | **0 messages from the app** (no `log`, `info`, `warn`, `debug`, or `error`) |
| JS page exceptions (`Runtime.exceptionThrown`) | **0** |
| Network requests (27 logged) | **All 200 OK**, no 4xx/5xx, no failed assets |

Verbatim app console output: *none — the console is empty.*

Capture-instrumentation note (so the "empty" result is trustworthy): to prove the log capture channel was live, I injected three synthetic probes from the page:
`console.log("QA-PROBE log")`, `console.warn("QA-PROBE warn")`, `console.error("QA-PROBE error")`.
All three were captured (`location.url` reported as `""` / `lineNumber 0` because they came from an evaluated snippet, not a source file). **Zero other entries followed a full reload at desktop width and a full reload at mobile width.** So: no runtime console errors and no page errors were produced by this app during the exercised flows.

Requests observed (all 200): `/`, `/css/styles.css`, `/js/app.js`, `/js/store.js`, `/js/crypto.js`, `/js/doc.js`, `/js/editor.js`, `/js/ui.js`, `/js/validate.js`, `/js/export.js`, `/data/templates.json`, `/manifest.webmanifest`, `/icons/icon.svg`.

---

## 2. Template library (desktop 1440x900) — renders correctly

- Heading: `Template library` (H2/H1 rendered as `heading "Template library"`).
- Intro paragraph: "427 report templates imported from AlemHealth Connect — 294 free-text and 133 structured — parsed into 2381 editable fields, with every template verified to render back to its original wording."
- **4 stat tiles (exact values from the DOM):**

| Value | Label |
|---|---|
| 427 | TEMPLATES |
| 2381 | TYPED FIELDS |
| 12 | MODALITIES |
| 427 | VERIFIED RENDERS |

  Minor a11y defect: the accessibility tree omits the numeric value of the 4th tile — it exposes only `text "VERIFIED RENDERS"` with no `427` node, while the DOM does contain `427` (visible in the screenshot).
- Search box: placeholder `Search 427 templates — name, modality, section, author…`, accessible name "Search templates".
- **Three select filters:** `All modalities` / `Both types` / `All scopes` — plus an extra checkbox `Include 0 variant versions` (label literally says "0 variant", i.e. a count of 0 leaked into the label).
- Result count line: `427 templates match · 2381 typed fields`
- **Card grid: 60 visible template cards** + pagination button `Show 60 more (367 left)` (60 + 367 = 427). Cards show title, modality chip, type chip (`structured` / `free text`), and a snippet.

## 3. Search "chest"

Result count text (verbatim): `30 templates match for "chest" · 286 typed fields`
Grid then contained 30 result buttons (no "show more" needed).

## 4. First template card → report workspace

Clicking the first card (AAST Kidney Injury Grade) navigated to `#/report/rep_y5e2i15neirv`. The first click attempt reported `detached_or_invisible` (card nodes are re-created on re-render); a second click on the refreshed ref succeeded.

Template header: `AAST Kidney Injury Grade` · chip `CT` · chip `STRUCTURED` · badge `draft` · "No accession set · created 0s ago".

| Item | Observed |
|---|---|
| Left rail outline | H2 `Sections`; **only one entry: `REPORT`** with a `!` warning badge, plus the link `← All templates`. (EXPECTED EXAM / COMPARISON / FINDINGS as separate sections — they were not split out.) |
| Centre section cards | 1 card, header `REPORT` + `Reset` button |
| Section headings inside body | **Literal markdown leaks into the document**: `## EXAM`, `## COMPARISON`, `## FINDINGS` are rendered as visible `span.subhead` text instead of being stripped and used as headings. **BUG.** |
| Inline dotted-underline field widgets | **NONE.** `0` elements matching field widget classes; body is a plain `contenteditable` text region. Structured template's 4 (or more) fields were not converted to interactive widgets — the whole template collapsed into one raw text block. **BUG.** |
| Right-hand "Validation" panel (verbatim) | One entry: `This report is still the unmodified template text. Review each finding against the images before signing.` with tag chip `REPORT` |
| Bottom status line (verbatim) | `Saved 07:14 PM` · `no typed fields` · `1 blocking · 0 to confirm · 0 advisory` · `revision 1 sections` |
| Sign button | **disabled** (`disabled=true`), label exactly **`Cannot sign (1)`**; helper text: "Signing records an immutable revision and a local audit entry." |

---

## 5. Inline field widget test (free-text template `CT Chest`, 23 fields)

Because the first (structured) template rendered **no** field widgets, the widget test was executed on the next available template that reports typed fields: card `CT Chest · free text · 23 fields` → `#/report/rep_yx1tk6r2fqom`.

| Item | Observed |
|---|---|
| Left rail outline | `EXAM 1/1`, `CLINICAL HISTORY 0/1`, `COMPARISON –`, `FINDINGS 0/13`, `IMPRESSION 0/7` (5 sections, per-section field progress) |
| Centre section cards | 5 cards with headings `EXAM`, `CLINICAL HISTORY`, `COMPARISON`, `FINDINGS`, `IMPRESSION`, each with its own `Reset` |
| Inline field widgets | Present: `span.fld.fld-unfilled > span.fld-value`, `role="button"`, `tabindex="0"`, dotted/dashed underline (`border-bottom: 1.25px dashed rgb(58, 69, 83)`) in italic. Example widget text: `with contrast / without / low-dose`. |
| Click a widget | **Popover appears**: `div.fld-pop`, `role="dialog"`, positioned under the widget. Header `WITH CONTRAST / WITHOUT / LOW-DOSE`. Options: `with contrast`, `without`, `low-dose`, `Clear`. |
| Click option `low-dose` | Popover closes; the sentence text updates: `CT Chest with contrast / without / low-dose .` → `CT Chest low-dose .` **Works correctly.** |
| Status line before edit | `Saved 07:15 PM` · `0/23 fields` · `1 blocking · 1 to confirm · 3 advisory` · `revision 5 sections` |
| Status line after edit | `Saved 07:16 PM` · `1/23 fields` · `0 blocking · 1 to confirm · 3 advisory` · `revision 5 sections` (blocking decremented 1→0, typed-field counter 0/23→1/23 — correct) |
| Validation panel entries after edit (verbatim, 4 entries) | 1. `9 structured fields left unset ("prior study date", "Well-defined / spiculated / lobulated", "nodule / mass", …).` — tag `COMPARISON` — with button `Acknowledge`<br>2. `IMPRESSION is only 1 word. A referring clinician may not be able to act on it.` — tag `IMPRESSION`<br>3. `FINDINGS is only 6 words for this template — check nothing was left out.` — tag `FINDINGS`<br>4. `No explicitly normal phrasing found. Confirm this is intentional for a study with findings.` — no tag chip |
| Sign button after edit | **disabled** (`disabled=true`, no `aria-disabled`), label exactly **`Cannot sign (1)`** |

**Inconsistency to flag:** after the edit the status line reports `0 blocking · 1 to confirm`, yet the disabled sign button still reads `Cannot sign (1)` — the label appears to count "to confirm" items while calling them blocking; the number is also stale-looking relative to 0 blocking.

---

## 6. Screenshots (absolute paths)

- `C:\Users\Administrator\Desktop\templet\qa-screenshots\library-desktop-1440x900.png`
- `C:\Users\Administrator\Desktop\templet\qa-screenshots\workspace-desktop-1440x900.png` (first card / structured AAST template — shows the `##` leak and no field widgets)
- `C:\Users\Administrator\Desktop\templet\qa-screenshots\workspace-ctchest-field-widgets-1440x900.png` (CT Chest free-text workspace with dotted field widgets + 4 validation entries)
- `C:\Users\Administrator\Desktop\templet\qa-screenshots\library-mobile-390x844-true.png` (true 390x844 via device emulation)
- `C:\Users\Administrator\Desktop\templet\qa-screenshots\library-mobile-390x844.png` (plain window resize — note environment zoom 0.8 made this effectively 487 CSS px wide)

## 7. Mobile (390x844, reloaded library)

Two measurements, because the plain `resize` was contaminated by browser zoom in this environment (`devicePixelRatio 0.8` → `window.innerWidth` 487, not 390):

1. Plain resize 390x844: `innerWidth` 487 / `devicePixelRatio` 0.8 (browser zoom 80%), `scrollWidth 468 == clientWidth 468`, overflow 0.
2. CDP device emulation `iPhone 14` (390x844, dpr 3) + reload — authoritative result:
   - `window.innerWidth 390`, `innerHeight 844`, `devicePixelRatio 3`
   - `document.documentElement.scrollWidth 390` vs `clientWidth 390` → **overflow 0 px, no horizontal scrolling**
   - **Layout is single-column**: every template card at `left: 12`, `width: 366`; stat tiles wrap 2×2; search box and the three filters wrap onto separate rows.
   - **Top bar actions reachable**: `Templates` (71→149), `Drafts 2` (153→231), `Activity` (235→298), theme toggle `◐` (302→338), settings `⚙` (342→378) — all fully inside the 390 px viewport. Brand text collapses to the "A" logo tile.
   - Cosmetic: the search placeholder is visually clipped (`Search 427 templates — name, modality, sectic`).

## 8. Service worker + manifest

| Check | Result |
|---|---|
| `navigator.serviceWorker.getRegistrations()` | **1 registration, no error** — active `scriptURL = http://127.0.0.1:8777/sw.js`, `scope = http://127.0.0.1:8777/`, not installing/waiting; `navigator.serviceWorker.controller` is truthy |
| Web app manifest | Linked in `<head>`: `<link rel="manifest" href="manifest.webmanifest">` → resolves to `http://127.0.0.1:8777/manifest.webmanifest`, HTTP **200** |

---

## Defects found (summary)

1. **Structured templates are not parsed into sections/fields.** First card (AAST Kidney Injury Grade, `structured`) opens with a single `REPORT` section, `no typed fields`, zero inline field widgets, and the raw markdown `## EXAM` / `## COMPARISON` / `## FINDINGS` visible inside the editable body. Validation then blocks signing forever with "This report is still the unmodified template text" → `Cannot sign (1)`.
2. **Sign button label/count inconsistency** on the free-text template: status line says `0 blocking · 1 to confirm` while the disabled button reads `Cannot sign (1)`.
3. **Left rail shows `!` badge with no visible explanation** for the structured report beyond the validation sentence; the rail lists only `REPORT` for a template that has 3 sub-sections.
4. Minor a11y/markup: 4th stat tile value (`427`) missing from the accessibility tree; checkbox label reads `Include 0 variant versions`.
5. Minor cosmetic: search placeholder clipped at 390 px.

No console errors, no page exceptions, no failed network requests, SW + manifest healthy.
