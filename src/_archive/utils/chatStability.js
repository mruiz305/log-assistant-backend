// src/utils/chatStability.js
const { injectLikeFilter } = require('./dimension');
const { extractPersonNameFromMessage } = require('./personRewrite');

/* =========================
   Intent detection
========================= */
function wantsToChangePerson(message = '') {
  const m = String(message || '').toLowerCase();
  return (
    /\b(cambia|cambiar|switch|change|otra|otro|different|remove|quitar|quita|sin)\b/i.test(m) &&
    /\b(persona|rep|representante|submitter)\b/i.test(m)
  );
}

function wantsToChangeDims(message = '') {
  const m = String(message || '').toLowerCase();
  return (
    /\b(cambia|cambiar|switch|change|otra|otro|different|remove|quitar|quita|sin)\b/i.test(m) &&
    /\b(oficina|office|equipo|team|pod)\b/i.test(m)
  );
}

/* =========================
   Date range injection (stable)
========================= */
function injectDateCameInRange(sql, fromExpr, toExpr) {
  let s = String(sql || '').trim();
  if (!s) return s;
  s = s.replace(/;\s*$/g, '');

  const cond = `dateCameIn >= ${fromExpr} AND dateCameIn < ${toExpr}`;

  // no duplicar
  if (s.toLowerCase().includes(cond.toLowerCase())) return s;

  // insertar antes de GROUP BY / ORDER BY / LIMIT
  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const m = s.match(cutRx);
  const cutAt = m ? m.index : -1;

  const head = cutAt >= 0 ? s.slice(0, cutAt).trimEnd() : s;
  const tail = cutAt >= 0 ? s.slice(cutAt) : '';

  if (/\bwhere\b/i.test(head)) return `${head} AND ${cond}\n${tail}`.trim();
  return `${head}\nWHERE ${cond}\n${tail}`.trim();
}

function ensurePeriodFilterStable(sql = '', message = '') {
  const s = String(sql || '');
  const m = String(message || '').toLowerCase();

  // si ya hay dateCameIn filtrado, no tocar
  const hasDate =
    /\bdateCameIn\b/i.test(s) &&
    (/\bbetween\b/i.test(s) || /dateCameIn\s*>=/i.test(s) || /dateCameIn\s*</i.test(s));
  if (hasDate) return s;

  // mes pasado
  if (/(mes\s+pasado|last\s+month)/i.test(m)) {
    const from = "DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')";
    const to = "DATE_FORMAT(CURDATE(), '%Y-%m-01')";
    return injectDateCameInRange(s, from, to);
  }

  // últimos N días
  const daysMatch = m.match(/\b(ultimos|últimos|last)\s+(\d+)\s+(dias|días|days)\b/i);
  if (daysMatch && daysMatch[2]) {
    const n = Math.max(1, Math.min(365, parseInt(daysMatch[2], 10) || 7));
    const from = `DATE_SUB(CURDATE(), INTERVAL ${n} DAY)`;
    const to = `DATE_ADD(CURDATE(), INTERVAL 1 DAY)`;
    return injectDateCameInRange(s, from, to);
  }

  // este mes default
  const from = "DATE_FORMAT(CURDATE(), '%Y-%m-01')";
  const to = "DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)";
  return injectDateCameInRange(s, from, to);
}

/* =========================
   Lock + apply filters (stable)
========================= */
function getLockedPerson(ctx) {
  const p = ctx?.selectedPerson;
  if (p && p.locked && p.value) return String(p.value).trim();
  return null;
}

function getLockedDims(ctx) {
  return ctx?.selectedDims && typeof ctx.selectedDims === 'object' ? ctx.selectedDims : null;
}

function applyLockedDims(sql, lockedDims) {
  let s = String(sql || '');
  if (!lockedDims) return s;

  // aplica en orden estable
  for (const k of ['office', 'pod', 'team']) {
    const f = lockedDims[k];
    if (f && f.locked && f.column && f.value) {
      s = injectLikeFilter(s, f.column, f.value);
    }
  }
  return s;
}

function applyLockedPerson(sql, personValue) {
  if (!personValue) return sql;
  // usa tu “special submitter” ya definido en injectLikeFilter
  return injectLikeFilter(sql, '__SUBMITTER__', personValue);
}

/**
 * Determina la persona objetivo de forma estable:
 * 1) si hay locked -> esa
 * 2) si el mensaje trae un nombre plausible -> ese
 * 3) si no, null
 */
function getTargetPersonFromMessageOrLock(message, ctx, { allowMessageName = true } = {}) {
  const locked = getLockedPerson(ctx);
  if (locked) return locked;

  if (!allowMessageName) return null;
  const name = extractPersonNameFromMessage(message); // ya existe en personRewrite.js
  if (name && name.length >= 2) return name;

  return null;
}

/**
 * Persiste lock para dims (solo office/pod/team) cuando detectas un dim explícito
 */
function persistDimLock(ctx, dim /* {key,column,value} */) {
  if (!dim || !dim.key || !dim.column || !dim.value) return ctx?.selectedDims || {};
  if (!['office', 'pod', 'team'].includes(dim.key)) return ctx?.selectedDims || {};

  return {
    ...(ctx?.selectedDims || {}),
    [dim.key]: { key: dim.key, column: dim.column, value: dim.value, locked: true },
  };
}

/**
 * Permite “clear locks” si el user pide cambio
 */
function unlockByIntent(ctx, message) {
  const next = { ...(ctx || {}) };

  if (wantsToChangePerson(message)) {
    next.selectedPerson = { ...(next.selectedPerson || {}), locked: false };
  }
  if (wantsToChangeDims(message)) {
    next.selectedDims = {
      ...(next.selectedDims || {}),
      office: { ...(next.selectedDims?.office || {}), locked: false },
      pod: { ...(next.selectedDims?.pod || {}), locked: false },
      team: { ...(next.selectedDims?.team || {}), locked: false },
    };
  }
  return next;
}

module.exports = {
  wantsToChangePerson,
  wantsToChangeDims,
  ensurePeriodFilterStable,
  applyLockedDims,
  applyLockedPerson,
  getTargetPersonFromMessageOrLock,
  persistDimLock,
  unlockByIntent,
};
