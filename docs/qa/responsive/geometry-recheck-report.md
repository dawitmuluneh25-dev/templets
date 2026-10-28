# Final geometry re-check — AlemHealth Reporting (http://127.0.0.1:8777/)

> **Note (2026-10-29):** the screenshot files referenced below were removed during repository
> cleanup. They are regenerable from the running app with a Playwright capture; the findings,
> measurements and verdicts in this report are unchanged.


Date: 2026-10-28 · Browser: user Chrome · Route measured: `#/report/rep_ot0tzbpy1vdv` (template "XR Chest", XR / free_text / draft, v1 · FREE_TEXT)

## Cache / SW reset (before measuring)
- Service worker registrations unregistered: `http://127.0.0.1:8777/` (1 of 1, count after = 0)
- Cache Storage keys deleted: `rpwa-v7`, `rpwa-v8` (count after = 0)
- Hard reload performed at `http://127.0.0.1:8777/?_cb=20261028_1735`
- Post-reload check: app re-registered its SW (`http://127.0.0.1:8777/sw.js`, scope `/`) on load; `caches.keys()` was still empty `[]` at measurement time.

## A) Drawer geometry (closed / default state, no Review interaction)

| width x height | bar rect.bottom | #context position | #context computed top/bottom/height | #context rect.top / rect.height / rect.bottom | #rail position | #rail computed top/bottom/height | #rail rect.top / rect.height / rect.bottom | innerHeight | Δ top (ctx.top-bar.bottom) | Δ bottom (innerH-ctx.bottom) |
|---|---|---|---|---|---|---|---|---|---|---|
| 1100x800 | 52 | fixed | 52px / 0px / 748px | 52 / 748 / 800 | sticky | 0px / auto / 304.97px | 52 / 304.97 / 356.97 | 800 | 0 | 0 |
| 900x800 | 52 | fixed | 52px / 0px / 748px | 52 / 748 / 800 | fixed | 52px / 0px / 748px | 52 / 748 / 800 | 800 | 0 | 0 |
| 768x800 | 52 | fixed | 52px / 0px / 748px | 52 / 748 / 800 | fixed | 52px / 0px / 748px | 52 / 748 / 800 | 800 | 0 | 0 |
| 390x844 | 52 | fixed | 52px / 0px / 792px | 52 / 792 / 844 | fixed | 52px / 0px / 792px | 52 / 792 / 844 | 844 | 0 | 0 |

- Bar (`header.topbar`): position sticky, top 0px, height 52px (clientHeight 51), rect.top 0, rect.bottom 52, width = viewport width at every size.
- #context at 1100: visible/open in desktop layout (transform none, visibile). At 900/768/390 (closed): `transform: translateX(340px|330px)`, `visibility: hidden`.
- #rail at 900/768/390 (closed): `transform: translateX(-340px|-330px)`, `visibility: hidden`.
- Verdict A: PASS at all four widths — drawer rect.top === bar.bottom exactly and rect.bottom === innerHeight exactly; no overlap above, no gap below.
- Note: at 1100 #rail is `position: sticky` inside the content column (intentional sidebar, height 304.97px = 356.97 bottom), i.e. it is not a full-height drawer at desktop width; at ≤900 widths it becomes the left off-canvas drawer with the same 52→800/844 band as #context.

## B) 900x800 with the Review drawer OPEN (`#btn-context` clicked, class `context is-open`)
- bar rect.bottom: 52 · innerHeight: 800
- #context: position fixed, computed top 52px / bottom 0px / height 748px; rect.top 52, rect.height 748, rect.bottom 800, rect.left 560, rect.width 340
- Δ top vs bar.bottom: 0 px · Δ bottom vs innerHeight: 0 px
- elementFromPoint(730, 46) → `HEADER.topbar` ("AlemHealth Reporting"), `bar.contains(el) === true` → drawer does NOT paint over the bar band.
- Control probe at y = 58 → `ASIDE#context.context.is-open` (drawer occupies everything immediately below the bar).
- Verdict B: PASS.

## C) 390x844 with the Review drawer OPEN
- #context: position fixed, rect.top 52, rect.height 792, rect.bottom 844, rect.left 60, rect.width 330; innerHeight 844 → Δ bottom = 0 (drawer reaches viewport bottom).
- Drawer scroll: scrollHeight 792 === clientHeight 792, overflowY auto; setting `scrollTop = 99999` left `scrollTop = 0` → the drawer cannot scroll (no overflow). No nested scrollable elements inside the drawer (scrollers found: none).
- Button labelled "Sign report": NOT PRESENT in the DOM at this state. The sign action is rendered as `button.btn-primary` with text **"Cannot sign — 2 blocking"**, `disabled = true`; its rect is top 695.44, bottom 733.25, left 73, width 290, height 37.81 → fully inside the viewport (0..844) without scrolling.
- Verdict C: drawer bottom edge PASS; scroll-reachability of a "Sign report" control is N/A because that control does not exist here (the primary action is a disabled "Cannot sign — 2 blocking" button, fully visible).

## D) Horizontal overflow (documentElement)

| width | scrollWidth | clientWidth | overflow |
|---|---|---|---|
| 1100 | 1100 | 1100 | 0 |
| 900 | 900 | 900 | 0 |
| 768 | 768 | 768 | 0 |
| 390 | 390 | 390 | 0 |

body.scrollWidth === body.clientWidth at all four widths as well. Verdict D: PASS (no horizontal overflow at any width).
Note: while the drawer is open at 900/1100, the off-canvas `#rail` is translated to a negative x but does not create scroll (scrollWidth unchanged).

## E) Per-route bar height + drawer alignment after route change
- `#/library` (Template library): `header.topbar` computed height **62.8125px**, rect.top 0, rect.bottom **62.81**, clientHeight 62. No `#context` on this route. Probe at (110, 56.81) → `HEADER.topbar`.
- `#/report/rep_ot0tzbpy1vdv` (back to XR Chest report): `header.topbar` computed height **52px**, rect.bottom **52**; grid `#context` closed after the route change (visibility hidden, rect.top 52).
- After clicking Review (`#btn-context`) → `context is-open`, position fixed, rect.top **52** === bar.bottom **52** (Δ 0), rect.bottom 800 === innerHeight 800 (Δ 0); probe y=46 → HEADER.topbar; y=58 → ASIDE#context.
- Verdict E: bar height differs per route (52px report vs 62.81px library) and the drawer still aligns exactly to the report bar's bottom (52 / 52).

## F) Console errors
- `browser_utility kind=errors` → `[]`
- console messages at level `error` → `[]`
- Statement: no console errors and no uncaught exceptions were recorded during the reset, reload, route changes, Review toggle and all four viewport measurements.

## G) Screenshots (absolute paths)
- `C:\Users\Administrator\Desktop\templet\qa-responsive\geometry-1100x800-drawer-open.png` — 1100x800, Review drawer open, drawer spanning y 52→800.
- `C:\Users\Administrator\Desktop\templet\qa-responsive\geometry-390x844-drawer-open-bottom.png` — 390x844, Review drawer open, drawer reaching viewport bottom (export row + "Cannot sign — 2 blocking" + status bar visible).

## Summary
A PASS (all 4 widths, Δtop = 0, Δbottom = 0) · B PASS (bar band not covered) · C PASS for bottom edge; "Sign report" button absent, disabled sign button fully visible, drawer has no scrollable overflow · D PASS (0 overflow everywhere) · E PASS (bar 52px report vs 62.81px library; drawer aligns to 52) · F no errors.
