# QA Pass 3 — Results (http://127.0.0.1:8777/)

Session date: 2026-10-28. All checks run after a hard cache reset.

## Cache / SW reset (pre-condition)
- `navigator.serviceWorker.getRegistrations()` → 1 registration for `http://127.0.0.1:8777/sw.js` → unregistered: `true`
- `caches.keys()` → `["rpwa-v2","rpwa-v3"]` → both deleted (`true`)
- Reloaded with cache-busting query: `?cb=20261028qa3b` (later `?cb=20261028qa3c`)

## A) Offline save label — PASS
Report: CT Abdomen (free text, 8 variants), draft `rep_pxqqua9wy81s`, 7 sections.

| Step | Exact status line |
|---|---|
| Online before edit | `Saved 07:29 PM 0/3 fields 1 blocking · 0 to confirm · 1 advisory 7 sections` |
| Offline + typed into FINDINGS body | `Offline — saved locally 0/3 fields 0 blocking · 0 to confirm · 1 advisory 7 sections` |
| Same, after 2 s | `Offline — saved locally 0/3 fields 0 blocking · 0 to confirm · 1 advisory 7 sections` (unchanged) |
| After returning online, +3 s | `Saved 07:30 PM 0/3 fields 0 blocking · 0 to confirm · 1 advisory 7 sections` |

No transient "Saved HH:MM" appeared while offline. Banner while offline: visible, text `Offline — the app keeps working. Drafts save locally and sign-off is disabled until you reconnect.` Banner hidden again after going online.

## B) Stale status bar between reports — PASS
1. Previous report: CT Abdomen → `7 sections`.
2. Library → opened a different template: **CT Abdomen & Pelvis** (structured), draft `rep_7dm3fqo00163`, 5 sections (EXAM, TECHNIQUE, COMPARISON, FINDINGS, IMPRESSION).
3. Status line on open: `Saved 07:31 PM no typed fields 1 blocking · 0 to confirm · 0 advisory 5 sections`
   → section count = 5 (new report), field segment = `no typed fields` (not `0/3 fields`), advisory = `0` (not `1`). No stale values from the 7-section report.
4. After offline → online cycle in the new report:
   - offline: `Offline — saved locally no typed fields 1 blocking · 0 to confirm · 0 advisory 5 sections`
   - online: `Saved 07:31 PM no typed fields 1 blocking · 0 to confirm · 0 advisory 5 sections`
   → still 5 sections throughout; previous report's numbers never appeared.
5. Offline banner after reconnect: `bannerVisible: false` (hidden). Banner text when visible: `Offline — the app keeps working. Drafts save locally and sign-off is disabled until you reconnect.`

## C) Screenshots (1440x900 desktop / 390x844 mobile)
1. Library, default filters (All modalities / Both types / All scopes, variants unchecked; "301 templates match · 582 typed fields") — `qa3_library_1440x900.png`
2. CT Pelvis (free text, 6 fields) draft `rep_p8ok3z131uwu`, widgets filled: EXAM now reads "CT **Left** Pelvis, **with** IV contrast"; unfilled widgets still dashed-underlined; status `Saved 07:33 PM 2/6 fields 0 blocking · 0 to confirm · 2 advisory 7 sections` — `qa3_report_freetext_1440x900.png`
3. Same report at 390x844 (device emulation, dpr 3): `innerWidth 390`, `documentElement.scrollWidth 390`, `documentElement.clientWidth 390` → **horizontal overflow = 0** — `qa3_report_freetext_390x844.png`
   Note: `browser_act resize` to 390x844 did not take (viewport stayed 487x…); the 390x844 result was produced with device emulation (iPhone 14 preset).

## Console errors
- `browser_utility kind=errors` after a cleared buffer + fresh reload of the report: **`errors: []`** — no page/JS exceptions.
- Captured console buffer (persists across reloads, timestamp fixed at 2026-10-28T16:14:56Z, predates this run):
  - log: `QA-PROBE log`
  - warning: `QA-PROBE warn`
  - error: `QA-PROBE error`
  These are synthetic probe messages from an earlier QA pass (location url empty), not app runtime errors.
