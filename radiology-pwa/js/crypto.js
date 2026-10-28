/**
 * Local at-rest encryption for drafts.
 *
 * Honest scope: the key is derived from a passphrase the clinician sets, via
 * PBKDF2-SHA256. Without a passphrase drafts are stored unencrypted and the UI
 * says so. A production build must additionally bind the key to a device
 * secret / OS keystore and require step-up auth to unlock — see README.
 */

const SUBTLE = globalThis.crypto?.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const SALT_KEY = 'rpwa.salt';
const ITERATIONS = 150_000;

let activeKey = null;

export const cryptoAvailable = Boolean(SUBTLE);

export function isUnlocked() {
  return activeKey !== null;
}

export function hasPassphrase() {
  return Boolean(localStorage.getItem(SALT_KEY));
}

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(str) {
  const raw = atob(str);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function getSalt() {
  let salt = localStorage.getItem(SALT_KEY);
  if (!salt) {
    salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    localStorage.setItem(SALT_KEY, salt);
  }
  return unb64(salt);
}

async function deriveKey(passphrase) {
  const base = await SUBTLE.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return SUBTLE.deriveKey(
    { name: 'PBKDF2', salt: getSalt(), iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable: the raw key never reaches JS
    ['encrypt', 'decrypt']
  );
}

/** Sets the passphrase and derives the session key. Throws if crypto is unavailable. */
export async function setPassphrase(passphrase) {
  if (!cryptoAvailable) throw new Error('Web Crypto is not available in this context (needs a secure origin).');
  if (!passphrase || passphrase.length < 6) throw new Error('Use at least 6 characters.');
  activeKey = await deriveKey(passphrase);
  // A known-plaintext probe lets unlock() verify the passphrase without storing it.
  localStorage.setItem('rpwa.probe', JSON.stringify(await encryptWith(activeKey, { v: 1 })));
  return true;
}

/** Re-derives the key from an existing passphrase. Returns false on wrong passphrase. */
export async function unlock(passphrase) {
  if (!cryptoAvailable || !hasPassphrase()) return false;
  const candidate = await deriveKey(passphrase);
  // Verify against a known ciphertext rather than storing a hash of the passphrase.
  const probe = localStorage.getItem('rpwa.probe');
  if (probe) {
    try {
      await decryptWith(candidate, JSON.parse(probe));
    } catch {
      return false;
    }
  } else {
    const sealed = await encryptWith(candidate, { v: 1 });
    localStorage.setItem('rpwa.probe', JSON.stringify(sealed));
  }
  activeKey = candidate;
  return true;
}

export function lock() {
  activeKey = null;
}

export async function encryptWith(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await SUBTLE.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
}

export async function decryptWith(key, payload) {
  const pt = await SUBTLE.decrypt(
    { name: 'AES-GCM', iv: unb64(payload.iv) },
    key,
    unb64(payload.ct)
  );
  return JSON.parse(dec.decode(pt));
}

/** Encrypts with the session key. Returns null when locked (caller stores plaintext). */
export async function seal(obj) {
  if (!activeKey) return null;
  return encryptWith(activeKey, obj);
}

export async function open(payload) {
  if (!activeKey) throw new Error('locked');
  return decryptWith(activeKey, payload);
}

export function wipeKeys() {
  activeKey = null;
  localStorage.removeItem('rpwa.salt');
  localStorage.removeItem('rpwa.probe');
}
