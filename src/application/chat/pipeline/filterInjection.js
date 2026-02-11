// src/application/chat/pipeline/filterInjection.js
//
// Inyección de filtros LOCKED usando LIKE + parámetros, de forma idempotente.
// - Para dimensiones normales: LOWER(TRIM(col)) LIKE %token% AND ...
// - Para PERSON: usa COALESCE(NULLIF(submitterName,''), submitter) para fallback (datos sucios)
// - Evita duplicar filtros existentes con stripFiltersForColumn()
// - Normaliza WHERE roto al final
//
const { tokenizePersonName } = require("../../../utils/chatRoute.helpers");
const { stripFiltersForColumn, normalizeBrokenWhere } = require("../../../utils/sqlText");

function stripSubmitterCoalesceLike(sql) {
  if (!sql) return sql;
  let out = String(sql);

  const rx = [
    // AND (coalesce...) LIKE ...
    /\s+AND\s+[^;]*?COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)[^;]*?\bLIKE\b[^;]*?(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/gis,

    // WHERE (coalesce...) LIKE ...
    /\bWHERE\b\s+[^;]*?COALESCE\s*\(\s*NULLIF\s*\(\s*submitterName\s*,\s*''\s*\)\s*,\s*submitter\s*\)[^;]*?\bLIKE\b[^;]*?(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/gis,
  ];

  for (const r of rx) {
    out = out.replace(r, (m) => (m.toUpperCase().startsWith("WHERE") ? "WHERE " : " "));
  }

  return out
    .replace(/\bWHERE\s+AND\b/gi, "WHERE ")
    .replace(/\bWHERE\s*(GROUP\s+BY|ORDER\s+BY|LIMIT)\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}


function injectWhere(baseSql, condition, params) {
  const cutRx = /\b(group\s+by|order\s+by|limit)\b/i;
  const mm = baseSql.match(cutRx);
  const cutAt = mm ? mm.index : -1;

  const head = cutAt >= 0 ? baseSql.slice(0, cutAt).trimEnd() : baseSql;
  const tail = cutAt >= 0 ? baseSql.slice(cutAt) : "";

  const withWhere = /\bwhere\b/i.test(head)
    ? `${head} AND ${condition} ${tail}`.trim()
    : `${head} WHERE ${condition} ${tail}`.trim();

  return { sql: withWhere, params };
}

function cleanTokens(tokens = []) {
  return tokens
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .filter((t) => t.length >= 2);
}

function injectColumnTokensLike(sql, column, rawValue, opts = {}) {
  const s0 = String(sql || "").trim().replace(/;\s*$/g, "");
  const col = String(column || "").trim();
  const value = String(rawValue || "").trim();
  const exact = Boolean(opts.exact);

  if (!s0 || !col || !value) return { sql: s0, params: [] };

  const tokens = exact
    ? [value]
    : cleanTokens(
        tokenizePersonName(value)
          .filter((t) => !/(accident|accidente|case|caso|lead|cliente|client|paciente)/i.test(t))
          .slice(0, 6)
      );

  if (!tokens.length) return { sql: s0, params: [] };

  const expr = `LOWER(TRIM(${col}))`;
  const likeConds = tokens
    .map(() => `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`)
    .join(" AND ");

  return injectWhere(s0, `(${likeConds})`, tokens);
}

// =====================
// PERSONA (submitterName con fallback submitter)
// =====================
function injectSubmitterTokensLike(sql, personValue, opts = {}) {
   let s0 = String(sql || "").trim().replace(/;\s*$/g, "");

  s0 = stripSubmitterCoalesceLike(s0);

  const name = String(personValue || "").trim();
  const exact = Boolean(opts.exact);

  if (!s0 || !name) return { sql: s0, params: [] };

  // ✅ fallback robusto (igual que utils/dimension.js)
  const expr = "LOWER(TRIM(COALESCE(NULLIF(submitterName,''), submitter)))";

  if (exact) {
    const cond = `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`;
    return injectWhere(s0, cond, [name]);
  }

  const tokens = cleanTokens(
    tokenizePersonName(name)
      .map((t) => t.toLowerCase().trim())
      .slice(0, 3)
  );

  // si hay pocos tokens, usa el string completo
  if (tokens.length < 2) {
    const cond = `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`;
    return injectWhere(s0, cond, [name]);
  }

  // ✅ AND directo (más estable que OR invertido)
  const likeConds = tokens
    .map(() => `${expr} LIKE CONCAT('%', LOWER(TRIM(?)), '%')`)
    .join(" AND ");

  return injectWhere(s0, `(${likeConds})`, tokens);
}

function applyLockedFiltersParam({ baseSql, filters, personValueFinal, listDimensions }) {
  let outSql = String(baseSql || "");
  let params = [];

  // dims (menos person)
  for (const d of listDimensions()) {
    if (d.key === "person") continue;

    const lock = filters?.[d.key];
    if (!lock?.locked || !lock?.value) continue;

    // ✅ idempotente: quita el filtro anterior de esa columna
    outSql = stripFiltersForColumn(outSql, d.column);

    const inj = injectColumnTokensLike(outSql, d.column, String(lock.value), {
      exact: Boolean(lock.exact),
    });

    outSql = inj.sql;
    params = params.concat(inj.params);
  }

  // person (submitter)
  if (personValueFinal) {
    // NOTE: stripFiltersForColumn NO aplica a person porque person no es una columna real,
    // es una expresión. Si quieres, podemos añadir stripSubmitterFilters() en sqlText.
    const inj = injectSubmitterTokensLike(outSql, personValueFinal, {
      exact: Boolean(filters?.person?.exact),
    });

    outSql = inj.sql;
    params = params.concat(inj.params);
  }

  outSql = normalizeBrokenWhere(outSql);

  return { sql: outSql, params };
}

module.exports = {
  injectColumnTokensLike,
  injectSubmitterTokensLike,
  applyLockedFiltersParam,
};
