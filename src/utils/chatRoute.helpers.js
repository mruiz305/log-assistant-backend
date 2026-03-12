// src/utils/chatRoute.helpers.js

function makeReqId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function shouldLogSql(req) {
  const debug = req.query?.debug === '1' || req.body?.debug === true;
  const env = (process.env.LOG_SQL || '').toLowerCase() === 'true';
  return debug || env;
}

function logSql(reqId, label, sql, params) {
  console.log(`\n[sql][${reqId}] ${label}`);
  console.log(sql);
  if (params && Array.isArray(params) && params.length) {
    console.log(`[sql][${reqId}] params:`, params);
  }
}

function clean(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

function same(a, b) {
  return clean(a).toLowerCase() === clean(b).toLowerCase();
}

// evita “de maria …” / “del …”
function stripLeadingDe(s) {
  return clean(s).replace(/^(de|del)\s+/i, '').trim();
}

const NAME_STOPWORDS = new Set([
  'de', 'del', 'la', 'las', 'los', 'el',
  'y', 'e',
  'da', 'do', 'dos', 'das',
  'van', 'von',
]);

function tokenizePersonName(name) {
  const raw = stripLeadingDe(name).toLowerCase();
  let tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]+/gu, ''))
    .filter(Boolean);

  const filtered = tokens.filter((t) => !NAME_STOPWORDS.has(t) && t.length >= 2);
  const finalTokens = (filtered.length ? filtered : tokens.filter((t) => t.length >= 2));
  return finalTokens.slice(0, 3);
}

function sanitizeSqlTypos(sql = '') {
  let s = String(sql || '');
  s = s.replace(/\bdateCameIn'\b/g, 'dateCameIn');
  s = s.replace(/\(\s*dateCameIn'\s*\)/g, '(dateCameIn)');
  return s;
}

/* =========================
   Period injection (stable)
========================= */
function injectDateCameInRange(sql, fromExpr, toExpr) {
  let s = String(sql || '').trim();
  if (!s) return s;

  s = s.replace(/;\s*$/g, '');

  const cond = `dateCameIn >= ${fromExpr} AND dateCameIn < ${toExpr}`;
  if (s.toLowerCase().includes(cond.toLowerCase())) return s;

  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const m = s.match(cutRx);
  const cutAt = m ? m.index : -1;

  const head = cutAt >= 0 ? s.slice(0, cutAt).trimEnd() : s;
  const tail = cutAt >= 0 ? s.slice(cutAt) : '';

  if (/\bwhere\b/i.test(head)) return `${head} AND ${cond}\n${tail}`.trim();
  return `${head}\nWHERE ${cond}\n${tail}`.trim();
}

function ensurePeriodFilterStable(sql = '', msg = '') {
  const s = String(sql || '');
  const m = String(msg || '').toLowerCase();

  const hasDateFilter =
    /\bdateCameIn\b/i.test(s) &&
    (/\bbetween\b/i.test(s) || /dateCameIn\s*>=/i.test(s) || /dateCameIn\s*</i.test(s));

  if (hasDateFilter) return s;

  if (/(mes\s+pasado|last\s+month)/i.test(m)) {
    const from = "DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')";
    const to = "DATE_FORMAT(CURDATE(), '%Y-%m-01')";
    return injectDateCameInRange(s, from, to);
  }

  // default: este mes
  const from = "DATE_FORMAT(CURDATE(), '%Y-%m-01')";
  const to = "DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)";
  return injectDateCameInRange(s, from, to);
}

/* =========================
   ONLY_FULL_GROUP_BY patch
========================= */
function ensureYearMonthGroupBy(sql = '') {
  const s = String(sql || '');
  const hasAgg = /\b(count|sum|avg|min|max)\s*\(/i.test(s);
  const hasYearMonth =
    /\bYEAR\s*\(\s*dateCameIn\s*\)/i.test(s) ||
    /\bMONTH\s*\(\s*dateCameIn\s*\)/i.test(s);

  const hasGroupBy = /\bGROUP\s+BY\b/i.test(s);

  if (hasAgg && hasYearMonth && !hasGroupBy) {
    return `${s.trim()} GROUP BY YEAR(dateCameIn), MONTH(dateCameIn)`;
  }
  return s;
}

/* =========================
   UX helpers
========================= */
function isGreeting(msg = '') {
  const m = String(msg || '').trim().toLowerCase();
  return /^(hola|hello|hi|buenas|buenos dias|buenas tardes|buenas noches)\b/.test(m);
}

function greetingAnswer(lang, userName) {
  const n = userName ? `, ${userName}` : '';
  if (lang === 'es') {
    return (
      `Hola${n} 👋 Soy Nexus.\n` +
      `¿Qué quieres revisar hoy?\n\n` +
      `Ejemplos: Confirmados (mes) · Dropped últimos 7 días por oficina · Dame los logs de Maria Chacon`
    );
  }
  return (
    `Hi${n} 👋 I’m Nexus.\n` +
    `What do you want to review today?\n\n` +
    `Examples: Confirmed (month) · Dropped last 7 days by office · Give me logs for Maria Chacon`
  );
}

/* =========================
   Follow-up context
========================= */
function isFollowUpQuestion(msg = '', uiLang = 'en') {
  const m = String(msg || '').toLowerCase().trim();
  const es = /(y\s+el\s+mes\s+pasado|mes\s+pasado|y\s+ayer|y\s+hoy|y\s+esta\s+semana|y\s+la\s+semana\s+pasada|y\s+en\s+los\s+últimos\s+\d+\s+d[ií]as)\b/;
  const en = /(and\s+last\s+month|last\s+month|and\s+yesterday|today|this\s+week|last\s+week|last\s+\d+\s+days)\b/;
  return uiLang === 'es' ? es.test(m) : en.test(m);
}

function injectPersonFromContext(msg, uiLang, lastPerson) {
  if (!lastPerson) return msg;
  if (uiLang === 'es') return `${msg} de ${lastPerson}`;
  return `${msg} for ${lastPerson}`;
}

function mentionsPersonExplicitly(msg = "", uiLang = "en") {
  const m = String(msg || "");

  // Lo que ya tenías (de X / for X / keywords)
  const base =
    /(submittername|submitter|representante|rep|\bde\s+[\p{L}\p{N}]+|\bfor\s+[\p{L}\p{N}]+)/iu.test(m);

  if (base) return true;

  // ✅ "how many cases/logs did Maria Chacon ..."
  const howManyDidEn =
    /\bhow\s+many\s+(?:cases|logs)\s+did\s+(.{2,60}?)(?=\s+\b(in|on|during|for)\b|[?.!,;:]|$)/i;

  // ✅ "cuántos casos/logs hizo Maria Chacon ..."
  const howManyDidEs =
    /\bcu[aá]ntos?\s+(?:casos|logs)\s+(?:hizo|hace|realiz[oó])\s+(.{2,60}?)(?=\s+\b(en|durante|para)\b|[?.!,;:]|$)/i;

  // ✅ NUEVO: "how many dropped/confirmed/active Mariel has ..."
  // Captura "Mariel" como señal de persona.
  const howManyMetricHasEn =
    /\bhow\s+many\s+(?:dropped|drop|confirmed|active|problem|refer(?:\s*out)?)\s+(.{2,60}?)(?=\s+\b(has|have)\b|\s+\b(in|on|during|for)\b|[?.!,;:]|$)/i;

  // ✅ NUEVO: "cuántos dropped/confirmados/activos ... tiene ..."
  const howManyMetricHasEs =
    /\bcu[aá]ntos?\s+(?:dropped|drop|confirmados?|activos?|problemas?|referidos?)\s+(.{2,60}?)(?=\s+\b(tiene|tienen)\b|\s+\b(en|durante|para)\b|[?.!,;:]|$)/i;

  // ✅ "how is X doing" / "how is X performing" - entidad explícita que debe reemplazar la anterior
  const howIsDoing = /\bhow\s+is\s+.+?\s+(?:doing|performing)\b/i;
  const comoEsta = /\bc[oó]mo\s+est[aá]\s+.+?(?:\s+(?:haciendo|rindiendo|performando))?\b/i;

  // Si no quieres depender de uiLang, evaluamos todos siempre:
  return (
    howManyDidEn.test(m) ||
    howManyDidEs.test(m) ||
    howManyMetricHasEn.test(m) ||
    howManyMetricHasEs.test(m) ||
    howIsDoing.test(m) ||
    comoEsta.test(m)
  );
}

/**
 * Returns true if the previously resolved entity (lockedResolved) is compatible
 * with the short name extracted from the current message (extracted).
 * Used to avoid re-asking for entity selection when the user refers to the same
 * person (e.g. "Tony" → "Tony Press Accidente Inc").
 */
function isResolvedEntityReusable(extracted, lockedResolved) {
  const ex = String(extracted || "").trim().toLowerCase();
  const locked = String(lockedResolved || "").trim();
  if (!ex || !locked) return false;
  const lockedLower = locked.toLowerCase();
  if (lockedLower === ex) return true;
  const firstToken = locked.split(/\s+/)[0]?.toLowerCase() || "";
  if (firstToken === ex) return true;
  if (lockedLower.startsWith(ex + " ") || lockedLower.startsWith(ex + "-")) return true;
  return false;
}

module.exports = {
  makeReqId,
  shouldLogSql,
  logSql,
  clean,
  same,
  stripLeadingDe,
  tokenizePersonName,
  sanitizeSqlTypos,
  ensurePeriodFilterStable,
  ensureYearMonthGroupBy,
  isGreeting,
  greetingAnswer,
  isFollowUpQuestion,
  injectPersonFromContext,
  mentionsPersonExplicitly,
  isResolvedEntityReusable,
};
