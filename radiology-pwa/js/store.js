/**
 * Persistence layer.
 *
 * Two independent stores, on purpose:
 *   drafts  - the recoverable document (survives device loss once a server exists)
 *   journal - append-only crash log, written first and cheaply (survives tab crash)
 *
 * Draft bodies are encrypted when a passphrase is set. List metadata (title,
 * template name, timestamps) stays readable so the drafts screen works while
 * locked; it contains no patient identifiers.
 */

import * as vault from './crypto.js';

const DB_NAME = 'alem-reporting';
const DB_VERSION = 1;
const JOURNAL_LIMIT = 50;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('journal')) {
        const s = db.createObjectStore('journal', { keyPath: 'seq', autoIncrement: true });
        s.createIndex('reportId', 'reportId');
      }
      if (!db.objectStoreNames.contains('activity')) {
        const s = db.createObjectStore('activity', { keyPath: 'seq', autoIncrement: true });
        s.createIndex('at', 'at');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, mode);
        const store = transaction.objectStore(storeName);
        let result;
        try {
          result = fn(store);
        } catch (err) {
          reject(err);
          return;
        }
        transaction.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      })
  );
}

const req = (r) => ({ __req: r });

/* ------------------------------------------------------------------ drafts */

export async function saveDraft(report) {
  const meta = {
    id: report.id,
    title: report.templateName,
    templateId: report.templateId,
    modality: report.modality,
    accession: report.study?.accession || '',
    state: report.state,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt,
  };

  let record;
  if (vault.isUnlocked()) {
    record = { ...meta, enc: true, payload: await vault.seal(report) };
  } else {
    record = { ...meta, enc: false, report };
  }

  await tx('drafts', 'readwrite', (s) => s.put(record));
  return true;
}

export async function getDraft(id) {
  const record = await tx('drafts', 'readonly', (s) => req(s.get(id)));
  if (!record) return null;
  if (!record.enc) return record.report;
  if (!vault.isUnlocked()) {
    const err = new Error('This draft is encrypted. Unlock with your passphrase to open it.');
    err.code = 'LOCKED';
    throw err;
  }
  return vault.open(record.payload);
}

export async function listDrafts() {
  const all = await tx('drafts', 'readonly', (s) => req(s.getAll()));
  return (all || [])
    .map((r) => ({
      id: r.id,
      title: r.title,
      modality: r.modality,
      accession: r.accession,
      state: r.state,
      updatedAt: r.updatedAt,
      createdAt: r.createdAt,
      encrypted: Boolean(r.enc),
      locked: Boolean(r.enc) && !vault.isUnlocked(),
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function deleteDraft(id) {
  await tx('journal', 'readwrite', (s) => {
    const idx = s.index('reportId');
    const cursorReq = idx.openCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  });
  return tx('drafts', 'readwrite', (s) => s.delete(id));
}

/* ----------------------------------------------------------------- journal */

export async function appendJournal(entry) {
  await tx('journal', 'readwrite', (s) =>
    s.add({ ...entry, at: new Date().toISOString() })
  );
  // Trim to a rolling window so local storage cannot grow without bound.
  const all = await tx('journal', 'readonly', (s) => req(s.getAll()));
  if (all && all.length > JOURNAL_LIMIT) {
    const excess = all.slice(0, all.length - JOURNAL_LIMIT);
    await tx('journal', 'readwrite', (s) => {
      for (const e of excess) s.delete(e.seq);
    });
  }
}

export async function journalFor(reportId) {
  const all = await tx('journal', 'readonly', (s) => req(s.getAll()));
  return (all || []).filter((e) => e.reportId === reportId);
}

export async function latestJournal(reportId) {
  const entries = await journalFor(reportId);
  return entries.length ? entries[entries.length - 1] : null;
}

/* ---------------------------------------------------------------- activity */

export async function logActivity(event) {
  const record = {
    at: new Date().toISOString(),
    action: event.action,
    subject: event.subject || '',
    detail: event.detail || '',
  };
  try {
    await tx('activity', 'readwrite', (s) => s.add(record));
  } catch {
    /* activity logging must never break the editing flow */
  }
  return record;
}

export async function listActivity(limit = 200) {
  const all = await tx('activity', 'readonly', (s) => req(s.getAll()));
  return (all || []).slice(-limit).reverse();
}

/* -------------------------------------------------------------------- meta */

export async function getMeta(k, fallback = null) {
  const row = await tx('meta', 'readonly', (s) => req(s.get(k)));
  return row ? row.v : fallback;
}

export async function setMeta(k, v) {
  return tx('meta', 'readwrite', (s) => s.put({ k, v }));
}

/* --------------------------------------------------------------- wipe (PHI) */

export async function wipeAll() {
  for (const name of ['drafts', 'journal', 'activity']) {
    await tx(name, 'readwrite', (s) => s.clear());
  }
}

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null;
  const est = await navigator.storage.estimate();
  return { usage: est.usage || 0, quota: est.quota || 0 };
}
