// src/utils/dimension.js
// Centraliza inyección/strip de filtros LIKE para dimensiones (office/team/pod/region/director/attorney/intake/person)
//
// ✅ Objetivos
// - Idempotente: si ya hay filtro para esa columna, lo reemplaza (no duplica)
// - Token-friendly: "Maria, Chacon" => tokens AND (maria AND chacon)
// - Compat: "__SUBMITTER__" para persona (submitterName con fallback submitter)

function norm(s = '') {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

function escapeSqlLiteral(v) {
  return String(v ?? '').replace(/'/g, "''").trim();
}

function escapeRegExp(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const STOPWORDS = new Set([
  'de','del','la','las','los','el','y','e','da','do','dos','das','van','von','the','of','and'
]);

function tokenizeValue(v) {
  const raw = norm(v)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!raw) return [];
  const tokens = raw
    .split(' ')
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => t.length >= 2)
    .filter(t => !STOPWORDS.has(t));

  return (tokens.length ? tokens : raw.split(' ').filter(t => t.length >= 2)).slice(0, 3);
}

function stripLikeFiltersForColumn(sql, column) {
  if (!sql || !column) return sql;
  const s0 = String(sql);
  const col = escapeRegExp(column);

  const andRe = new RegExp(
    String.raw`\s+AND\s+[^;]*?\b${col}\b[^;]*?\bLIKE\b[^;]*?(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)`,
    'gis'
  );

  const whereRe = new RegExp(
    String.raw`\bWHERE\b([^;]*?)\b${col}\b([^;]*?)\bLIKE\b([^;]*?)(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)`,
    'gis'
  );

  let out = s0.replace(andRe, ' ');
  out = out.replace(whereRe, () => 'WHERE ');
  out = out.replace(/\bWHERE\s+AND\b/gi, 'WHERE ');
  out = out.replace(/\bWHERE\s*(GROUP\s+BY|ORDER\s+BY|LIMIT)\b/gi, '$1');
  return out.replace(/\s+/g, ' ').trim();
}

function injectTokensLike(sql = '', column = '', value = '') {
  const s0 = String(sql || '').trim();
  const col = String(column || '').trim();
  const v = norm(value);
  if (!s0 || !col || !v) return s0;

  const tokens = tokenizeValue(v);
  if (!tokens.length) return s0;

  const cond = tokens
    .map((t) => `LOWER(TRIM(${col})) LIKE CONCAT('%', '${escapeSqlLiteral(t)}', '%')`)
    .join(' AND ');

  const s = s0.replace(/;\s*$/g, '');
  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const m = s.match(cutRx);
  const cutAt = m ? m.index : -1;

  const head = cutAt >= 0 ? s.slice(0, cutAt).trimEnd() : s;
  const tail = cutAt >= 0 ? s.slice(cutAt) : '';

  if (/\bwhere\b/i.test(head)) return `${head} AND (${cond}) ${tail}`.trim();
  return `${head} WHERE (${cond}) ${tail}`.trim();
}

function injectTokensLikeSmart(sql, column, value) {
  let out = stripLikeFiltersForColumn(sql, column);
  const v = norm(value);
  if (!v) return out;
  out = injectTokensLike(out, column, v);
  return out.replace(/\s+/g, ' ').trim();
}

// =====================
// Persona (submitterName / submitter)
// =====================
function stripSubmitterFilters(sql) {
  if (!sql) return sql;
  let out = String(sql);

  out = out.replace(
    /\s+AND\s+[^;]*?COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)[^;]*?\bLIKE\b[^;]*?(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/gis,
    ' '
  );

  out = out.replace(
    /\s+AND\s+[^;]*?\bsubmitterName\b[^;]*?\bLIKE\b[^;]*?(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/gis,
    ' '
  );

  out = out.replace(
    /\s+AND\s+[^;]*?\bsubmitter\b[^;]*?\bLIKE\b[^;]*?(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/gis,
    ' '
  );

  return out.replace(/\s+/g, ' ').trim();
}

function injectSubmitterTokensLikeSmart(sql, personValue) {
  const s0 = String(sql || '').trim();
  const name = norm(personValue);
  if (!s0 || !name) return s0;

  const tokens = tokenizeValue(name);
  if (!tokens.length) return s0;

  const cond = tokens
    .map((t) => `LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter))) LIKE CONCAT('%', '${escapeSqlLiteral(t)}', '%')`)
    .join(' AND ');

  const s = s0.replace(/;\s*$/g, '');
  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const m = s.match(cutRx);
  const cutAt = m ? m.index : -1;

  const head = cutAt >= 0 ? s.slice(0, cutAt).trimEnd() : s;
  const tail = cutAt >= 0 ? s.slice(cutAt) : '';

  if (/\bwhere\b/i.test(head)) return `${head} AND (${cond}) ${tail}`.trim();
  return `${head} WHERE (${cond}) ${tail}`.trim();
}

// ✅ compat con chat.route.js
function injectLikeFilterSmart(sql, column, value) {
  const col = String(column || '').trim();
  if (col === '__SUBMITTER__') {
    const cleaned = stripSubmitterFilters(sql);
    return injectSubmitterTokensLikeSmart(cleaned, value);
  }
  return injectTokensLikeSmart(sql, col, value);
}

const stripPersonFilters = stripSubmitterFilters;

module.exports = {
  norm,
  tokenizeValue,

  stripLikeFiltersForColumn,
  injectTokensLike,
  injectTokensLikeSmart,

  stripSubmitterFilters,
  injectSubmitterTokensLikeSmart,

  injectLikeFilterSmart,
  stripPersonFilters,
};
