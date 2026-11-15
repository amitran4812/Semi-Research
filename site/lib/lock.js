// Access code. When the build has a code (the GAPFINDER_ACCESS_CODE secret), every data file is
// encrypted with AES-256-GCM under a key derived from the code (PBKDF2-SHA256), so the published
// files are unreadable without it. A JavaScript-only password check could be skipped; this cannot.
// Works in the browser and in Node 18+ (Web Crypto).

const ITER = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

const b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export const CHECK = "gap-finder-access";

// Key from the code and the site's salt. Exportable so a browser can remember it for the session.
export async function deriveKey(code, salt, iter = ITER) {
  const base = await subtle().importKey("raw", enc.encode(String(code).normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey({ name: "PBKDF2", salt: typeof salt === "string" ? unb64(salt) : salt, iterations: iter, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}
export async function exportKey(key) { return b64(await subtle().exportKey("raw", key)); }
export function importKey(raw) { return subtle().importKey("raw", unb64(raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]); }

export async function seal(key, obj) {
  const iv = rand(12);
  const ct = await subtle().encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj)));
  return { gf_enc: 1, iv: b64(iv), ct: b64(ct) };
}
export async function open(key, box) {
  const pt = await subtle().decrypt({ name: "AES-GCM", iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}
export const isSealed = (j) => !!(j && j.gf_enc === 1 && j.iv && j.ct);

// data/lock.json: the salt, the iteration count and a sealed check value. No code, no key.
export async function newLock(code) {
  const salt = b64(rand(16));
  const key = await deriveKey(code, salt);
  return { lock: { v: 1, salt, iter: ITER, check: await seal(key, CHECK) }, key };
}

// The key if the code is right, otherwise null.
export async function unlock(lock, code) {
  try {
    const key = await deriveKey(code, lock.salt, lock.iter || ITER);
    return (await open(key, lock.check)) === CHECK ? key : null;
  } catch (e) { return null; }
}
