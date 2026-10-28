/**
 * App shell: routing, template library, drafts, activity log, settings.
 */

import * as store from './store.js';
import * as vault from './crypto.js';
import { createReport, reportText } from './doc.js';
import { renderWorkspace } from './editor.js';
import { el, clear, toast, modal, relTime } from './ui.js';

const main = document.getElementById('main');
const netBanner = document.getElementById('net-banner');

let DATA = null;
let templateIndex = new Map();

/* ------------------------------------------------------------------- boot */

async function boot() {
  try {
    const res = await fetch('data/templates.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
    templateIndex = new Map(DATA.templates.map((t) => [t.id, t]));
  } catch (err) {
    main.append(
      el('div', { class: 'page' }, [
        el('h1', { text: 'Cannot load the template library' }),
        el('p', { text: `data/templates.json could not be read (${err.message}).` }),
        el('p', {
          class: 'hint',
          text: 'Serve this folder over HTTP — for example: python -m http.server 8080 — then open http://localhost:8080. Opening index.html directly from disk blocks module and data loading.',
        }),
      ])
    );
    return;
  }

  wireChrome();
  registerServiceWorker();
  window.addEventListener('hashchange', route);
  route();
}

function wireChrome() {
  const menuBtn = document.getElementById('btn-menu');
  const navLinks = document.getElementById('nav-links');

  const closeMenu = () => {
    navLinks.classList.remove('is-open');
    menuBtn.setAttribute('aria-expanded', 'false');
  };
  const closeAnd = (fn) => () => {
    closeMenu();
    fn();
  };

  document.getElementById('btn-library').addEventListener('click', closeAnd(() => navigate('#/library')));
  document.getElementById('btn-drafts').addEventListener('click', closeAnd(() => navigate('#/drafts')));
  document.getElementById('btn-audit').addEventListener('click', closeAnd(() => navigate('#/audit')));
  document.getElementById('btn-settings').addEventListener('click', closeAnd(() => navigate('#/settings')));

  // Nav collapses into a menu below 768px so the two drawer toggles keep room.
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = navLinks.classList.toggle('is-open');
    menuBtn.setAttribute('aria-expanded', String(open));
    if (open) navLinks.querySelector('button')?.focus();
  });
  document.addEventListener('click', (e) => {
    if (!navLinks.classList.contains('is-open')) return;
    if (navLinks.contains(e.target) || menuBtn.contains(e.target)) return;
    closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && navLinks.classList.contains('is-open')) {
      closeMenu();
      menuBtn.focus();
    }
  });

  // The top bar wraps at narrow widths; side panels are positioned from its
  // measured height instead of a hard-coded 57px.
  const topbar = document.querySelector('.topbar');
  const syncTopbar = () => {
    const h = Math.round(topbar.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--topbar-h', `${h}px`);
  };
  syncTopbar();
  if ('ResizeObserver' in window) new ResizeObserver(syncTopbar).observe(topbar);
  window.addEventListener('resize', syncTopbar);

  document.getElementById('btn-theme').addEventListener('click', () => {
    const html = document.documentElement;
    const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
    html.dataset.theme = next;
    localStorage.setItem('rpwa.theme', next);
  });
  const savedTheme = localStorage.getItem('rpwa.theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  const paintNet = () => {
    const off = !navigator.onLine;
    netBanner.hidden = !off;
    if (off) netBanner.textContent = 'Offline — the app keeps working. Drafts save locally and sign-off is disabled until you reconnect.';
  };
  window.addEventListener('online', paintNet);
  window.addEventListener('offline', paintNet);
  // Some environments change the connectivity state without dispatching the
  // event (CDP emulation, captive portals), so re-check cheaply.
  setInterval(paintNet, 2000);
  paintNet();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').catch(() => {
    /* offline shell unavailable; the app still works online */
  });
  navigator.storage?.persist?.().catch(() => {});
}

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

/* ------------------------------------------------------------------ router */

async function route() {
  const hash = location.hash || '#/library';
  document.getElementById('modal-root').replaceChildren();

  // Drawers and their scrim live outside <main>; leaving the report must not
  // leave a scrim behind or a toggle stuck in the expanded state.
  document.getElementById('scrim').hidden = true;
  document.getElementById('btn-rail').setAttribute('aria-expanded', 'false');
  document.getElementById('btn-context').setAttribute('aria-expanded', 'false');

  const reportMatch = /^#\/report\/(.+)$/.exec(hash);
  document.body.dataset.view = reportMatch ? 'report' : 'list';
  if (reportMatch) {
    await viewReport(decodeURIComponent(reportMatch[1]));
    return;
  }
  if (hash.startsWith('#/drafts')) return viewDrafts();
  if (hash.startsWith('#/audit')) return viewActivity();
  if (hash.startsWith('#/settings')) return viewSettings();
  return viewLibrary();
}

async function updateDraftCount() {
  try {
    const drafts = await store.listDrafts();
    const open = drafts.filter((d) => d.state !== 'signed');
    const badge = document.getElementById('draft-count');
    badge.hidden = open.length === 0;
    badge.textContent = String(open.length);
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------- library */

const filters = { q: '', modality: '', type: '', scope: '', variants: false };

async function viewLibrary() {
  await updateDraftCount();
  clear(main);

  const modalities = [...new Set(DATA.templates.map((t) => t.modality))].sort();
  const scopes = [...new Set(DATA.templates.map((t) => t.scope))].sort();

  const results = el('div', { class: 'tpl-grid' });
  const meta = el('div', { class: 'result-meta' });

  const searchInput = el('input', {
    type: 'search',
    placeholder: 'Search 427 templates — name, modality, section, author…',
    'aria-label': 'Search templates',
    value: filters.q,
  });

  const modalitySelect = el('select', { 'aria-label': 'Filter by modality' }, [
    el('option', { value: '' }, 'All modalities'),
    ...modalities.map((m) => el('option', { value: m, selected: filters.modality === m }, m === '-' ? 'Unset' : m)),
  ]);
  const typeSelect = el('select', { 'aria-label': 'Filter by template type' }, [
    el('option', { value: '' }, 'Both types'),
    el('option', { value: 'FREE_TEXT', selected: filters.type === 'FREE_TEXT' }, 'Free text'),
    el('option', { value: 'STRUCTURED', selected: filters.type === 'STRUCTURED' }, 'Structured'),
  ]);
  const scopeSelect = el('select', { 'aria-label': 'Filter by scope' }, [
    el('option', { value: '' }, 'All scopes'),
    ...scopes.map((s) => el('option', { value: s, selected: filters.scope === s }, s)),
  ]);

  let shown = 60;

  function apply() {
    filters.q = searchInput.value.trim().toLowerCase();
    filters.modality = modalitySelect.value;
    filters.type = typeSelect.value;
    filters.scope = scopeSelect.value;

    const list = DATA.templates.filter((t) => {
      if (!filters.variants && t.variantLabel) return false;
      if (filters.modality && t.modality !== filters.modality) return false;
      if (filters.type && t.type !== filters.type) return false;
      if (filters.scope && t.scope !== filters.scope) return false;
      if (!filters.q) return true;
      const hay = `${t.name} ${t.modality} ${t.type} ${t.sections.join(' ')} ${t.author || ''}`.toLowerCase();
      return hay.includes(filters.q);
    });

    list.sort((a, b) => (a.baseName || a.name).localeCompare(b.baseName || b.name));

    meta.textContent = `${list.length} template${list.length === 1 ? '' : 's'} match` +
      (filters.q ? ` for "${filters.q}"` : '') +
      ` · ${list.reduce((n, t) => n + (t.fields?.length || 0), 0)} typed fields`;

    clear(results);
    for (const t of list.slice(0, shown)) results.append(card(t));

    if (list.length > shown) {
      results.append(
        el('button', {
          class: 'btn',
          type: 'button',
          style: 'grid-column: 1 / -1; justify-self:center',
          onclick: (e) => {
            shown += 60;
            apply();
            e.currentTarget.scrollIntoView({ block: 'center' });
          },
        }, `Show 60 more (${list.length - shown} left)`)
      );
    }

    if (!list.length) {
      results.append(el('div', { class: 'empty-state', style: 'grid-column:1/-1' }, [
        el('p', { text: 'No template matches those filters.' }),
        el('button', {
          class: 'btn',
          type: 'button',
          onclick: () => {
            searchInput.value = '';
            modalitySelect.value = '';
            typeSelect.value = '';
            scopeSelect.value = '';
            shown = 60;
            apply();
          },
        }, 'Clear filters'),
      ]));
    }
  }

  searchInput.addEventListener('input', () => {
    shown = 60;
    apply();
  });
  [modalitySelect, typeSelect, scopeSelect].forEach((s) => s.addEventListener('change', () => {
    shown = 60;
    apply();
  }));

  const variantToggle = el('label', { class: 'chip', style: 'cursor:pointer; gap:6px' }, [
    el('input', {
      type: 'checkbox',
      checked: filters.variants,
      onchange: (e) => {
        filters.variants = e.target.checked;
        shown = 60;
        apply();
      },
    }),
    `Include ${DATA.templates.filter((t) => t.variantLabel).length} variant versions`,
  ]);

  main.append(
    el('div', { class: 'page' }, [
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Template library' }),
        el('p', {
          text: `${DATA.templates.filter((t) => !t.variantLabel).length} report templates imported from AlemHealth Connect (${DATA.stats.files} files including variants) — ${DATA.stats.byType.FREE_TEXT} free-text and ${DATA.stats.byType.STRUCTURED} structured — parsed into ${DATA.stats.fields} editable fields, with every file verified to render back to its original wording.`,
        }),
        el('div', { class: 'stat-row' }, [
          stat(String(DATA.templates.length), 'templates'),
          stat(String(DATA.stats.fields), 'typed fields'),
          stat(String(Object.keys(DATA.stats.byModality).length), 'modalities'),
          stat(String(DATA.stats.roundTripPass), 'verified renders'),
        ]),
      ]),
      el('div', { class: 'toolbar' }, [
        el('div', { class: 'search-wrap' }, [searchInput]),
        modalitySelect,
        typeSelect,
        scopeSelect,
        variantToggle,
      ]),
      meta,
      results,
    ])
  );

  apply();
}

function stat(value, label) {
  return el('div', { class: 'stat' }, [el('b', { text: value }), el('span', { text: label })]);
}

function card(t) {
  const variants = DATA.templates.filter((x) => x.variantLabel && x.baseName === t.baseName).length;
  const preview = reportText(createReport(t), { includeUnfilled: false })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);

  return el('button', {
    class: 'tpl-card',
    type: 'button',
    onclick: () => startReport(t),
  }, [
    el('span', { class: 'tpl-name', text: t.name }),
    el('span', { class: 'tpl-sub' }, [
      el('span', { class: 'chip', text: t.modality === '-' ? 'unset' : t.modality }),
      el('span', { class: 'chip chip-type', text: t.type === 'FREE_TEXT' ? 'free text' : 'structured' }),
      t.fields?.length ? el('span', { class: 'chip', text: `${t.fields.length} fields` }) : null,
      variants ? el('span', { class: 'chip', text: `${variants} variants` }) : null,
      t.status !== 'Active' ? el('span', { class: 'chip', text: t.status }) : null,
    ]),
    el('span', { class: 'tpl-body-preview', text: preview || '(template has no body text)' }),
    el('span', { class: 'hint', text: `${t.sections.slice(0, 4).join(' · ')}${t.sections.length > 4 ? ' …' : ''}` }),
  ]);
}

async function startReport(template) {
  const report = createReport(template);
  await store.saveDraft(report);
  await store.logActivity({ action: 'report.create', subject: report.id, detail: template.name });
  navigate(`#/report/${encodeURIComponent(report.id)}`);
}

/* ------------------------------------------------------------------ report */

async function viewReport(id) {
  let report;
  try {
    report = await store.getDraft(id);
  } catch (err) {
    clear(main);
    main.append(
      el('div', { class: 'page' }, [
        el('h1', { text: 'Draft is locked' }),
        el('p', { text: err.message }),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: () => navigate('#/settings') }, 'Unlock in settings'),
      ])
    );
    return;
  }
  if (!report) {
    clear(main);
    main.append(el('div', { class: 'page' }, [el('h1', { text: 'Draft not found' }), el('p', { text: 'It may have been deleted.' })]));
    return;
  }
  const template = templateIndex.get(report.templateId);
  if (!template) {
    clear(main);
    main.append(el('div', { class: 'page' }, [el('h1', { text: 'Template missing' }), el('p', { text: 'This report points at a template that is not in the library.' })]));
    return;
  }
  await renderWorkspace(main, {
    report,
    template,
    onBack: () => navigate('#/library'),
  });
  updateDraftCount();
}

/* ------------------------------------------------------------------ drafts */

async function viewDrafts() {
  await updateDraftCount();
  clear(main);
  const list = el('ul', { class: 'list' });

  let drafts = [];
  try {
    drafts = await store.listDrafts();
  } catch (err) {
    list.append(el('li', { class: 'empty-state', text: 'Cannot read local drafts: ' + err.message }));
  }

  if (!drafts.length) {
    list.append(el('li', { class: 'empty-state' }, [
      el('p', { text: 'No drafts stored on this device yet.' }),
      el('button', { class: 'btn btn-primary', type: 'button', onclick: () => navigate('#/library') }, 'Pick a template'),
    ]));
  }

  for (const d of drafts) {
    list.append(
      el('li', { class: 'list-item' }, [
        el('div', { class: 'list-item-main' }, [
          el('div', { class: 'list-item-title' }, [
            d.title,
            d.state === 'signed' ? el('span', { class: 'badge badge-ok', style: 'margin-left:8px' }, 'signed') : null,
            d.locked ? el('span', { class: 'badge badge-warn', style: 'margin-left:8px' }, 'locked') : null,
          ]),
          el('div', { class: 'list-item-sub' }, [
            `${d.modality || '—'} · ${d.accession || 'no accession'} · saved ${relTime(d.updatedAt)}`,
          ]),
        ]),
        el('div', { class: 'list-item-actions' }, [
          el('button', {
            class: 'btn',
            type: 'button',
            onclick: () => navigate(`#/report/${encodeURIComponent(d.id)}`),
          }, d.state === 'signed' ? 'Open' : 'Resume'),
          el('button', {
            class: 'btn btn-danger',
            type: 'button',
            onclick: async () => {
              const answer = await modal({
                title: 'Delete this draft?',
                body: [el('p', { text: `${d.title} — ${d.accession || 'no accession'}. This removes the local copy and its journal.` })],
                actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'del', label: 'Delete', variant: 'danger' }],
              });
              if (answer !== 'del') return;
              await store.deleteDraft(d.id);
              await store.logActivity({ action: 'report.delete', subject: d.id, detail: d.title });
              toast('Draft deleted.');
              viewDrafts();
            },
          }, 'Delete'),
        ]),
      ])
    );
  }

  main.append(
    el('div', { class: 'page' }, [
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Drafts on this device' }),
        el('p', { text: 'Every keystroke batch lands in an encrypted local journal before the slower draft write, so a crash inside the save window is still recoverable when you reopen the report.' }),
      ]),
      list,
    ])
  );
}

/* ---------------------------------------------------------------- activity */

async function viewActivity() {
  clear(main);
  const events = await store.listActivity(300);
  const rows = events.map((e) =>
    el('tr', {}, [
      el('td', { class: 'mono', text: new Date(e.at).toLocaleString() }),
      el('td', { class: 'mono', text: e.action }),
      el('td', { class: 'mono', text: e.subject.slice(-12) }),
      el('td', { text: e.detail }),
    ])
  );

  main.append(
    el('div', { class: 'page' }, [
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Activity log' }),
        el('p', { text: 'Append-only local record of creates, signs, exports and acknowledgements. A production deployment writes this to a server-side, hash-chained audit store with retention policy.' }),
      ]),
      events.length
        ? el('div', { class: 'table-scroll' }, [
            el('table', { class: 'data' }, [
              el('thead', {}, [el('tr', {}, ['When', 'Action', 'Report', 'Detail'].map((h) => el('th', { text: h })))]),
              el('tbody', {}, rows),
            ]),
          ])
        : el('div', { class: 'empty-state', text: 'No activity recorded yet.' }),
    ])
  );
}

/* ---------------------------------------------------------------- settings */

async function viewSettings() {
  clear(main);
  const est = await store.storageEstimate();
  const pass = el('input', { type: 'password', placeholder: 'Passphrase (min 6 characters)', 'aria-label': 'Passphrase', autocomplete: 'new-password' });

  const securityBlock = el('div', { class: 'list-item' }, [
    el('div', { class: 'list-item-main' }, [
      el('div', { class: 'list-item-title' }, [
        'Draft encryption ',
        vault.isUnlocked()
          ? el('span', { class: 'badge badge-ok' }, 'active')
          : vault.hasPassphrase()
            ? el('span', { class: 'badge badge-warn' }, 'locked')
            : el('span', { class: 'badge' }, 'off'),
      ]),
      el('div', { class: 'list-item-sub', text: vault.isUnlocked()
        ? 'Drafts are encrypted with AES-GCM using a key derived from your passphrase (PBKDF2-SHA256, 150k iterations).'
        : vault.hasPassphrase()
          ? 'Drafts are encrypted. Unlock to open them.'
          : 'Without a passphrase drafts are stored unencrypted on this device. Set one before entering real patient data.' }),
    ]),
    el('div', { class: 'list-item-actions' }, [
      pass,
      el('button', {
        class: 'btn btn-primary',
        type: 'button',
        onclick: async () => {
          try {
            if (vault.hasPassphrase() && !vault.isUnlocked()) {
              const ok = await vault.unlock(pass.value);
              if (!ok) throw new Error('Wrong passphrase.');
              toast('Unlocked.');
            } else {
              await vault.setPassphrase(pass.value);
              toast('Passphrase set — drafts will be encrypted from now on.');
            }
            pass.value = '';
            viewSettings();
          } catch (err) {
            toast(err.message);
          }
        },
      }, vault.hasPassphrase() && !vault.isUnlocked() ? 'Unlock' : 'Set passphrase'),
      vault.isUnlocked()
        ? el('button', {
            class: 'btn',
            type: 'button',
            onclick: () => {
              vault.lock();
              toast('Locked. Re-enter your passphrase to open encrypted drafts.');
              viewSettings();
            },
          }, 'Lock now')
        : null,
    ]),
  ]);

  main.append(
    el('div', { class: 'page' }, [
      el('div', { class: 'page-head' }, [
        el('h1', { text: 'Settings and security' }),
        el('p', { text: 'Local-first prototype. Authentication, server sync and export workers are stubbed; the editor, validation, autosave, recovery and export paths are real.' }),
      ]),

      el('h2', { text: 'Security' }),
      el('ul', { class: 'list' }, [securityBlock]),

      el('h2', { text: 'Storage', style: 'margin-top:24px' }),
      el('ul', { class: 'list' }, [
        el('div', { class: 'list-item' }, [
          el('div', { class: 'list-item-main' }, [
            el('div', { class: 'list-item-title', text: 'Local usage' }),
            el('div', { class: 'list-item-sub', text: est
              ? `${(est.usage / 1024 / 1024).toFixed(1)} MB used of ${(est.quota / 1024 / 1024).toFixed(0)} MB available`
              : 'Storage estimate unavailable in this browser' }),
          ]),
          el('div', { class: 'list-item-actions' }, [
            el('button', {
              class: 'btn btn-danger',
              type: 'button',
              onclick: async () => {
                const answer = await modal({
                  title: 'Erase all local data?',
                  body: [el('p', { text: 'Deletes every draft, journal entry and activity record on this device, and clears the encryption keys. This cannot be undone.' })],
                  actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'wipe', label: 'Erase everything', variant: 'danger' }],
                });
                if (answer !== 'wipe') return;
                await store.wipeAll();
                vault.wipeKeys();
                toast('Local data erased.');
                navigate('#/library');
              },
            }, 'Erase local data'),
          ]),
        ]),
      ]),

      el('h2', { text: 'Appearance', style: 'margin-top:24px' }),
      el('ul', { class: 'list' }, [
        el('div', { class: 'list-item' }, [
          el('div', { class: 'list-item-main' }, [
            el('div', { class: 'list-item-title', text: 'Theme' }),
            el('div', { class: 'list-item-sub', text: 'Dark is the default for reading rooms; both themes are checked against WCAG AA contrast.' }),
          ]),
          el('div', { class: 'list-item-actions' }, [
            el('button', {
              class: 'btn',
              type: 'button',
              onclick: () => {
                const html = document.documentElement;
                html.dataset.theme = html.dataset.theme === 'dark' ? 'light' : 'dark';
                localStorage.setItem('rpwa.theme', html.dataset.theme);
              },
            }, 'Toggle theme'),
          ]),
        ]),
      ]),

      el('h2', { text: 'Imported library', style: 'margin-top:24px' }),
      el('div', { class: 'table-scroll' }, [
        el('table', { class: 'data' }, [
          el('tbody', {}, [
          ['Templates', DATA.templates.length],
          ['Free text / structured', `${DATA.stats.byType.FREE_TEXT} / ${DATA.stats.byType.STRUCTURED}`],
          ['Typed fields', DATA.stats.fields],
          ['Round-trip verified', `${DATA.stats.roundTripPass} / ${DATA.stats.files}`],
          ['Quarantined on import', DATA.stats.quarantined],
          ['Imported at', new Date(DATA.generatedAt).toLocaleString()],
          ].map(([k, v]) => el('tr', {}, [el('th', { text: k, style: 'width:40%' }), el('td', { text: String(v) })]))),
          ]),
        ]),
      el('p', { class: 'hint', style: 'margin-top:16px', text: DATA.sourceNote }),
    ])
  );
}

boot();
