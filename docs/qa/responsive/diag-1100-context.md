# Diagnostic — #context geometry at 1100x800 (report page, XR Chest)

Viewport confirmed: `innerWidth 1100 / innerHeight 800`, `clientWidth 1085 / clientHeight 800`, `scrollY 0`. No data changed.

## A. Requested JS output (verbatim)

```json
{
  "topbarHVar": "63px",
  "inlineVar": "63px",
  "mq1279": true,
  "mq1023": false,
  "barBottom": 62.8125,
  "barHeight": 62.8125,
  "ctxComputed": {
    "top": "63px",
    "bottom": "0px",
    "position": "fixed",
    "height": "758.906px",
    "maxHeight": "none",
    "transform": "matrix(1, 0, 0, 1, 340, 0)",
    "marginTop": "0px",
    "alignSelf": "start",
    "visibility": "hidden"
  },
  "ctxRectTop": 41.09375,
  "railComputed": {
    "top": "63px",
    "bottom": "auto",
    "position": "sticky",
    "height": "304.969px",
    "maxHeight": "737px",
    "transform": "none",
    "marginTop": "0px",
    "alignSelf": "start",
    "visibility": "visible"
  },
  "railRectTop": 63,
  "ctxParentPosition": "static",
  "ctxTransformOrigin": "170px 379.453px"
}
```

## B. Matched `.context`-related rules (verbatim walk of document.styleSheets)

Only one stylesheet exists: `http://127.0.0.1:8777/css/styles.css` (ruleCount 162, no read error); `document.adoptedStyleSheets.length === 0`; no inline `<style>` sheet.

10 rules matched (selector contains "context"). The `@media (max-width: 1279px)` `.context` rule **does** declare `top`:

```json
[
  {"media":"(no media)","selector":".rail, .context","top":"var(--topbar-h)","bottom":"","position":"sticky","cssText":".rail, .context { background: var(--bg-sunken); padding: var(--panel-pad); display: flex; flex-direction: column; gap: var(--panel-gap); min-width: 0px; overflow-y: auto; overscroll-behavior: contain; scrollbar-gutter: stable; position: sticky; top: var(--topbar-h); max-height: calc(100vh - var(--topbar-h)); align-self: start; }"},
  {"media":"(no media)","selector":".context","top":"","bottom":"","position":"","cssText":".context { border-left: 1px solid var(--border); }"},
  {"media":"(no media)","selector":".rail > *, .context > *","top":"","bottom":"","position":"","cssText":".rail > *, .context > * { min-width: 0px; }"},
  {"media":"(no media)","selector":".rail h2, .context h2","top":"","bottom":"","position":"","cssText":".rail h2, .context h2 { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); font-weight: 600; margin: 0 0 var(--sp-2); line-height: 1.2; }"},
  {"media":"(no media)","selector":".context section","top":"","bottom":"","position":"","cssText":".context section { display: flex; flex-direction: column; gap: var(--sp-2); min-width: 0px; }"},
  {"media":"(no media)","selector":".context input[type=\"text\"], .context input[type=\"password\"]","top":"","bottom":"","position":"","cssText":".context input[type=\"text\"], .context input[type=\"password\"] { width: 100%; }"},
  {"media":"(max-width: 1279px)","selector":"body[data-view=\"report\"] #btn-context","top":"","bottom":"","position":"","cssText":"body[data-view=\"report\"] #btn-context { display: inline-flex; }"},
  {"media":"(max-width: 1279px)","selector":".context","top":"var(--topbar-h)","bottom":"0px","position":"fixed","cssText":".context { position: fixed; top: var(--topbar-h); right: 0px; bottom: 0px; width: var(--drawer-w); max-height: none; border-left: 1px solid var(--border-strong); box-shadow: var(--shadow); z-index: 60; transform: translateX(100%); visibility: hidden; transition: transform 180ms, visibility linear 180ms; padding-bottom: max(var(--panel-pad), env(safe-area-inset-bottom)); }"},
  {"media":"(max-width: 1279px)","selector":".context.is-open","top":"","bottom":"","position":"","cssText":".context.is-open { transform: none; visibility: visible; transition: transform 180ms; }"},
  {"media":"print","selector":".topbar, .rail, .context, .statusline, .net-banner, .sec-tools, .toast, .skip-link","top":"","bottom":"","position":"","cssText":".topbar, .rail, .context, .statusline, .net-banner, .sec-tools, .toast, .skip-link { display: none !important; }"}
]
```

Answer to the specific question: YES — the `.context` rule inside `@media (max-width: 1279px)` declares `top: var(--topbar-h)` (resolves to 63px), together with `position: fixed; right: 0; bottom: 0; width: var(--drawer-w); transform: translateX(100%); visibility: hidden`. No other rule in the file sets `top` or `bottom` on `.context`.

## C. Verbatim contradiction (raw values, no interpretation)

- `getComputedStyle(#context).top` = **"63px"**, `inset` = "63px 0px 0px 745px", `computedStyleMap().get('top')` = "63px".
- `#context.getBoundingClientRect().top` = **41.09375**, `offsetTop` = **41**, `getComputedStyle().height` = **758.906px**, rect height = **758.90625**, rect bottom = **800** (= 41.09375 + 758.90625).
- If `top:63px; bottom:0; height:auto` were used, height would be 737 and rect top 63. Height 758.906 implies layout used top = 41.09375.
- Ruled out by direct read: `zoom` = 1 (html, body, #context), `transform` = `matrix(1,0,0,1,340,0)` (X only, no translateY), `translate/rotate/scale` = none, `getAnimations()` = `[]`, no inline `style` attribute, ancestors `DIV.workspace → MAIN#main → DIV.app-shell → BODY → HTML` all `position: static`, `transform/filter/perspective/contain = none`, `will-change: auto`, no scroll (`scrollY 0`, `visualViewport.scale 1`), single `.context` element (`ASIDE.context`), `getClientRects().length = 1`, value stable after forced reflow (41.09375 twice, computed still "63px").

Consequence (measured earlier this session, same page): at 1100 the open drawer renders with its top edge **21.71875px above** the top bar's bottom edge (63 − 41.09375 = 21.90625; barBottom 62.8125 − 41.09375 = 21.71875). `#rail` (sticky at this width) sits exactly at 63px.
