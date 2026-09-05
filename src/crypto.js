export function b64encode(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function getAesKey(env) {
  const raw = b64decode(env.ENCRYPTION_KEY);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptValue(env, plaintext) {
  const key = await getAesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return b64encode(combined.buffer);
}

export async function decryptValue(env, blobB64) {
  const key = await getAesKey(env);
  const combined = b64decode(blobB64);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(env, message) {
  const keyData = new TextEncoder().encode(env.SESSION_SECRET);
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64encode(sig).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSessionCookie(env) {
  const expires = Date.now() + SESSION_MAX_AGE_MS;
  const sig = await hmac(env, String(expires));
  return `ev_session=${expires}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_MS / 1000}`;
}

export function clearSessionCookie() {
  return `ev_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export async function verifySessionCookie(env, cookieHeader) {
  if (!cookieHeader) return false;
  const match = cookieHeader.match(/ev_session=([^;]+)/);
  if (!match) return false;
  const [expiresStr, sig] = match[1].split(".");
  if (!expiresStr || !sig) return false;
  const expected = await hmac(env, expiresStr);
  if (!safeEqual(sig, expected)) return false;
  return Number(expiresStr) > Date.now();
}

export function checkBearer(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return false;
  return safeEqual(m[1], env.API_TOKEN);
}

export async function isAuthed(request, env) {
  if (checkBearer(request, env)) return true;
  return verifySessionCookie(env, request.headers.get("Cookie"));
}
