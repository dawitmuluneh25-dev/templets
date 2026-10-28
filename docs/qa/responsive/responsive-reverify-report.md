# Responsive re-verification — AlemHealth Reporting (http://127.0.0.1:8777/)

> **Note (2026-10-29):** the screenshot files referenced below were removed during repository
> cleanup. They are regenerable from the running app with a Playwright capture; the findings,
> measurements and verdicts in this report are unchanged.


Date: 2026-10-28 · Build loaded after SW unregister + cache purge + cache-busted reload (`?cb=1793900001`).
Page under test: report `#/report/rep_avbsaa44rmn5` opened from template exactly **"XR Chest"** (search "XR Chest" → 3 matches → clicked "XR Chest", XR / free text / 7 variants).

## Pre-flight (cache purge)
- `navigator.serviceWorker.getRegistrations()` → 1 registration, unregistered (0 left).
- `caches.keys()` → `["rpwa-v6"]`, deleted (0 left).
- Reload with `?cb=1793900001`, then the report was opened from the fresh build.

## A1. Toggle visibility (`display !== 'none'`)

| Viewport | #btn-rail | #btn-context | #btn-menu | #nav-links | Matches expectation |
|---|---|---|---|---|---|
| 1440x900 | none | none | none | flex (266.30px) | YES |
| 1280x800 | none | none | none | flex (266.30px) | YES |
| 1100x800 | none | **flex** (95.23px) | none | flex (266.30px) | YES |
| 900x800 | **flex** (79.23px) | **flex** (95.23px) | none | flex (266.30px) | YES |
| 768x800 | **flex** (79.23px) | **flex** (95.23px) | none | flex (266.30px) | YES |
| 390x844 | **flex** (66.39px) | **flex** (83.16px) | **flex** (36px) | **none** (position absolute, `top: calc(100% + 6px)`, z-index 70) | YES (☰ + hidden nav at <768px is the intended behaviour) |

## A2. Panel geometry vs top bar (top bar occupies y = 0 → 52 on the report route)

| Viewport | bar.bottom | #rail: position / visibility / width / rect.top | Δ (top − bar.bottom) | #context: position / visibility / width / rect.top | Δ (top − bar.bottom) |
|---|---|---|---|---|---|
| 1440x900 | 52.00 | sticky / visible / 236 / **52.00** | 0.00 | sticky / visible / 316 / **52.00** | 0.00 |
| 1280x800 | 52.00 | sticky / visible / 212 / **52.00** | 0.00 | sticky / visible / 292 / **52.00** | 0.00 |
| 1100x800 | 52.00 | sticky / visible / 200 / **52.00** | 0.00 | fixed / hidden (closed) / 340 / **41.09** | **−10.91 (FAIL)** |
| 900x800 | 52.00 | fixed / hidden (closed) / 340 / **52.00** | 0.00 | fixed / hidden (closed) / 340 / **41.09** | **−10.91 (FAIL)** |
| 768x800 | 52.00 | fixed / hidden (closed) / 340 / **52.00** | 0.00 | fixed / hidden (closed) / 340 / **41.09** | **−10.91 (FAIL)** |
| 390x844 | 52.00 | fixed / hidden (closed) / 330 / **52.00** | 0.00 | fixed / hidden (closed) / 330 / **52.00** | 0.00 |

Extra geometry recorded:
- 1440x900: rail rect 52.00→356.97 (h 304.97); context rect 52.00→856.72 (h 804.72), overflow-y auto.
- 1280x800: rail 52.00→356.97; context 52.00→800.00 (h 748.00).
- 1100/900/768: `#context` is `position: fixed; top: 52px; bottom: 0`, `transform: translateX(340px)`, `visibility: hidden`, `inert: true`, z-index 60, but its **height computes to 758.91px** against only 748px of space below the bar, so it is bottom-pinned and spills 10.91px up over the top bar. `#rail` at the same widths is 304.97px tall and correctly starts at 52.00.
- 390x844: `#rail` 52.00→348.97 (h 296.97); `#context` 52.00→802.91 (h 750.91) → 41.09px of empty space below the panel to the viewport bottom (status line top = 808.66).

**Overlap confirmed with the drawer open** (900x800, Review drawer): `rect.top = 41.09` vs `bar.bottom = 52.00` → **10.91px overlap**. `document.elementFromPoint(450, 45)` returns `aside#context.context.is-open` (drawer paints over the bar band 41.09–52.00); at y=10 and y=30 the bar still wins.

**A3. Horizontal overflow** — `documentElement.scrollWidth === clientWidth` at every size:
1440/1440, 1280/1280, 1100/1100, 900/900, 768/768, 390/390 → all equal.

## B. Scrolling after the restructure (PASS)

`#main` is the scroll container: `getComputedStyle(main).overflowY === "auto"`; ancestors are `visible` (`.app-shell`), `hidden` (body) — body never scrolls (`body.scrollHeight === body.clientHeight === viewport height`, `window.scrollY` stays 0, `documentElement.scrollTop` stays 0).

### B1/B2 — report page at 1440x900
- `main.scrollHeight = 1180`, `main.clientHeight = 812` → max scroll 368.
- `main.scrollTop = 600` → actual `scrollTop = 368` (clamped at max; the value did change, 0 → 368).
- Top bar after scroll: `rect.top = 0.00`, `rect.bottom = 52.00` (unchanged).
- Status line after scroll: `rect.top = 863.66`, `rect.bottom = 900.00` = `innerHeight` 900 → remains fully visible at the bottom.
- Document/body did not scroll; no horizontal growth (`scrollWidth = clientWidth = 1440`).

### B3 — Template library at 900x800
- `#main`: `overflowY = auto`, `scrollHeight = 793`, `clientHeight = 705`; `scrollTop` 0 → 600 requested → **88** (max) → library scrolls inside `#main`.
- Not clipped: last template card bottom = 731 at max scroll, status line bottom = 800, top bar `rect.top = 0`.
- `documentElement.scrollWidth = clientWidth = 900`; body `overflow: hidden`, `scrollHeight = clientHeight = 800` (no page-level scrollbar).
- Note: on this route the top bar is **58.64px** tall (padding 12px + 37.81px nav rows) vs 52px on the report route; `#main` correctly starts at 58.64 there.

## C. Drawer behaviour at 390x844 (PASS)

1. **Sections** → `#rail` visible (`visibility: visible`, `transform: none`, width 330), `#btn-rail[aria-expanded="true"]`, rail `rect.top = 52.00` vs top bar `rect.bottom = 52.00` → **Δ 0.00** (correct). Scrim visible, `top = 52`, `bottom = 844`.
2. **Scrim click** (370,400) → drawer closed (`class="rail"`, `visibility: hidden`, scrim `display: none`, `aria-expanded="false"`), `document.activeElement.id === "btn-rail"` → PASS.
3. **Review** → `#context` open (`visibility: visible`, width 330), `aria-expanded="true"`, `rect.top = 52.00` vs bar bottom 52.00 → **Δ 0.00**. `rect.bottom = 802.91`, i.e. 41.09px short of the 844px viewport bottom (status line top 808.66) — the drawer is content-height (750.91px), not stretched to the bottom, so a strip of scrim shows below it.
   **Escape** → closed, `document.activeElement.id === "btn-context"` → PASS.
4. **Both closed** → `#rail.inert === true` and `#context.inert === true` → PASS.

## D. Console
- `console` messages captured: **none** (0 log/warn/error/debug).
- JS exceptions (`Runtime`/page errors): **none**.
- Therefore: no console errors to quote.

## E. Screenshots (absolute paths)
- `C:\Users\Administrator\Desktop\templet\qa-responsive\reports\shot-1440x900-three-column.png` — three-column layout (rail 236 / doc / context 316), bar 52px, status line visible.
- `C:\Users\Administrator\Desktop\templet\qa-responsive\reports\shot-900x800-drawers-closed.png` — Sections + Review toggles in bar, both drawers closed, no horizontal overflow.
- `C:\Users\Administrator\Desktop\templet\qa-responsive\reports\shot-390x844-review-drawer-open.png` — Review drawer open, top edge flush under the bar, content ends above the status line.

Measurement script used: `C:\Users\Administrator\Desktop\templet\qa-responsive\_measure.js` (read-only DOM measurement; no project files were modified).

## Findings summary
1. **FAIL (A2, cosmetic/functional overlap):** `#context` (Review) drawer is 10.91px too tall at 1100/900/768 (content height 758.91px vs 748px available below the 52px bar). With the drawer open, its top edge sits at `41.09` instead of `52.00` and covers the bottom 10.91px of the top bar (confirmed by `elementFromPoint`). Cause: the drawer is `top:52px; bottom:0` but is sized by content instead of being clamped to the space (no `max-height`/`height: auto` stretch), so `bottom:0` pins it and it overflows upward. `#rail` is unaffected.
2. **Gap (390):** at 330px drawer width the panel content is short enough that `#context` ends at 802.91 (41.09px above the viewport bottom) and `#rail` ends at 348.97 — drawers are content-sized, not full height.
3. **Latent:** drawer `top` is a literal `52px`; the top bar measures 58.64px on the library route, so any future drawer on a route with a taller bar would overlap by 6.64px.
4. Everything else passes: toggle visibility matches the intended breakpoints (including ☰ + hidden nav at 390), no horizontal overflow at any width, `#main` is the sole scroll container and scrolling works with a fixed bar and a persistent status line, scrim/Escape/focus-return/inert behaviour is correct, and there are no console errors.
