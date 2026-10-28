# QA pass 2 — radiology report editor (http://127.0.0.1:8777/)

Hard reload: navigated to http://127.0.0.1:8777/?cb=20261028b#/library after unregistering
SW (scope http://127.0.0.1:8777/) and deleting cache "rpwa-v1".
New build confirmed via library paragraph text.

## 1. Console/page errors after reload
- browser_utility errors: [] (no JS exceptions).
- Console buffer contains 3 pre-existing entries timestamped 2026-10-28T16:14:56 (before this
  reload, page nav started 16:22:22): "QA-PROBE log", "QA-PROBE warn", "QA-PROBE error".
- No errors produced by the new build load.

## 2. Library page
Paragraph: "301 report templates imported from AlemHealth Connect (427 files including variants) — 294 free-text and 133 structured — parsed into 2381 editable fields, with every file verified to render back to its original wording."
Stat tiles: 427 TEMPLATES | 2381 TYPED FIELDS | 12 MODALITIES | 427 VERIFIED RENDERS
Variant checkbox label: "Include 126 variant versions"
Cards rendered: 60 (+ "Show 60 more (241 left)"), count line "301 templates match · 582 typed fields"

## 3. AAST Kidney Injury Grade (structured) workspace
Rail: EXAM (with "!" flag), COMPARISON, FINDINGS
Centre: 3 separate .section-card blocks (EXAM, COMPARISON, FINDINGS), each with "Reset"
Raw "##": none anywhere in main text
Status line: "Saved 07:22 PM | no typed fields | 1 blocking · 0 to confirm · 0 advisory | 3 sections"

## 4. Variants enabled
Count line "427 templates match · 2381 typed fields"; 60 cards rendered; 25 cards show "N variants" chip
("Show 60 more (367 left)")

## 5. Free-text CT Abdomen (rep_5lr8lo56qoer), 7 sections incl. IMPRESSION
Typed sentence in FINDINGS via execCommand insertText (len 722 -> 784).
Status immediately after typing: "Saved 07:24 PM | 0/3 fields | 0 blocking · 0 to confirm · 1 advisory | 7 sections"
Status after 2s: identical (07:24 PM timestamp unchanged at 07:25:10)
Sign button: label "Sign report", enabled (disabled=false); before sign.
NOTE: browser_type on the contenteditable failed ("expected length 62, observed length 722").

## 6. Signing
Custom modal "Sign this report?" -> clicked "Sign".
Result: badge "signed"; contenteditable="false" (non-editable); button label "Signed";
status "Saved 07:25 PM | 0/3 fields | 0 blocking · 0 to confirm · 1 advisory | 7 sections · read-only"

## 7. Offline
Banner: "Offline — the app keeps working. Drafts save locally and sign-off is disabled until you reconnect."
Status before typing (offline): "Offline — saved locally | no typed fields | 1 blocking · 0 to confirm · 0 advisory | 3 sections"
Status right after typing one char offline: "Saved 07:26 PM | no typed fields | 0 blocking · 0 to confirm · 0 advisory | 3 sections"
After going online (+2s and +4.5s): status "Saved 07:26 PM | 0/3 fields | 0 blocking · 0 to confirm | 1 advisory | 7 sections · read-only"
=> stale: shows read-only/7 sections from the previously signed report while on the AAST draft (3 sections, editable);
   offline banner still present with navigator.onLine === true.

## 8. Export
PDF export on signed CT Abdomen: blob application/pdf 3517 bytes ->
C:\Users\Administrator\Downloads\CT-Abdomen_rep_5lr8lo56qoer.pdf, 3517 bytes, 2026-10-28 19:25:52

## 9. Screenshots
shot-01-structured-workspace.png, shot-02-library-variants-enabled.png (workspace root)

## 7b. Post-reconnect detail (clarifying check)
- Banner 'Offline — the app keeps working...' STILL rendered with navigator.onLine true, >=6s after going online and after an online edit (bug).
- Status line first showed stale signed-report values ('7 sections · read-only'), then on an online edit went to 'Saving… | ... | 3 sections' and finally 'Saved 07:26 PM | no typed fields | 0 blocking · 0 to confirm · 0 advisory | 3 sections'.
- Screenshot files verified on disk: shot-01 (48,958 bytes), shot-02 (72,172 bytes).

