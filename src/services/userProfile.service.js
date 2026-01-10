/* =========================================================
   userProfile.service.js
   - Memoria en proceso: clientId => { name, updatedAt }
   - Extrae nombre desde frases tipo "me llamo X", "soy X", "my name is X"
   - No usa BD (ideal para chat libre)
========================================================= */

const store = new Map();

// Ajusta si quieres más/menos retención
const TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 días

function nowMs() {
  return Date.now();
}

function cleanup() {
  const t = nowMs();
  for (const [key, v] of store.entries()) {
    if (!v?.updatedAt || t - v.updatedAt > TTL_MS) store.delete(key);
  }
}

// Limpieza simple (barata)
function maybeCleanup() {
  if (store.size > 500) cleanup();
}

function normalizeText(s = '') {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function cleanName(name = '') {
  let n = String(name || '').trim();

  // corta basura típica
  n = n
    .replace(/[“”"']/g, '')
    .replace(/\b(please|por favor|pls)\b/gi, '')
    .replace(/\b(thanks|gracias)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // limita longitud razonable
  if (n.length > 40) n = n.slice(0, 40).trim();

  // solo letras/números/espacios/guiones
  n = n.replace(/[^\p{L}\p{N}\s-]/gu, '').trim();

  // evita nombres vacíos
  if (n.length < 2) return null;

  return n;
}

/**
 * Intenta extraer nombre del mensaje del usuario.
 * Devuelve string o null.
 */
function extractUserNameFromMessage(message = '') {
  const q = normalizeText(message);

  // ES: "me llamo X", "mi nombre es X", "soy X"
  let m =
    q.match(/\bme\s+llamo\s+([a-z0-9][a-z0-9\s-]{1,40})\b/i) ||
    q.match(/\bmi\s+nombre\s+es\s+([a-z0-9][a-z0-9\s-]{1,40})\b/i) ||
    q.match(/\bsoy\s+([a-z0-9][a-z0-9\s-]{1,40})\b/i);

  if (m && m[1]) return cleanName(m[1]);

  // EN: "my name is X", "i am X", "i'm X"
  m =
    q.match(/\bmy\s+name\s+is\s+([a-z0-9][a-z0-9\s-]{1,40})\b/i) ||
    q.match(/\bi\s+am\s+([a-z0-9][a-z0-9\s-]{1,40})\b/i) ||
    q.match(/\bi'?m\s+([a-z0-9][a-z0-9\s-]{1,40})\b/i);

  if (m && m[1]) return cleanName(m[1]);

  return null;
}

function setUserName(clientId, name) {
  const cid = String(clientId || '').trim();
  const n = cleanName(name);
  if (!cid || !n) return false;

  maybeCleanup();
  store.set(cid, { name: n, updatedAt: nowMs() });
  return true;
}

function getUserName(clientId) {
  const cid = String(clientId || '').trim();
  if (!cid) return null;

  const v = store.get(cid);
  if (!v) return null;

  // TTL
  if (nowMs() - v.updatedAt > TTL_MS) {
    store.delete(cid);
    return null;
  }

  return v.name || null;
}

module.exports = {
  extractUserNameFromMessage,
  setUserName,
  getUserName,
};
