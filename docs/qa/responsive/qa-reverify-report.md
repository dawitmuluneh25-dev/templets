# Responsive Re-Verification — AlemHealth Reporting (127.0.0.1:8777)

> **Note (2026-10-29):** the screenshot files referenced below were removed during repository
> cleanup. They are regenerable from the running app with a Playwright capture; the findings,
> measurements and verdicts in this report are unchanged.


Date: 2026-10-28 · Context: report opened = template **"XR Chest"** (exactly), route `#/report/rep_36m9f2yua4p2`.

## 0. Cache reset (before any measurement)
- Old SW registrations found: 1 → `unregister()` → remaining registrations: **0**
- Cache Storage keys found: `["rpwa-v6"]` → deleted → remaining caches: **[]**
- Hard reload with cache-busting query: `http://127.0.0.1:8777/?cb=1789199999`
- Then: Template library → search "XR Chest" → 3 matches → opened card titled exactly `XR Chest` (XR / FREE_TEXT / 7 variants, card click → report route above).

Viewport note: `innerWidth` 1440 → `clientWidth` 1425 (15px scrollbar); all geometry below reported in CSS px against `bar.bottom`.

## 1. Toggle visibility (`getComputedStyle().display !== 'none'`)

| Viewport | #btn-rail "Sections" | #btn-context "Review" | #btn-menu "☰" | #nav-links | Matches expectation |
|---|---|---|---|---|---|
| 1440x900 | false | false | false | true | PASS |
| 1280x800 | false | false | false | true | PASS |
| 1100x800 | false | true | false | true | PASS |
| 900x800 | true | true | false | true | PASS |
| 700x800 | true | true | **true** | **false** | **FAIL** (expected: menu hidden, nav-links visible) |
| 390x844 | true | true | true | false | PASS |

Breakpoint evidence for the 700 failure: `matchMedia('(max-width: 760px)').matches === true` at 700px, i.e. the nav collapses into the ☰ "More navigation" menu at ≤760px instead of only at phone width. Screenshot: `shots/700-topbar-menu-visible.png`.

## 2. Panel geometry

Top bar = `header.topbar`, `position: sticky`, `top: 0`.

| Viewport | bar.bottom | bar height | #rail pos / visibility / width / rect.top | rail overshoot (bar.bottom − rail.top) | #context pos / visibility / width / rect.top | ctx overshoot (bar.bottom − ctx.top) |
|---|---|---|---|---|---|---|
| 1440x900 | 62.81 | 62.81 | sticky / visible / 236px / 63.00 | −0.19 | sticky / visible / 316px / 63.00 | −0.19 |
| 1280x800 | 62.81 | 62.81 | sticky / visible / 212px / 63.00 | −0.19 | sticky / visible / 292px / 63.00 | −0.19 |
| 1100x800 | 62.81 | 62.81 | sticky / visible / 200px / 63.00 | −0.19 | **fixed** / hidden (closed) / 340px / **41.09** | **+21.72 OVERLAP** |
| 900x800 | 62.81 | 62.81 | fixed / hidden / 340px / 63.00 (translateX(-340)) | −0.19 | fixed / hidden / 340px / **41.09** | **+21.72 OVERLAP** |
| 700x800 | 52.00 | 52.00 | fixed / hidden / 330px / 52.00 (translateX(-330)) | 0.00 | fixed / hidden / 330px / **49.09** | **+2.91 OVERLAP** |
| 390x844 | 52.00 | 52.00 | fixed / hidden / 330px / 52.00 | 0.00 | fixed / hidden / 330px / 52.00 | 0.00 |

Overshoot convention: positive = panel top is ABOVE the bar's bottom edge (overlap), negative = panel starts below the bar's bottom (gap).

Open-state confirmation (drawer opened, drawer then re-measured after 500 ms settle):
- 1100x800, Review open: `aria-expanded="true"`, position fixed, visibility visible, top **41.09**, bottom 800, height 758.91, width 340, left 745 → **overlaps the sticky top bar by 21.72px** (bar bottom 62.81). Visually confirmed: `shots/1100-context-open-overlap.png` (drawer's top edge sits at y≈41, cutting through the header which ends at y≈63).
- 700x800, Review open: top **49.09**, bar bottom 52 → **overlap 2.91px**.
- 390x844, Sections open: top 52.00 = bar bottom 52.00 → 0.00 (correct). Review open: top 52.00 = 52.00 → 0.00 (correct).

**Flag:** `#context` overlaps the top bar by 21.72px at 1100 and 900, and by 2.91px at 700 (over the 1px tolerance). The cause is visible in the numbers: at ≥700px the context drawer's fixed `top` resolves to 41.09px (bar height 62.81) and 49.09px (bar height 52) instead of the bar bottom; `#rail` in the same states is correct (63.00 / 52.00).

## 3. Horizontal overflow

| Viewport | documentElement.scrollWidth | clientWidth | Equal |
|---|---|---|---|
| 1440x900 | 1425 | 1425 | YES |
| 1280x800 | 1265 | 1265 | YES |
| 1100x800 | 1085 | 1085 | YES |
| 900x800 | 885 | 885 | YES |
| 700x800 | 685 | 685 | YES |
| 390x844 | 375 | 375 | YES |

## 4. Drawer interaction @ 390x844 (real mouse clicks / real key presses)

a) Click "Sections" (`#btn-rail`): `aria-expanded="true"`, class `rail is-open`, visibility visible, transform none, rect.top 52.00 (= bar bottom), `#scrim` display block / opacity 1 / visibility visible. Screenshot `shots/390-sections-open.png`.
b) Click scrim: `aria-expanded="false"`, class `rail`, visibility hidden, `#scrim` display none, **`document.activeElement.id === "btn-rail"`** (BUTTON "Sections") — PASS (not BODY).
c) Click "Review" (`#btn-context`): `aria-expanded="true"`, class `context is-open`, visibility visible, fixed, top 52.00, overlap 0, scrim display block. Then click scrim: `aria-expanded="false"`, class `context`, visibility hidden, scrim display none, **`document.activeElement.id === "btn-context"`** — PASS.
d) Press Escape with Sections open: `aria-expanded="false"`, visibility hidden, scrim display none, **`document.activeElement.id === "btn-rail"`** — PASS.
e) Both drawers closed: **`#rail.inert === true`** (attribute present), **`#context.inert === true`** (attribute present) — PASS.

Side observation: opening Review moves focus into the drawer (`activeElement` = INPUT, the Accession field) before the close/restore cycle.

## 5. Keyboard order @ 390x844, drawers closed
Start: focused `#btn-rail`, then 8 × Tab (real key presses). Focus sequence observed (0 elements belonged to `#rail` or `#context`):

1. `#btn-context` — BUTTON "Review report, 2 items need attention"
2. `#btn-settings` — BUTTON "Settings and security"
3. `#btn-menu` — BUTTON "More navigation"
4. (no id) — BUTTON "Reset" (EXAM section reset)
5. (no id) — DIV "Section EXAM" (editable field)
6. (no id) — SPAN "free text: not set" (inline chip)
7. (no id) — BUTTON "Reset" (CLINICAL HISTORY reset)
8. (no id) — DIV "Section CLINICAL HISTORY" (editable field)

Result: PASS — no closed-drawer content ("All templates", "Sign report", exports, etc.) appeared; drawer containment/`inert` holds.

## 6. Console
- `browser_console` error-level messages: **0** (none)
- Captured JS exceptions (`browser_utility kind=errors`): **0** (none)

## Verdict
- Section 1: 5/6 widths PASS; **700x800 FAIL** (☰ visible + nav-links hidden).
- Section 2: in-flow sticky panels PASS at 1440/1280 (±0.19px); **FAIL for #context at 1100 (21.72px), 900 (21.72px), 700 (2.91px)** — drawer top above the bar bottom. #rail drawer and the 390 drawers are correct.
- Section 3: PASS at all six widths.
- Section 4: PASS (a–e, incl. focus return and inert).
- Section 5: PASS.
- Section 6: no console errors, no exceptions.

## Artifacts (absolute paths)
- C:\Users\Administrator\Desktop\templet\qa-responsive\shots\390-sections-open.png
- C:\Users\Administrator\Desktop\templet\qa-responsive\shots\1100-context-open-overlap.png
- C:\Users\Administrator\Desktop\templet\qa-responsive\shots\700-topbar-menu-visible.png
