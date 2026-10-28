# Responsive layout QA — AlemHealth Reporting (http://127.0.0.1:8777/)

> **Note (2026-10-29):** the screenshot files referenced below were removed during repository
> cleanup. They are regenerable from the running app with a Playwright capture; the findings,
> measurements and verdicts in this report are unchanged.


**Date:** 2026-10-28
**Template opened:** `XR Chest` (3rd search match, exact name), route `#/report/rep_izwt33gl2i7c`
**Cache reset performed before testing:** SW registration `http://127.0.0.1:8777/` unregistered (0 registrations remaining); cache storage `rpwa-v5` deleted (0 caches remaining); page reloaded at `http://127.0.0.1:8777/?cb=1789000000`.

---

## a) Document visible / section cards render

| Width | doc rendered | .doc width | .doc text length | .section-card count | card heights (px) |
|---|---|---|---|---|---|
| 1440x900 | yes | 873px | 369 chars | 5 | 134.06 / 109.25 / 133.06 / 403.94 / 109.25 |
| 1280x800 | yes | 761px | 369 chars | 5 | 134.06 / 109.25 / 133.06 / 403.94 / 109.25 |
| 900x800 | yes | 885px | 369 chars | 5 | 134.06 / 109.25 / 133.06 / 403.94 / 109.25 |
| 390x844 | yes | 375px | 369 chars | 5 | 128.63 / 103 / 127.63 / 412.59 / 103 |

Not blank at any width; card text present ("EXAM", "CLINICAL HISTORY", "COMPARISON", "FINDINGS", "IMPRESSION").

## b) Panel widths

| Width | #rail (SECTIONS) | #context (REVIEW) |
|---|---|---|
| 1440x900 | **236px** in-flow (`position: sticky`, display flex) | **316px** in-flow (`position: sticky`) |
| 1280x800 | **212px** in-flow | **292px** in-flow |
| 900x800 | **drawer (off-canvas)** — 340px wide, `position: fixed`, `visibility: hidden`, `transform: translateX(-340px)`, rect left = -340, `inert: true` | **drawer (off-canvas)** — 340px wide, `position: fixed`, `visibility: hidden`, `transform: translateX(+340px)`, rect left = 885 (right edge 1225 > viewport 900), `inert: true` |
| 390x844 | **drawer (off-canvas)** — 330px wide, `position: fixed`, `visibility: hidden`, `translateX(-330px)`, left = -330, `inert: true` | **drawer (off-canvas)** — 330px wide, `position: fixed`, `visibility: hidden`, `translateX(+330px)`, left = 375, `inert: true` |

Extra breakpoint probed (stated intent 1024–1279): at **1100x800** the rail is single left column at **200px** in-flow, `#context` is an off-canvas drawer (fixed, 340px, `visibility: hidden`, `inert: true`). Column structure is correct there.

## c) Toggle buttons — `getComputedStyle(el).display` (not presence)

All three toggles are elements `#btn-rail` ("Sections"), `#btn-context` ("Review"), `#btn-menu` ("More navigation" = ☰).

| Width | Sections `#btn-rail` | Review `#btn-context` | ☰ `#btn-menu` |
|---|---|---|---|
| 1440x900 | `display: flex`, visible, 79.23 x 37.81 | `display: flex`, visible, 95.23 x 37.81 | `display: flex`, visible, 36 x 37.81 |
| 1280x800 | `display: flex`, visible, 79.23 x 37.81 | `display: flex`, visible, 95.23 x 37.81 | `display: flex`, visible, 36 x 37.81 |
| 900x800 | `display: flex`, visible, 79.23 x 37.81 | `display: flex`, visible, 95.23 x 37.81 | `display: flex`, visible, 36 x 37.81 |
| 390x844 | `display: flex`, visible, 66.39 x 34 | `display: flex`, visible, 83.16 x 34 | `display: flex`, visible, 36 x 34 |
| 1100x800 | `display: flex`, visible, 79.23 (should be hidden) | `display: flex`, visible, 95.23 | `display: flex`, visible, 36 |

**Deviation:** the design intent says no toggles at ≥1440 and only Review at 1024–1279, and ☰ only at <768. Measured: **all three toggles are `display: flex` and visible at every width tested**, including 1440, 1280 and 1100. `#nav-links` is `display: flex` and visible at 1440/1280/900/1100, and `display: none` only at 390 — so at 900 and 1100 the nav links are visible *and* the ☰ toggle is also visible (redundant duplicate nav affordance).

## d) Horizontal overflow

| Width | `documentElement.scrollWidth` | `documentElement.clientWidth` | equal? | body scrollWidth |
|---|---|---|---|---|
| 1440x900 | 1425 | 1425 | **yes** | 1425 |
| 1280x800 | 1265 | 1265 | **yes** | 1265 |
| 900x800 | 885 | 885 | **yes** | 885 |
| 390x844 | 375 | 375 | **yes** | 375 |
| 1100x800 | 1085 | 1085 | **yes** | 1085 |

(clientWidth is 15px below innerWidth at every width — classic vertical scrollbar.) No horizontal overflow anywhere, including with drawers closed.

## e) Status line text (verbatim)

- 1440x900: `Saved 10:49 PM 0/1 fields 2 blocking · 0 to confirm · 0 advisory 5 sections`
- 1280x800: `Saved 10:49 PM 0/1 fields 2 blocking · 0 to confirm · 0 advisory 5 sections`
- 900x800: `Saved 10:49 PM 0/1 fields 2 blocking · 0 to confirm · 0 advisory 5 sections`
- 390x844: `Saved 10:49 PM 0/1 fields 2 blocking · 0 to confirm · 0 advisory` (the trailing "5 sections" segment is not rendered at 390px)

---

## Drawer behaviour at 390x844

### f) Click "Sections"
- `#rail`: `visibility: visible`, `transform: none`, rect left 0 / right 330, width 330px, `position: fixed`, `inert: false` → **drawer opened from the left**
- scrim `#scrim`: `display: block`, `visibility: visible`, 375 x 792 px, `background: rgba(4, 7, 11, 0.55)`, `z-index: 55` → **dark scrim appears**
- `#btn-rail` `aria-expanded` = **"true"**
- Screenshot: `C:\Users\Administrator\Desktop\templet\qa-responsive\shots\390_sections_drawer_open.png`

### g) Press Escape
- `#rail`: `visibility: hidden`, `transform: translateX(-330px)`, rect left -330, `inert: true` → **closed**
- `#btn-rail` `aria-expanded` = **"false"**
- scrim: `display: none`, width 0
- focus returned to `#btn-rail`

### h) Click "Review"
- `#context`: `visibility: visible`, `transform: none`, rect left 45 / right 375, width 330px, `inert: false` → **right drawer opened**
- scrim: `display: block`, 375 x 792
- `#btn-context` `aria-expanded` = **"true"**; `#btn-rail` stays "false"
- Screenshot: `C:\Users\Administrator\Desktop\templet\qa-responsive\shots\390_review_drawer_open.png`

### i) Click the scrim (viewport point 20, 420)
- Hit element: `div` (scrim)
- `#context`: `visibility: hidden`, `translateX(+330px)`, left 375, `inert: true` → **closed**
- `#btn-context` `aria-expanded` = **"false"**
- scrim: `display: none`
- Note: `document.activeElement` after scrim close is `BODY` — focus is **not** returned to `#btn-context` (minor a11y gap; the Escape path does restore focus to `#btn-rail`).

### j) Click "☰" (`#btn-menu`)
- `#nav-links`: `display: flex`, `position: absolute`, rect left 173 / top 57, 190 x 138 px
- `#btn-menu` `aria-expanded` = **"true"**
- Items rendered: **Templates** (176 x 40), **Drafts 11** (176 x 40), **Activity** (176 x 40) — all `display: flex`, `visibility: visible`
- No scrim behind the menu (`#scrim` `display: none`)
- Screenshot: `C:\Users\Administrator\Desktop\templet\qa-responsive\shots\390_nav_menu_open.png`
- After Escape: `#nav-links` `display: none`, `#btn-menu` `aria-expanded` = "false"

### k) Closed-panel inertness at 390px (both drawers closed)
- `document.getElementById('rail').inert` = **true**
- `document.getElementById('context').inert` = **true**
- `getComputedStyle(#rail).visibility` = **hidden** (`display: flex`, left -330)
- `getComputedStyle(#context).visibility` = **hidden** (`display: flex`, left 375)
- `aria-hidden` attribute is `null` on both (relies on `inert` + `visibility: hidden`)
- Programmatic focus test: calling `.focus()` on a button inside `#rail` and on a button inside `#context` both fail (`document.activeElement` stays `BUTTON#btn-menu`) → contents are genuinely removed from the tab order.
- The a11y snapshot at 390 also omits both panels' contents entirely.

---

## l) Desktop no-op check at 1440x900

- Click "Sections": `#rail` unchanged at 236px, `position: sticky`, `visibility: visible`, left 0, `inert: false`; `aria-expanded` stays **"false"**; `#scrim` `display: none`, width 0.
- Click "Review": `#context` unchanged at 316px, sticky, visible, left 1109, `inert: false`; `aria-expanded` stays **"false"**; `#scrim` `display: none`, width 0. `.doc` width unchanged (873px).
- `document.body.className` and `documentElement.className` stay empty — no drawer state class is applied.
- Result: clicking does nothing (no drawer, no scrim) — but only because the panels are ignored at this width; the buttons themselves are still displayed (see (c)).

## m) Top bar height and panel alignment (measured at scrollY = 0)

| Width | top bar height | top bar bottom | rail top | rail gap | context top | context gap |
|---|---|---|---|---|---|---|
| 1440x900 | **62.81px** | 62.81 | 63 | +0.19 | 63 | +0.19 |
| 1280x800 | **62.81px** | 62.81 | 63 | +0.19 | 63 | +0.19 |
| 900x800 | **62.81px** | 62.81 | 63 (drawer) | +0.19 | **41.09 (drawer)** | **-21.72** |
| 390x844 | **52px** | 52 | 52 (drawer) | 0 | 52 | 0 |
| 1100x800 | **62.81px** | 62.81 | 63 (in-flow) | +0.19 | — (drawer) | — |

- At 1440 / 1280 / 1100 in-flow panels start directly below the bar (0.19px is sub-pixel rounding of 62.81 → 63). **Confirmed.**
- **Deviation at 900x800:** the REVIEW drawer's top is 41.09px while the top bar bottom is 62.81px — the closed drawer's box starts **21.72px above the bottom of the top bar** (overlapping the bar region) and its height is 759px, whereas the SECTIONS drawer correctly starts at 63px. At 390 both drawers correctly start at 52px (= bar height).
- Sticky note: when the page is scrolled, the sticky panels shift (e.g. context top measured 59 at a scroll offset); all numbers above are at `scrollY = 0`.

## n) Console errors

- `browser_utility kind=errors` (JS exceptions): **[] — none**
- `browser_console` level=error: **[] — none**

No console errors and no uncaught exceptions were recorded at any width or after any drawer interaction.

---

## Summary of deviations from design intent

1. **Toggles never hide.** `#btn-rail`, `#btn-context` and `#btn-menu` are all `display: flex` and visible at 1440 and 1280 (intent: none visible ≥1440), and "Sections" is still visible at 1100 (intent: hidden 1024–1279). ☰ is visible at 1440/1280/900/1100 (intent: only <768).
2. **Duplicate navigation at 900 and 1100:** `#nav-links` is visible *and* the ☰ menu button is also visible.
3. **REVIEW drawer misaligned at 900x800:** drawer top 41.09px vs top bar bottom 62.81px (−21.72px overlap); the SECTIONS drawer at the same width is correct (63px).
4. **Minor a11y:** closing the REVIEW drawer by clicking the scrim leaves focus on `BODY` instead of returning it to `#btn-context`.
5. Working correctly: three-column widths (236/316 and 212/292), two-column at 1100 (rail 200), one-column at 900/390, no horizontal overflow at any width, drawers open/close with scrim, `aria-expanded` toggling, Escape support, `inert` + `visibility: hidden` on closed drawers, nav menu contents, and zero console errors.

## Files

- `C:\Users\Administrator\Desktop\templet\qa-responsive\shots\1440x900_topbar.png`
- `C:\Users\Administrator\Desktop\templet\qa-responsive\shots\390_sections_drawer_open.png`
- `C:\Users\Administrator\Desktop\templet\qa-responsive\shots\390_review_drawer_open.png`
- `C:\Users\Administrator\Desktop\templet\qa-responsive\shots\390_nav_menu_open.png`
- `C:\Users\Administrator\Desktop\templet\qa-responsive\measure.js` (measurement harness; no project files were modified)
