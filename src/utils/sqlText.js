
function normalizeBrokenWhere(sql) {
  if (!sql) return sql;
  let s = String(sql).trim();

  s = s.replace(/\bFROM\s+([a-zA-Z0-9_.`]+)\s+AND\b/gi, "FROM $1 WHERE");
  s = s.replace(/\bWHERE\s+AND\b/gi, "WHERE");

  const firstWhereIdx = s.search(/\bWHERE\b/i);
  if (firstWhereIdx >= 0) {
    const head = s.slice(0, firstWhereIdx + 5);
    let tail = s.slice(firstWhereIdx + 5);
    tail = tail.replace(/\bWHERE\b/gi, "AND");
    s = head + tail;
  }

  return s.replace(/\s+/g, " ").trim();
}

function stripFiltersForColumn(sql, column) {
  if (!sql) return sql;
  const col = String(column || "").trim();
  if (!col) return sql;

  let out = String(sql);
  // 1) Patrón principal: WHERE/AND + columna + LIKE o =
  const re = new RegExp(
    String.raw`(\s+\bWHERE\b|\s+\bAND\b)\s+[^;]*?\b(?:LOWER\s*\(\s*TRIM\s*\(\s*)?${col}\b[^;]*?(\bLIKE\b|=)[^;]*?(?=\s+\bAND\b|\s+\bGROUP\s+BY\b|\s+\bORDER\s+BY\b|\s+\bLIMIT\b|;|$)`,
    "gis"
  );
  out = out.replace(re, " ");

  // 2) Fallback: columna = '...' o = "..." (IA suele generar OfficeName = 'X' así)
  const reSimple = new RegExp(
    String.raw`\s+(?:AND|WHERE)\s+${col}\s*=\s*(?:'[^']*'|"[^"]*")(?=\s+AND|\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)`,
    "gis"
  );
  out = out.replace(reSimple, " ");

  out = out
    .replace(/\bWHERE\s+AND\b/gi, "WHERE")
    .replace(/\bFROM\s+([a-zA-Z0-9_.`]+)\s+AND\b/gi, "FROM $1 WHERE")
    .replace(/\bWHERE\s+(GROUP\s+BY|ORDER\s+BY|LIMIT)\b/gi, "$1")
    .replace(/\bWHERE\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return out;
}

module.exports = { normalizeBrokenWhere, stripFiltersForColumn };
