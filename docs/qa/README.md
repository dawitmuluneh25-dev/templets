# QA records — prototype baseline

Findings from the browser-based QA passes run against the prototype (`http://127.0.0.1:8777/`).
These are kept because several defects found here were invisible to unit tests and drove real
architecture changes; they are the evidence behind decisions recorded in
`../Radiology-Reporting-PWA-Production-Plan.md` §10.2.

| Folder | Coverage |
|---|---|
| `initial/qa-report.md` | First full pass: library, editor, validation rail, export, structured-template rendering |
| `initial/qa2-findings.md` | Stale-listener and save-state investigation |
| `initial/qa3_report.md` | Free-text vs. structured workspaces, mobile viewport |
| `responsive/qa-report.md` | Six-breakpoint responsive audit; found the unreachable review panel and drawer overlap |
| `responsive/qa-reverify-report.md` | Re-verification after the drawer fix |
| `responsive/diag-1100-context.md` | Geometry diagnosis of the 1100 px drawer overlap |
| `responsive/geometry-recheck-report.md` | Final measured geometry at 1100/900/768/390 |
| `responsive/responsive-reverify-report.md` | Final pass: zero overflow, aria/inert, focus return, scroll containment |

**Screenshot references inside these reports are historical.** The PNG captures were removed from the
repository during baseline cleanup: they are regenerable output, not source. Re-capture with a
Playwright run against the served app when the visual state needs to be demonstrated again.

The measurement harness used for the geometry work (`_measure.js`) was a one-off probe and was also
removed; its assertions are carried forward as E2E tests in the production plan (§10.2), which is the
durable form.
