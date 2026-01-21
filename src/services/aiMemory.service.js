const { admin } = require('../infra/firebaseAdmin');

const DEFAULT_MEMORY = {
  preferredLang: null,          // 'es' | 'en'
  defaultWindow: 'this_month',  // 'this_month' | 'last_7_days' | 'last_30_days'
  verbosity: 'short',           // 'short' | 'normal'
  followupOrder: ['confirmed', 'dropped', 'by_period'],
  frequentReps: [],
};

function normalizeUserMemory(mem) {
  const m = mem && typeof mem === 'object' ? mem : {};

  const preferredLang =
    m.preferredLang === 'es' || m.preferredLang === 'en' ? m.preferredLang : null;

  const allowedWindows = new Set(['this_month', 'last_7_days', 'last_30_days']);
  const defaultWindow = allowedWindows.has(m.defaultWindow) ? m.defaultWindow : DEFAULT_MEMORY.defaultWindow;

  const verbosity = m.verbosity === 'normal' ? 'normal' : 'short';

  const followupOrder = Array.isArray(m.followupOrder) ? m.followupOrder.slice(0, 6) : DEFAULT_MEMORY.followupOrder;

  const frequentReps = Array.isArray(m.frequentReps)
    ? m.frequentReps.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
    : [];

  return {
    ...DEFAULT_MEMORY,
    preferredLang,
    defaultWindow,
    verbosity,
    followupOrder,
    frequentReps,
  };
}

async function getUserMemory(uid) {
  try {
    const _uid = String(uid || '').trim();
    if (!_uid) return normalizeUserMemory(null);

    const db = admin.firestore();
    const ref = db.doc(`users/${_uid}/ai_profile/memory`);
    const snap = await ref.get();

    if (!snap.exists) return normalizeUserMemory(null);

    return normalizeUserMemory(snap.data() || {});
  } catch (e) {
    // Si Firestore falla, no rompemos el chat
    return normalizeUserMemory(null);
  }
}

module.exports = { getUserMemory, normalizeUserMemory };
