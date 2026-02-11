
/* ============================================================
   FIX: Reglas Dropped/Problem SIEMPRE por Status LIKE
   (por si el modelo insiste en leadStatus)
   ============================================================ */
function enforceStatusRules(sql) {
  if (!sql || typeof sql !== 'string') return sql;

  let out = sql;

  // leadStatus = 'Dropped'  => Status LIKE '%DROP%'
  out = out.replace(/leadStatus\s*=\s*'Dropped'/gi, "Status LIKE '%DROP%'");
  out = out.replace(/leadStatus\s+LIKE\s+'%Dropped%'/gi, "Status LIKE '%DROP%'");

  // Status = 'Dropped' => Status LIKE '%DROP%'
  out = out.replace(/Status\s*=\s*'Dropped'/gi, "Status LIKE '%DROP%'");
  out = out.replace(/Status\s+LIKE\s+'%Dropped%'/gi, "Status LIKE '%DROP%'");

  return out;
}

function enforceOnlyFullGroupBy(sql) {
  if (!sql || typeof sql !== 'string') return sql;

  const s = sql;

  // ya tiene GROUP BY, no tocar
  if (/group\s+by/i.test(s)) return s;

  // si no hay agregados, no tocar
  const hasAgg = /(count\s*\(|sum\s*\(|avg\s*\(|min\s*\(|max\s*\()/i.test(s);
  if (!hasAgg) return s;

  // detecta YEAR/MONTH en SELECT (caso típico)
  const hasYear = /year\s*\(\s*dateCameIn\s*\)/i.test(s);
  const hasMonth = /month\s*\(\s*dateCameIn\s*\)/i.test(s);

  if (hasYear && hasMonth) {
    // Inserta GROUP BY antes de ORDER BY / LIMIT / ;
    if (/order\s+by/i.test(s)) {
      return s.replace(/order\s+by/i, `GROUP BY YEAR(dateCameIn), MONTH(dateCameIn)\nORDER BY`);
    }
    if (/limit\s+\d+/i.test(s)) {
      return s.replace(/limit\s+\d+/i, `GROUP BY YEAR(dateCameIn), MONTH(dateCameIn)\nLIMIT`);
    }
    // si no hay ORDER BY ni LIMIT
    return s.replace(/;?\s*$/i, `\nGROUP BY YEAR(dateCameIn), MONTH(dateCameIn);`);
  }

  return s;
}

module.exports = { enforceStatusRules,enforceOnlyFullGroupBy };
