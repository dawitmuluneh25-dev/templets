/**
 * Report workspace: outline, section editor with inline field widgets,
 * validation rail, autosave + crash recovery, sign-off and export.
 */

import * as store from './store.js';
import { validate } from './validate.js';
import { renderSection, fieldValue, buildSections } from './doc.js';
import * as ex from './export.js';
import { el, clear, toast, modal, relTime, clockTime } from './ui.js';

const SAVE_DEBOUNCE = 600;
const JOURNAL_DEBOUNCE = 150;

// Only the most recently mounted workspace may paint. Without this, the
// online/offline listeners and save timers left behind by a previous report
// keep writing that report's numbers into the current status bar.
let activeMount = null;

export async function renderWorkspace(root, { report, template, onBack }) {
  clear(root);

  const self = { reportId: report.id };
  activeMount = self;
  const isCurrent = () => activeMount === self;

  let saveTimer = null;
  let journalTimer = null;
  let saveState = 'saved'; // saved | saving | offline | error
  let lastError = '';
  let lastSavedAt = report.updatedAt;
  let issues = { issues: [], counts: { hard: 0, soft: 0, softUnacked: 0, nudge: 0 }, canSign: false };
  let recovered = null;

  const signed = report.state === 'signed';
  const editable = !signed;

  /* --------------------------------------------------------- crash recovery */

  try {
    const last = await store.latestJournal(report.id);
    if (last?.snapshot?.updatedAt && new Date(last.snapshot.updatedAt) > new Date(report.updatedAt)) {
      recovered = last.snapshot;
    }
  } catch {
    /* no journal yet */
  }

  /* ------------------------------------------------------------------ layout */

  const outline = el('ul', { class: 'outline', 'aria-label': 'Report sections' });
  const docBody = el('div', { class: 'doc-inner' });
  const issueList = el('ul', { class: 'issue-list' });
  const statusText = el('span', {});
  const statusDot = el('span', { class: 'status-dot' });
  const signBtn = el('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Sign report');

  const rail = el('aside', { class: 'rail', id: 'rail' }, [
    el('h2', { text: 'Sections' }),
    outline,
    el('button', { class: 'btn btn-ghost', type: 'button', onclick: onBack }, '← All templates'),
  ]);

  // Header meta is kept as live nodes: editing the accession in the rail must be
  // reflected in the document header without re-rendering (and losing the caret).
  const metaAcc = el('span', {});
  const metaDemo = el('span', {});

  function paintMeta() {
    metaAcc.textContent = report.study.accession ? `Accession ${report.study.accession}` : 'No accession set';
    metaDemo.textContent = report.study.demographics || '';
    metaDemo.hidden = !report.study.demographics;
  }

  const accessionInput = el('input', {
    type: 'text',
    value: report.study.accession || '',
    placeholder: 'e.g. ACC-2026-4821',
    'aria-label': 'Accession number',
    onchange: (e) => {
      report.study.accession = e.target.value.trim();
      paintMeta();
      touch();
    },
    oninput: (e) => {
      report.study.accession = e.target.value.trim();
      paintMeta();
    },
    disabled: !editable,
  });

  const demoInput = el('input', {
    type: 'text',
    value: report.study.demographics || '',
    placeholder: 'e.g. 56F',
    'aria-label': 'Patient demographics',
    onchange: (e) => {
      report.study.demographics = e.target.value.trim();
      paintMeta();
      touch();
    },
    oninput: (e) => {
      report.study.demographics = e.target.value.trim();
      paintMeta();
    },
    disabled: !editable,
  });

  const context = el('aside', { class: 'context', id: 'context' }, [
    el('section', {}, [
      el('h2', { text: 'Study' }),
      el('dl', { class: 'kv' }, [
        el('dt', { text: 'Modality' }), el('dd', { text: report.modality || '—' }),
        el('dt', { text: 'Template' }), el('dd', { text: report.templateName }),
        el('dt', { text: 'Version' }), el('dd', { text: `v${report.templateVersion} · ${report.templateType}` }),
      ]),
      el('label', { class: 'hint', for: 'acc-input', text: 'Accession' }),
      accessionInput,
      el('label', { class: 'hint', for: 'demo-input', text: 'Patient' }),
      demoInput,
    ]),
    el('section', {}, [
      el('h2', { text: 'Validation' }),
      issueList,
    ]),
    el('section', { class: 'sign-bar' }, [
      signBtn,
      el('p', { class: 'sign-note', text: 'Signing records an immutable revision and a local audit entry.' }),
    ]),
  ]);

  const statusline = el('div', { class: 'statusline' }, [
    el('span', {}, [statusDot, statusText]),
    el('span', { id: 'field-progress' }),
    el('span', { id: 'issue-progress' }),
    el('span', { class: 'hint', id: 'saved-at' }),
  ]);

  const doc = el('section', { class: 'doc' }, [docBody]);

  const workspace = el('div', { class: 'workspace' }, [rail, doc, context]);
  root.append(workspace);
  root.parentElement?.querySelector('.statusline')?.remove();
  root.after(statusline);

  /* ------------------------------------------------------------- status line */

  function paintStatus(extra = '') {
    if (!isCurrent()) return;
    const label = {
      saved: `Saved ${clockTime(lastSavedAt)}`,
      saving: 'Saving…',
      offline: 'Offline — saved locally',
      error: lastError || 'Save failed',
    }[saveState];
    statusDot.className = 'status-dot' + (saveState === 'saving' ? ' saving' : saveState === 'error' ? ' error' : '');
    statusText.textContent = label;
    document.getElementById('saved-at').textContent =
      extra || `${report.sections.length} sections${signed ? ' · read-only' : ''}`;
    const total = (template.fields || []).length;
    const filled = (template.fields || []).filter((f) => fieldValue(report, f.key)).length;
    document.getElementById('field-progress').textContent = total ? `${filled}/${total} fields` : 'no typed fields';
    const c = issues.counts;
    document.getElementById('issue-progress').textContent =
      `${c.hard} blocking · ${c.softUnacked} to confirm · ${c.nudge} advisory`;
  }

  /* ------------------------------------------------------------------- save */

  function touch() {
    if (!editable) return;
    saveState = navigator.onLine ? 'saving' : 'offline';
    paintStatus();
    scheduleJournal();
    scheduleSave();
  }

  function scheduleJournal() {
    clearTimeout(journalTimer);
    journalTimer = setTimeout(async () => {
      try {
        // Journal is written first and cheaply: if the tab dies inside the
        // draft debounce window this is the only surviving copy.
        await store.appendJournal({
          reportId: report.id,
          updatedAt: report.updatedAt,
          snapshot: JSON.parse(JSON.stringify({ ...report, updatedAt: new Date().toISOString() })),
        });
      } catch {
        /* journal is best-effort */
      }
    }, JOURNAL_DEBOUNCE);
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, SAVE_DEBOUNCE);
  }

  async function doSave() {
    if (!isCurrent()) return;
    const stamp = new Date().toISOString();
    report.updatedAt = stamp;
    try {
      await store.saveDraft(report);
      lastSavedAt = stamp;
      // A local write succeeding is not the same as being synced: with no
      // network the honest label is "saved locally".
      saveState = navigator.onLine ? 'saved' : 'offline';
      lastError = '';
    } catch (err) {
      saveState = 'error';
      lastError = err?.message === 'locked'
        ? 'Locked — unlock to save encrypted drafts'
        : 'Save failed: ' + (err?.message || 'storage error');
    }
    paintStatus();
  }

  const onOnline = () => {
    if (!isCurrent() || saveState !== 'offline') return;
    saveState = 'saving';
    paintStatus();
    doSave();
  };
  const onOffline = () => {
    if (!isCurrent()) return;
    saveState = 'offline';
    paintStatus();
  };
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  /* -------------------------------------------------------------- validation */

  let validateTimer = null;
  /** Validation is deferred while typing; discrete actions call revalidate(). */
  function queueValidate() {
    if (validateTimer) return;
    validateTimer = setTimeout(() => {
      validateTimer = null;
      if (isCurrent()) revalidate();
    }, 140);
  }

  function paintBadge() {
    const badge = document.getElementById('ctx-badge');
    if (!badge) return;
    const blocking = issues.counts.hard + issues.counts.softUnacked;
    badge.hidden = blocking === 0;
    badge.textContent = String(blocking);
    const btn = document.getElementById('btn-context');
    if (btn) {
      btn.setAttribute(
        'aria-label',
        blocking ? `Review report, ${blocking} item${blocking > 1 ? 's' : ''} need attention` : 'Review report'
      );
    }
  }

  function revalidate() {
    issues = validate(report, template);
    paintIssues();
    paintOutline();
    paintBadge();
    paintStatus();
    signBtn.disabled = !issues.canSign || signed;
    if (signed) signBtn.textContent = 'Signed';
    else if (issues.canSign) signBtn.textContent = 'Sign report';
    else {
      const parts = [];
      if (issues.counts.hard) parts.push(`${issues.counts.hard} blocking`);
      if (issues.counts.softUnacked) parts.push(`${issues.counts.softUnacked} to confirm`);
      signBtn.textContent = `Cannot sign — ${parts.join(', ')}`;
    }
  }

  function paintIssues() {
    clear(issueList);
    if (!issues.issues.length) {
      issueList.append(el('li', { class: 'issue', style: 'border-left-color: var(--accent)' }, ['No issues found.']));
      return;
    }
    for (const issue of issues.issues) {
      const acked = (report.acknowledged || []).includes(issue.id);
      const li = el('li', { class: `issue issue-${issue.severity}` }, [
        el('div', {}, [
          el('div', { text: issue.message }),
          el('div', { class: 'hint' }, [
            issue.section ? el('button', {
              class: 'link',
              type: 'button',
              onclick: () => focusSection(issue.section),
            }, issue.section) : null,
            issue.severity === 'soft' && !acked && editable
              ? el('button', {
                  class: 'link',
                  type: 'button',
                  style: 'margin-left:8px',
                  onclick: () => {
                    report.acknowledged = [...(report.acknowledged || []), issue.id];
                    store.logActivity({ action: 'validation.acknowledge', subject: report.id, detail: issue.id });
                    touch();
                    revalidate();
                  },
                }, 'Acknowledge')
              : null,
            acked ? el('span', { class: 'chip', text: 'acknowledged' }) : null,
          ]),
        ]),
      ]);
      issueList.append(li);
    }
  }

  function focusSection(heading) {
    const idx = report.sections.findIndex((s) => s.heading.trim().toUpperCase() === String(heading).toUpperCase().replace(/:$/, ''));
    if (idx < 0) return;
    // Jumping from a drawer must not leave the drawer covering the target.
    closePanels();
    setActiveSection(idx);
    const card = docBody.querySelector(`[data-section="${idx}"]`);
    if (!card) return;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('is-target');
    setTimeout(() => card.classList.remove('is-target'), 1600);
    const body = card.querySelector('.sec-body');
    if (body && editable) body.focus();
  }

  // The outline is built once; revalidation only updates the counts in place.
  // Rebuilding the list on every keystroke was the most expensive thing the
  // editor did, and it discarded the focused button.
  const outlineRefs = [];
  let activeSectionIdx = -1;

  function buildOutline() {
    clear(outline);
    outlineRefs.length = 0;
    report.sections.forEach((section, idx) => {
      const countEl = el('span', { class: 'ol-count' });
      const btn = el('button', {
        type: 'button',
        'aria-current': 'false',
        onclick: () => {
          setActiveSection(idx);
          focusSection(section.heading);
        },
      }, [el('span', { text: section.heading }), countEl]);
      outlineRefs.push({ btn, countEl });
      outline.append(el('li', {}, [btn]));
    });
  }

  function setActiveSection(idx) {
    activeSectionIdx = idx;
    outlineRefs.forEach((ref, i) => ref.btn.setAttribute('aria-current', String(i === idx)));
  }

  function paintOutline() {
    report.sections.forEach((section, idx) => {
      const ref = outlineRefs[idx];
      if (!ref) return;
      const fields = section.tokens.filter((t) => t.t === 'field');
      const filled = fields.filter((t) => fieldValue(report, t.key)).length;
      const sectionIssues = issues.issues.filter((i) => i.section === section.heading);
      const hard = sectionIssues.some((i) => i.severity === 'hard');
      const soft = sectionIssues.some((i) => i.severity === 'soft');

      ref.countEl.className =
        'ol-count' + (hard ? ' has-issue' : fields.length && filled === fields.length ? ' is-complete' : '');
      ref.countEl.textContent = hard ? '!' : soft ? '~' : fields.length ? `${filled}/${fields.length}` : '';
    });
  }

  /* --------------------------------------------------------------- rendering */

  function fieldWidget(tk) {
    const field = (template.fields || []).find((f) => f.key === tk.key) || {
      key: tk.key,
      label: tk.raw,
      type: 'text',
      placeholder: tk.raw.replace(/^\[|\]$/g, ''),
    };
    const value = fieldValue(report, tk.key);

    const widget = el('span', {
      class: 'fld ' + (value ? 'fld-filled' : 'fld-unfilled'),
      contenteditable: 'false',
      role: 'button',
      tabindex: editable ? '0' : '-1',
      'aria-label': `${field.label}: ${value || 'not set'}`,
      dataset: { key: tk.key },
    }, [el('span', { class: 'fld-value', text: value || short(field.placeholder || field.label) })]);

    const open = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!editable) return;
      openFieldEditor(widget, field, (next) => {
        if (next === '' || next === null) delete report.fieldValues[tk.key];
        else report.fieldValues[tk.key] = next;
        const v = fieldValue(report, tk.key);
        widget.className = 'fld ' + (v ? 'fld-filled' : 'fld-unfilled');
        widget.querySelector('.fld-value').textContent = v || short(field.placeholder || field.label);
        widget.setAttribute('aria-label', `${field.label}: ${v || 'not set'}`);
        touch();
        revalidate();
      });
    };

    widget.addEventListener('click', open);
    widget.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') open(e);
    });
    return widget;
  }

  function short(text, max = 42) {
    const t = String(text).replace(/\s+/g, ' ').trim();
    if (!t) return 'set';
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }

  function openFieldEditor(anchor, field, commit) {
    document.querySelector('.fld-pop')?.remove();
    const rect = anchor.getBoundingClientRect();
    const pop = el('div', { class: 'fld-pop', role: 'dialog', 'aria-label': `Set ${field.label}` }, [
      el('div', { class: 'fld-pop-label', text: field.type === 'number' && field.unit ? `${field.label} (${field.unit})` : field.label }),
    ]);

    if (field.type === 'enum' && field.options) {
      for (const opt of field.options) {
        pop.append(
          el('button', {
            type: 'button',
            onclick: () => {
              commit(opt);
              pop.remove();
            },
          }, opt)
        );
      }
    } else if (field.type === 'dateOrNone') {
      for (const opt of ['None', 'Prior study']) {
        pop.append(el('button', { type: 'button', onclick: () => { commit(opt); pop.remove(); } }, opt));
      }
      const dateInput = el('input', { type: 'date', 'aria-label': 'Prior study date' });
      dateInput.addEventListener('change', () => {
        commit(`Prior study dated ${dateInput.value}`);
        pop.remove();
      });
      pop.append(dateInput);
    } else {
      const long = String(field.placeholder || '').length > 24 || field.type === 'text';
      const input = long
        ? el('textarea', { rows: '3', style: 'width:100%', 'aria-label': field.label })
        : el('input', { type: 'text', style: 'width:100%', 'aria-label': field.label, inputmode: field.type === 'number' ? 'decimal' : 'text' });
      input.value = fieldValue(report, field.key) || '';
      pop.append(input);
      pop.append(
        el('button', {
          type: 'button',
          onclick: () => {
            commit(input.value);
            pop.remove();
          },
        }, 'Set value')
      );
      setTimeout(() => input.focus(), 0);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commit(input.value);
          pop.remove();
        }
      });
    }

    pop.append(el('button', { class: 'pop-clear', type: 'button', onclick: () => { commit(''); pop.remove(); } }, 'Clear'));

    document.body.append(pop);
    const pw = pop.offsetWidth;
    const left = Math.min(rect.left, window.innerWidth - pw - 12);
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${rect.bottom + window.scrollY + 6}px`;

    const onDoc = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchor) {
        pop.remove();
        document.removeEventListener('mousedown', onDoc);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        pop.remove();
        anchor.focus();
      }
    });
  }

  /** Serialises an edited section body back into tokens. */
  function serializeSection(bodyEl) {
    const tokens = [];
    const pushText = (text) => {
      if (!text) return;
      const last = tokens[tokens.length - 1];
      if (last && last.t === 'text') last.text += text;
      else tokens.push({ t: 'text', text });
    };

    for (const node of bodyEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        pushText(node.data);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.classList.contains('fld')) {
          const key = node.dataset.key;
          const original = findFieldToken(key);
          tokens.push({ t: 'field', key, raw: original?.raw || '[…]' });
        } else if (node.classList.contains('subhead')) {
          tokens.push({ t: 'heading', level: 2, text: node.textContent, prefix: '' });
        } else if (node.tagName === 'BR') {
          pushText('\n');
        } else {
          pushText(node.textContent);
        }
      }
    }
    return tokens;
  }

  function findFieldToken(key) {
    for (const s of report.sections) {
      for (const t of s.tokens) if (t.t === 'field' && t.key === key) return t;
    }
    return null;
  }

  function renderDoc() {
    clear(docBody);

    docBody.append(
      el('div', { class: 'doc-head' }, [
        el('div', { class: 'doc-title-row' }, [
          el('span', { class: 'doc-title', text: report.templateName }),
          el('span', { class: 'chip', text: report.modality || '—' }),
          el('span', { class: 'chip chip-type', text: report.templateType }),
          signed ? el('span', { class: 'badge badge-ok', text: 'signed' }) : el('span', { class: 'badge', text: 'draft' }),
        ]),
        el('div', { class: 'doc-meta' }, [
          metaAcc,
          metaDemo,
          el('span', { text: `created ${relTime(report.createdAt)}` }),
        ]),
      ])
    );

    if (recovered) {
      docBody.prepend(
        el('div', { class: 'recovery', role: 'status' }, [
          el('div', {}, [
            el('h3', { text: 'Unsaved changes recovered' }),
            el('p', { text: `Local journal has newer content from ${clockTime(recovered.updatedAt)} that never reached storage.` }),
          ]),
          el('div', { class: 'recovery-actions' }, [
            el('button', {
              class: 'btn btn-primary',
              type: 'button',
              onclick: async () => {
                Object.assign(report, recovered);
                recovered = null;
                await doSave();
                renderDoc();
                revalidate();
                toast('Recovered journal content.');
              },
            }, 'Restore'),
            el('button', {
              class: 'btn',
              type: 'button',
              onclick: () => {
                recovered = null;
                renderDoc();
              },
            }, 'Discard'),
          ]),
        ])
      );
    }

    report.sections.forEach((section, idx) => {
      const bodyEl = el('div', {
        class: 'sec-body',
        contenteditable: editable ? 'true' : 'false',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': `Section ${section.heading}`,
        spellcheck: 'true',
        dataset: { placeholder: 'Type or dictate this section…' },
      });

      for (const tk of section.tokens) {
        if (tk.t === 'text') bodyEl.append(document.createTextNode(tk.text));
        else if (tk.t === 'heading') bodyEl.append(el('span', { class: 'subhead' }, (tk.prefix || '') + tk.text));
        else if (tk.t === 'field') bodyEl.append(fieldWidget(tk));
      }

      if (editable) {
        bodyEl.addEventListener('input', () => {
          report.sections[idx].tokens = serializeSection(bodyEl);
          report.updatedAt = new Date().toISOString();
          touch();
          queueValidate();
        });
      }

      const hasHard = issues.issues.some((i) => i.section === section.heading && i.severity === 'hard');

      docBody.append(
        el('div', {
          class: 'section-card' + (hasHard ? ' has-error' : ''),
          dataset: { section: idx },
        }, [
          el('div', { class: 'sec-head' }, [
            el('span', { class: 'sec-title', text: section.heading }),
            el('span', { class: 'sec-tools' }, [
              editable
                ? el('button', {
                    class: 'btn btn-ghost',
                    type: 'button',
                    title: 'Restore this section to the template text',
                    onclick: () => {
                      const fresh = buildSections(templateFromTemplate())[idx];
                      if (!fresh) return;
                      report.sections[idx].tokens = fresh.tokens;
                      touch();
                      renderDoc();
                      revalidate();
                      toast('Section reset to template text.');
                    },
                  }, 'Reset')
                : null,
            ]),
          ]),
          bodyEl,
        ])
      );
    });
  }

  function templateFromTemplate() {
    // The stored template still holds the original tokens.
    return { tokens: template.tokens, fields: template.fields };
  }

  /* -------------------------------------------------------------------- sign */

  signBtn.addEventListener('click', async () => {
    if (!issues.canSign) return;
    const unresolvedSoft = issues.issues.filter(
      (i) => i.severity === 'soft' && !(report.acknowledged || []).includes(i.id)
    ).length;
    const answer = await modal({
      title: 'Sign this report?',
      body: [
        el('p', { text: 'Signing records an immutable revision. Later changes create an addendum, not an edit.' }),
        el('dl', { class: 'kv' }, [
          el('dt', { text: 'Report' }), el('dd', { text: report.templateName }),
          el('dt', { text: 'Accession' }), el('dd', { text: report.study.accession || '—' }),
          el('dt', { text: 'Advisories' }), el('dd', { text: `${issues.counts.nudge} non-blocking` }),
          el('dt', { text: 'Unresolved' }), el('dd', { text: `${unresolvedSoft} warnings` }),
        ]),
        el('p', { class: 'hint', text: 'Prototype note: this records a local signature event. A production build must require step-up authentication (WebAuthn) and a server-side signature.' }),
      ],
      actions: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'sign', label: 'Sign', variant: 'primary' },
      ],
    });

    if (answer !== 'sign') return;

    report.state = 'signed';
    report.signedAt = new Date().toISOString();
    report.signedBy = 'local-user';
    clearTimeout(saveTimer);
    await doSave();
    await store.logActivity({
      action: 'report.sign',
      subject: report.id,
      detail: `${report.templateName} · ${report.study.accession || 'no accession'} · ${issues.counts.nudge} advisories`,
    });
    toast('Report signed.');
    renderWorkspace(root, { report, template, onBack });
  });

  /* ------------------------------------------------------------------ export */

  const exportMenu = el('div', { class: 'list-item-actions', style: 'flex-wrap:wrap' });
  const formats = [
    ['txt', 'Text', () => ex.toText(report), 'text/plain'],
    ['html', 'HTML', () => ex.toHTML(report), 'text/html'],
    ['json', 'FHIR JSON', () => JSON.stringify(ex.toFHIR(report), null, 2), 'application/fhir+json'],
    ['pdf', 'PDF', () => ex.toPDF(report), 'application/pdf'],
  ];
  for (const [ext, label, make, mime] of formats) {
    exportMenu.append(
      el('button', {
        class: 'btn',
        type: 'button',
        onclick: () => {
          try {
            const data = make();
            ex.download(ex.safeFilename(report, ext), data, mime);
            store.logActivity({ action: 'report.export', subject: report.id, detail: ext });
            toast(`Exported ${ext.toUpperCase()}.`);
          } catch (err) {
            toast('Export failed: ' + err.message);
          }
        },
      }, label)
    );
  }

  context.insertBefore(
    el('section', {}, [el('h2', { text: 'Export' }), exportMenu]),
    context.querySelector('.sign-bar')
  );

  /* ----------------------------------------------------------------- drawers
   *
   * Below 1024px SECTIONS and below 1280px REVIEW leave the grid and become
   * drawers driven by the two top-bar toggles. A closed drawer is transform-
   * hidden, visibility:hidden and inert, so it leaves the tab order and the
   * accessibility tree instead of merely sitting off-screen.
   */

  const railEl = document.getElementById('rail');
  const ctxEl = document.getElementById('context');
  const scrimEl = document.getElementById('scrim');
  const btnRail = document.getElementById('btn-rail');
  const btnCtx = document.getElementById('btn-context');

  const railMQ = window.matchMedia('(max-width: 1023px)');
  const ctxMQ = window.matchMedia('(max-width: 1279px)');
  let openPanel = null;

  function syncPanels() {
    const railDrawer = railMQ.matches;
    const ctxDrawer = ctxMQ.matches;
    if (!railDrawer && openPanel === 'rail') openPanel = null;
    if (!ctxDrawer && openPanel === 'context') openPanel = null;

    railEl.classList.toggle('is-open', railDrawer && openPanel === 'rail');
    ctxEl.classList.toggle('is-open', ctxDrawer && openPanel === 'context');
    railEl.inert = railDrawer && openPanel !== 'rail';
    ctxEl.inert = ctxDrawer && openPanel !== 'context';

    btnRail.setAttribute('aria-expanded', String(railDrawer && openPanel === 'rail'));
    btnCtx.setAttribute('aria-expanded', String(ctxDrawer && openPanel === 'context'));
    scrimEl.hidden = openPanel === null;
  }

  function togglePanel(name) {
    const isDrawer = name === 'rail' ? railMQ.matches : ctxMQ.matches;
    if (!isDrawer) return;
    openPanel = openPanel === name ? null : name;
    syncPanels();
    if (openPanel) {
      const panel = name === 'rail' ? railEl : ctxEl;
      panel.querySelector('button, a, input, select, textarea')?.focus();
    } else {
      (name === 'rail' ? btnRail : btnCtx).focus();
    }
  }

  function closePanels() {
    if (openPanel === null) return;
    openPanel = null;
    syncPanels();
  }

  btnRail.addEventListener('click', () => togglePanel('rail'));
  btnCtx.addEventListener('click', () => togglePanel('context'));
  scrimEl.addEventListener('click', () => {
    // Return focus to the toggle that opened the drawer rather than dropping it
    // on <body>, which would lose the keyboard position entirely.
    const btn = openPanel === 'rail' ? btnRail : btnCtx;
    closePanels();
    btn?.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !openPanel) return;
    const btn = openPanel === 'rail' ? btnRail : btnCtx;
    closePanels();
    btn.focus();
  });
  railMQ.addEventListener('change', syncPanels);
  ctxMQ.addEventListener('change', syncPanels);
  syncPanels();

  /* -------------------------------------------------------------------- boot */

  buildOutline();
  renderDoc();
  paintMeta();
  revalidate();
  paintStatus();
  if (signed) {
    toast('This report is signed and read-only.');
  }
}
