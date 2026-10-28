/** Small DOM helpers shared by the views. */

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastTimer = null;
export function toast(message, ms = 2600) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, ms);
}

/**
 * Modal dialog with focus trap and Escape handling.
 * Returns a promise resolving to the id of the clicked action button.
 */
export function modal({ title, body, actions = [], dismissible = true }) {
  const root = document.getElementById('modal-root');
  const previous = document.activeElement;

  const close = (value) => {
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (previous && previous.focus) previous.focus();
    resolve(value);
  };

  let resolve;
  const done = new Promise((r) => {
    resolve = r;
  });

  const buttons = actions.map((a) =>
    el('button', {
      class: `btn ${a.variant === 'primary' ? 'btn-primary' : a.variant === 'danger' ? 'btn-danger' : ''}`,
      type: 'button',
      onclick: () => close(a.id),
    }, a.label)
  );

  const dialog = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
    el('h2', { text: title }),
    ...[].concat(body || []),
    el('div', { class: 'modal-actions' }, buttons),
  ]);

  const backdrop = el('div', { class: 'modal-backdrop' }, [dialog]);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop && dismissible) close(null);
  });

  function onKey(e) {
    if (e.key === 'Escape' && dismissible) {
      e.preventDefault();
      close(null);
    }
    if (e.key === 'Tab') {
      const focusables = dialog.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    }
  }

  document.addEventListener('keydown', onKey, true);
  root.append(backdrop);
  const focusTarget = dialog.querySelector('input, select, textarea') || buttons[0] || dialog;
  focusTarget.focus();
  return done;
}

export function relTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function clockTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
